import { compareGroups, makeDay, unpublished, type MinuteSlot } from '../schedule.js'
import { readChannelWindow } from '../emergency/telegram.js'
import { addDays, kyivDate, kyivInstant, kyivMinuteOfDay, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, RegionId, RegionSchedule } from '../types.js'
import type { ProviderContext } from './provider.js'
import type { SourceRead } from './sources.js'
import { OutageError } from '../errors.js'
import { findUaDate, findUaDates, parseGroupPost } from './ua-text.js'

/**
 * Operators that publish each day's schedule as a news post ("ГПВ на 6 листопада":
 * "1.1 00:00-03:00; 08:00-13:30"). Corrections arrive as newer posts for the same date.
 */
export interface SchedulePost {
  title: string
  /** HTML or text */
  body: string
  /** When the post was published or last edited, ISO */
  publishedAt: string
}

export interface PostsOptions {
  /**
   * What a group missing from a day's post means. 'unknown' (default): the post didn't say.
   * 'none': the operator lists only the groups that have outages, so it has none that day.
   */
  omitted?: 'unknown' | 'none'
  /** Groups the region always has; with `omitted: 'none'` they all get a day, listed or not */
  groups?: readonly string[]
  /**
   * How a newer post for the same date is applied. 'replace' (default): it is the whole day.
   * 'layer': operators whose updates list only the hours still ahead ("оновлено з 15:00":
   * the morning's outages are gone from the text); see `layerPublications`.
   */
  updates?: 'replace' | 'layer'
  /**
   * With `updates: 'layer'`: the minute of `date` from which the post replaces what was
   * published before, when its text says so ("оновлено з 15:00"); 0 = the whole day. Without
   * it, or when it returns undefined: the post's `publishedAt` when that falls on the day the
   * post is about, otherwise 0 (published the evening before: the whole day).
   */
  effectiveFrom?: (post: SchedulePost, date: string) => number | undefined
}

/** One publication about one day */
export interface Publication {
  /** group → off slots; `null` = named without times; a missing group wasn't listed */
  groups: Record<string, MinuteSlot[] | null>
  /** Minute of the day from which it replaces older publications; 0 = the whole day */
  from: number
  /** The operator cancelled the day's schedule; `groups` is empty */
  cancelled?: boolean
}

/**
 * Applies a day's publications, oldest first, the way the operator means them: a publication
 * made before the day (or `from: 0`) is the whole day; one made during the day keeps what was
 * published for the hours before `from` and replaces the rest, because such updates list only
 * what is still ahead. So for each group of an update:
 *
 * - listed with times: the earlier slots cut at `from`, plus the listed ones (an outage in
 *   progress is listed from its start, the two merge);
 * - not listed, with `omitted: 'none'` (the operator lists only the groups that have outages):
 *   the earlier slots cut at `from` (nothing more today); a group whose earlier schedule isn't
 *   known stays as it was;
 * - not listed, with `omitted: 'unknown'` (the operator lists every group, so this update is
 *   about some of them only): what the group had stays when all of it is over by `from`;
 *   otherwise the rest of its day is not known (`null`), neither kept nor dropped;
 * - named without times: `null`.
 *
 * A cancellation leaves every group `null` (not known) until a newer publication: the day is
 * neither the old schedule nor "no outages" on the strength of one sentence.
 */
export function layerPublications(
  pubs: readonly Publication[],
  omitted: 'unknown' | 'none' = 'none',
): {
  groups: Record<string, MinuteSlot[] | null>
  cancelled: boolean
} {
  let cur: Record<string, MinuteSlot[] | null> = {}
  let cancelled = false
  for (const pub of pubs) {
    if (pub.cancelled) {
      cur = {}
      cancelled = true
      continue
    }
    if (pub.from <= 0 || cancelled) {
      cur = { ...pub.groups }
      cancelled = false
      continue
    }
    const next: Record<string, MinuteSlot[] | null> = {}
    for (const g of new Set([...Object.keys(cur), ...Object.keys(pub.groups)])) {
      const prev = cur[g]
      const now = pub.groups[g]
      const before = (prev ?? [])
        .filter((s) => s.start < pub.from)
        .map((s) => ({ ...s, end: Math.min(s.end, pub.from) }))
      if (now === null) next[g] = null
      else if (now) next[g] = [...before, ...now]
      else if (prev !== undefined)
        next[g] = prev && (omitted === 'none' || prev.every((s) => s.end <= pub.from) ? before : null)
    }
    cur = next
  }
  return { groups: cur, cancelled }
}

/** What the posts say about one date */
export interface PostDay {
  /** group → off slots; `null` = not known (named without times, or the day was cancelled) */
  groups: Record<string, MinuteSlot[] | null>
  /** Time of the newest post that shaped the day, ms; NaN when it has none */
  at: number
  /** Index of that post in the list given */
  post: number
  /** The newest post cancels the day's schedule */
  cancelled: boolean
}

/** Emergency (ГАВ/СГАВ) notices can name queues and hours too; they aren't the hourly schedule */
const EMERGENCY = /аварійн|(?<!\p{L})С?ГАВ(?!\p{L})/iu
const HOURLY = /погодинн|(?<!\p{L})ГПВ(?!\p{L})/iu
const CANCELLED =
  /скасов|відмін(?:ен|я)|не\s+застосов|не\s+діятим|не\s+буд\p{L}+\s+(?:діяти|застосов)|не\s+прогнозу|не\s+передбач/iu
/** "будуть скасовані після стабілізації", "продовжують діяти": not a cancellation of the day */
const NOT_NOW = /продовжу|після|можлив|якщо|у\s+разі/iu

/** A sentence that calls the hourly schedule off, and isn't about ГАВ or the industry's ГОП */
function cancelsSchedule(text: string): boolean {
  // such a notice is a few lines; an article that explains the schedules mentions all of this
  if (text.length > 1500) return false
  return text
    .slice(0, 700)
    .split(/[.!?\n]+/)
    .some(
      (s) =>
        HOURLY.test(s) &&
        CANCELLED.test(s) &&
        !EMERGENCY.test(s) &&
        !NOT_NOW.test(s) &&
        !/(?<!\p{L})ГОП(?!\p{L})|потужності/iu.test(s),
    )
}

const plainLines = (html: string) =>
  html
    .split(/\n|<br\s*\/?>|<\/p>|<\/li>|<\/div>|<\/tr>|<\/h\d>/i)
    .map((l) =>
      l
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .trim(),
    )
    .filter(Boolean)

const hasGroups = (line: string) => Object.keys(parseGroupPost(line)).length > 0

/** "станом на 22:00 17 листопада", "оновлено о 23:00, 15.11.2026": when it was said, not the day it is about */
const STAMP_BEFORE = /(?:станом\s+на|оновлен\p{L}*)[\s,]*(?:(?:з|об?)\s+)?(?:\d{1,2}[:.]\d{2}[\s,]*)?$/iu
/** "на 17 листопада", "на сьогодні, 15 листопада", "на вівторок, 17 листопада" */
const FOR_BEFORE = /(?<!\p{L})на\s+(?:\p{L}+,\s*)?$/iu

/**
 * The one day a piece of text names. A single date (however often) is it. Of several, the
 * times of statement ("станом на …", "оновлено …") don't count, and the one the text says the
 * schedule is "на" wins; when that doesn't settle it, `undefined`: two days, and no telling
 * which the schedule is for. `null` when the text has no date.
 */
function namedDate(text: string, ref: Date): string | null | undefined {
  const all = findUaDates(text, ref)
  if (!all.length) return null
  const distinct = (list: typeof all) => [...new Set(list.map((d) => d.date))]
  if (distinct(all).length === 1) return all[0]!.date
  const about = all.filter((d) => !STAMP_BEFORE.test(text.slice(0, d.index)))
  const stated = distinct(about.filter((d) => FOR_BEFORE.test(text.slice(0, d.index))))
  if (stated.length === 1) return stated[0]
  return !stated.length && distinct(about).length === 1 ? about[0]!.date : undefined
}

/**
 * The day a post is about: the date its title or opening names (see `namedDate`; a title or
 * opening that names two days it can't choose between gives no day at all); without one,
 * "сьогодні" / "завтра" counted from the post's own time, when only one of them is said.
 * Never the post time alone.
 */
function postDate(title: string, header: string, body: string, ref: Date): string | null {
  for (const text of [title, header.slice(0, 600)]) {
    const named = namedDate(text, ref)
    if (named !== null) return named ?? null
  }
  // the lines below the opening: a second day's heading may follow the first day's groups
  const named = findUaDate(body.slice(0, 600), ref)
  if (named) return named
  const said = `${title} ${header}`.toLowerCase()
  const today = kyivDate(ref)
  const words = [
    /післязавтра/.test(said) && 2,
    /(?<!після)завтра/.test(said) && 1,
    /сьогодні/.test(said) && 0,
  ].filter((n): n is number => n !== false)
  return words.length === 1 ? addDays(today, words[0]!) : null
}

/**
 * A post → the days it publishes. Usually one; a post with a second dated heading after the
 * first day's groups ("17 листопада: …  18 листопада: …") gives one part per date.
 */
function postParts(post: SchedulePost, ref: Date): { date: string | null; text: string }[] {
  const lines = plainLines(post.body)
  const first = lines.findIndex(hasGroups)
  const header = (first === -1 ? lines : lines.slice(0, first)).join('\n')
  // an emergency notice that lists queues is not a schedule
  if (EMERGENCY.test(`${post.title} ${header}`) && !HOURLY.test(`${post.title} ${header}`)) return []
  const date = postDate(post.title, header, lines.join(' '), ref)
  if (first === -1) return [{ date, text: lines.join('\n') }]
  const parts = [{ date, lines: lines.slice(0, first) }]
  let seen = false
  for (const line of lines.slice(first)) {
    const part = parts.at(-1)!
    if (hasGroups(line)) seen = true
    else if (seen && !/\d{1,2}[:.]\d{2}\s*(?:[-–—−]|до|по)/.test(line)) {
      const other = findUaDate(line, ref)
      if (other && other !== part.date) {
        parts.push({ date: other, lines: [line] })
        seen = false
        continue
      }
    }
    part.lines.push(line)
  }
  return parts.map((p) => ({ date: p.date, text: p.lines.join('\n') }))
}

/**
 * Posts → what they say per date, for yesterday and later, dates sorted. Posts are ranked by
 * `publishedAt`; among posts with the same or no time, the one earlier in the list is newer.
 * Posts without group lines (announcements, emergency notices) are ignored, except a
 * cancellation of the hourly schedule for a date, which leaves that date not known.
 */
export function postsToDays(
  posts: readonly SchedulePost[],
  now: Date,
  opts: PostsOptions = {},
): Map<string, PostDay> {
  const byDate = new Map<string, { at: number; post: number; pub: Publication }[]>()
  const from = addDays(kyivDate(now), -1)

  posts.forEach((p, post) => {
    const at = Date.parse(p.publishedAt)
    const ref = Number.isFinite(at) ? new Date(at) : now
    for (const { date, text } of postParts(p, ref)) {
      if (!date || date < from) continue
      // a schedule is published at most a couple of days ahead; anything else is a misread
      if (Math.abs(Date.parse(date) - Date.parse(kyivDate(ref))) > 3 * 86_400_000) continue
      const groups = parseGroupPost(text)
      const cancelled = !Object.keys(groups).length
      if (cancelled && !cancelsSchedule(`${p.title}\n${text}`)) continue
      const during = Number.isFinite(at) && kyivDate(ref) === date ? kyivMinuteOfDay(ref) : 0
      const list = byDate.get(date) ?? []
      list.push({
        at,
        post,
        pub: {
          groups,
          from: opts.updates === 'layer' ? (opts.effectiveFrom?.(p, date) ?? during) : 0,
          ...(cancelled ? { cancelled } : {}),
        },
      })
      byDate.set(date, list)
    }
  })

  const out = new Map<string, PostDay>()
  for (const date of [...byDate.keys()].sort()) {
    // oldest first
    const list = byDate
      .get(date)!
      .sort((a, b) =>
        Number.isFinite(a.at) && Number.isFinite(b.at) && a.at !== b.at ? a.at - b.at : b.post - a.post,
      )
    const newest = list.at(-1)!
    const day = layerPublications(
      list.map((l) => l.pub),
      opts.omitted ?? 'unknown',
    )
    // a cancelled day keeps the groups its posts named, as not known
    if (day.cancelled) for (const l of list) for (const g of Object.keys(l.pub.groups)) day.groups[g] = null
    out.set(date, { ...day, at: newest.at, post: newest.post })
  }
  return out
}

/** One date's groups → a `DaySchedule` per group of the region */
function dayOf(date: string, day: PostDay, groups: readonly GroupId[], opts: PostsOptions): DaySchedule[] {
  return groups.map((g) => {
    const slots = day.groups[g]
    if (slots) return makeDay(date, slots)
    // named in the post without times or a "power on" statement, or a cancelled day: not known
    if (slots === null || day.cancelled) return { date, status: 'unknown' as const, intervals: [] }
    // a group missing from that day's post: no outages if the operator lists only the
    // groups that have them, otherwise we just don't know
    return opts.omitted === 'none' ? makeDay(date, []) : { date, status: 'unknown' as const, intervals: [] }
  })
}

const groupsOf = (days: Map<string, PostDay>, opts: PostsOptions) => {
  const set = new Set<string>(opts.groups ?? [])
  for (const d of days.values()) for (const g of Object.keys(d.groups)) set.add(g)
  return [...set].sort(compareGroups)
}

/**
 * `postsToDays` in the shape `mergeSources` takes. `publishedAt` is the time of the newest post
 * for the date; pass `publishedAt` when the post's real time is known some other way.
 */
export function daysToSource(
  days: Map<string, PostDay>,
  opts: PostsOptions & { publishedAt?: (day: PostDay, date: string) => string | null } = {},
): SourceRead {
  const groups = groupsOf(days, opts)
  const out: SourceRead['days'] = {}
  for (const [date, day] of days) {
    const schedules: Record<GroupId, DaySchedule> = {}
    dayOf(date, day, groups, opts).forEach((d, i) => (schedules[groups[i]!] = d))
    out[date] = {
      schedules,
      ...(day.cancelled ? { cancelled: true } : {}),
      publishedAt: opts.publishedAt
        ? opts.publishedAt(day, date)
        : Number.isFinite(day.at)
          ? toKyivIso(new Date(day.at))
          : null,
    }
  }
  return { days: out, groups }
}

/**
 * Newest post per date wins (or is layered onto the older ones, see `PostsOptions.updates`).
 * Posts without group lines (announcements, emergency notices) are ignored. Only yesterday and
 * later is kept.
 */
export function postsToSchedule(
  region: RegionId,
  posts: readonly SchedulePost[],
  now: Date,
  opts: PostsOptions = {},
): RegionSchedule {
  const days = postsToDays(posts, now, opts)
  // no post with a schedule: the region's groups (when known) stay listed, unknown for today
  if (!days.size) return unpublished(region, opts.groups ?? [], now)
  const groups = groupsOf(days, opts)

  const schedules: Record<string, DaySchedule[]> = {}
  for (const g of groups) schedules[g] = []
  for (const [date, day] of days)
    dayOf(date, day, groups, opts).forEach((d, i) => schedules[groups[i]!]!.push(d))

  const newest = Math.max(0, ...[...days.values()].map((d) => d.at).filter(Number.isFinite))
  return {
    region,
    groups,
    schedules,
    updatedAt: newest ? toKyivIso(new Date(newest)) : null,
    fetchedAt: toKyivIso(now),
  }
}

export interface ChannelPostsOptions extends PostsOptions {
  /** Preview pages of ~20 posts to read at most, default 2 */
  maxPages?: number
}

/** `readChannelPosts` plus what the posts said per date, for readers that compare channels */
export interface ChannelPosts {
  read: SourceRead
  days: Map<string, PostDay>
}

/**
 * The operator's Telegram channel as a schedule source for `mergeSources`: the posts since
 * yesterday noon (tomorrow's schedule is posted in the evening, today's updates during the
 * day), read as the same text the site carries. News, ГАВ notices and pictures are skipped by
 * `postsToDays`. Only today and later: yesterday's first post is outside the window, so its
 * updates alone would be half a day. A window that the pages read don't cover is a `parse`
 * error for the same reason. `publishedAt` is the post time (an edit keeps it).
 */
export async function readChannelPosts(
  ctx: ProviderContext,
  region: RegionId,
  channel: string,
  opts: ChannelPostsOptions = {},
): Promise<ChannelPosts> {
  const now = ctx.now()
  const today = kyivDate(now)
  const since = kyivInstant(addDays(today, -1), 12 * 60)
  const { posts, from } = await readChannelWindow(ctx, channel, {
    region,
    since,
    maxPages: opts.maxPages ?? 2,
  })
  // without the evening post a day's update would stand as the whole day, and as the newest
  if (Date.parse(from) > since.getTime())
    throw new OutageError(
      'parse',
      `Telegram @${channel}: the posts since ${toKyivIso(since)} couldn't all be read (only from ${from})`,
      { region, url: `https://t.me/s/${channel}` },
    )
  const days = postsToDays(
    posts.map((p) => ({ title: '', body: p.text, publishedAt: p.at })),
    now,
    opts,
  )
  for (const date of [...days.keys()]) if (date < today) days.delete(date)
  return { read: daysToSource(days, opts), days }
}
