import { analyzeAll, channelInputs, type Analyzed } from '../ai/posts.js'
import { toSlots } from '../ai/map.js'
import type { PostAnalysis, PostEvent, PostInput } from '../ai/types.js'
import { compareGroups, makeDay, unpublished, type MinuteSlot } from '../schedule.js'
import { readChannelWindow } from '../emergency/telegram.js'
import { addDays, kyivDate, kyivInstant, kyivMinuteOfDay, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, RegionId, RegionSchedule } from '../types.js'
import type { ProviderContext } from './provider.js'
import type { SourceRead } from './sources.js'
import { OutageError } from '../errors.js'
import { clockMinutes } from '../ai/validate.js'

/**
 * Operators that publish each day's schedule as a post ("ГПВ на 6 листопада":
 * "1.1 00:00-03:00; 08:00-13:30"), in their channel or as site news. Corrections arrive as newer
 * posts for the same date. The posts are read by the client's text processor (`PostInput` →
 * `PostAnalysis`); this module only puts the answers together per day.
 */

export interface PostsOptions {
  /**
   * What a group missing from a day's post means. 'unknown' (default): the post didn't say.
   * 'none': the operator lists only the groups that have outages, so it has none that day.
   */
  omitted?: 'unknown' | 'none'
  /**
   * The posts have no time of their own (a site page): their `publishedAt` is only the date
   * they were read against. The order given is the order of publication, newest first, and no
   * post is taken to have gone out during the day it is about.
   */
  timeless?: boolean
  /** Groups the region always has; with `omitted: 'none'` they all get a day, listed or not */
  groups?: readonly string[]
  /**
   * How a newer post for the same date is applied. 'replace' (default): it is the whole day.
   * 'layer': operators whose updates list only the hours still ahead ("оновлено з 15:00":
   * the morning's outages are gone from the text); see `layerPublications`.
   */
  updates?: 'replace' | 'layer'
  /**
   * With `updates: 'layer'`: a list that states no time of its own is the whole day ('stated'),
   * not the hours from its post on (default 'post'). ЦЕК re-lists the whole day, past hours too
   */
  layerFrom?: 'post' | 'stated'
}

/** One publication about one day */
export interface Publication {
  /** group → off slots; `null` = named without times; a missing group wasn't listed */
  groups: Record<string, MinuteSlot[] | null>
  /** Minute of the day from which it replaces older publications; 0 = the whole day */
  from: number
  /** …and up to which ("з 10:00 до 16:00"); the end of the day when absent */
  to?: number
  /** The operator cancelled the day's schedule; `groups` is empty */
  cancelled?: boolean
  /**
   * A correction to some groups ("з 6:00 до 8:00 додатково відключаються 1.1 та 1.2"): their
   * listed slots are added to what they had, `null` makes them not known; the rest stay as they were
   */
  add?: boolean
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
  /**
   * A whole day was published, which the later publications change: without one, a group
   * nothing named is not known, and one only a correction or a window named is not known either
   */
  based: boolean
} {
  let cur: Record<string, MinuteSlot[] | null> = {}
  let cancelled = false
  let based = false
  for (const pub of pubs) {
    if (pub.cancelled) {
      cur = {}
      cancelled = true
      continue
    }
    if (pub.add) {
      if (cancelled) continue
      const next = { ...cur }
      for (const [g, slots] of Object.entries(pub.groups)) {
        const prev = cur[g]
        // added to what? without the day it adds to (no whole day, or one that didn't list the
        // group and lists every group that has outages only with `omitted: 'none'`), not known
        const unknownBase = prev === null || !based || (prev === undefined && omitted !== 'none')
        next[g] = slots === null || unknownBase ? null : [...(prev ?? []), ...slots]
      }
      cur = next
      continue
    }
    const to = pub.to ?? 1440
    const whole = pub.from <= 0 && to >= 1440
    if (whole) {
      cur = { ...pub.groups }
      cancelled = false
      based = true
      continue
    }
    if (!based || cancelled) {
      // part of a day with no whole day under it (or after a cancellation): the hours outside it
      // aren't known, and a day is whole or not known, so every group it or anything before named
      // is not known
      const next: Record<string, MinuteSlot[] | null> = {}
      for (const g of new Set([...Object.keys(cur), ...Object.keys(pub.groups)])) next[g] = null
      cur = next
      cancelled = false
      based = false
      continue
    }
    const next: Record<string, MinuteSlot[] | null> = {}
    for (const g of new Set([...Object.keys(cur), ...Object.keys(pub.groups)])) {
      const prev = cur[g]
      const now = pub.groups[g]
      // what the earlier publications had outside the window
      const outside = (prev ?? []).flatMap((s) => [
        ...(s.start < pub.from ? [{ ...s, end: Math.min(s.end, pub.from) }] : []),
        ...(s.end > to ? [{ ...s, start: Math.max(s.start, to) }] : []),
      ])
      // the window's own hours: a re-list posted at 14:00 keeps the morning as it was (an outage in
      // progress is listed from its start, and kept so)
      const inside = now
        ?.filter((s) => s.end > pub.from && s.start < to)
        // …and ends with it: after `to` the earlier publications stand
        .map((s) => (s.end > to ? { ...s, end: to } : s))
      if (now === null) next[g] = null
      // the hours outside the window weren't known: they still aren't (a group the base didn't
      // list, when the base lists every group, is one of them)
      else if (inside)
        next[g] = prev === null || (prev === undefined && omitted !== 'none') ? null : [...outside, ...inside]
      else if (prev !== undefined)
        next[g] =
          prev &&
          (omitted === 'none' || prev.every((s) => s.end <= pub.from || s.start >= to) ? outside : null)
    }
    cur = next
  }
  return { groups: cur, cancelled, based }
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
  /** A whole day was published (see `layerPublications`): otherwise an unnamed group is not known */
  based: boolean
  /**
   * A newer post about the day couldn't be read (yet: it is asked again on a later poll). The
   * day stays as the posts read make it, and says so; with nothing read for it, it is not known
   */
  unread?: OutageError
}

/** A day only a post that couldn't be read is about: not known */
export const unreadDay = (at: number, post: number, error: OutageError): PostDay => ({
  groups: {},
  at,
  post,
  cancelled: false,
  based: false,
  unread: error,
})

/**
 * When a post says it was issued: the time it says ("станом на 21:25", "(оновлено 21:25)") on
 * the day it is about, or the evening before, whichever is the latest not after `now`; or, for
 * an update "з 15:00", that time on the day when it has come. Null when it says neither.
 */
export function statedTime(a: PostAnalysis, region: RegionId, date: string, now: Date): string | null {
  const ev = gpvEvents(a, region).find((e) => (e.date ?? date) === date)
  const limit = now.getTime() + 10 * 60_000
  if (ev?.at) {
    const t = kyivInstant(date, clockMinutes(ev.at))
    return t.getTime() <= limit ? toKyivIso(t) : null
  }
  if (!a.statedAt) return null
  const m = clockMinutes(a.statedAt)
  const t = [date, addDays(date, -1)].map((d) => kyivInstant(d, m)).find((x) => x.getTime() <= limit)
  return t ? toKyivIso(t) : null
}

/**
 * The hourly-schedule events of an answer that are about `region` as a whole: a schedule for one
 * town (an `area`, with its own numbering) is not the region's
 */
export const gpvEvents = (a: PostAnalysis, region: RegionId): PostEvent[] =>
  a.events.filter((e) => e.kind === 'gpv' && e.regions.includes(region) && !e.area)

/** The answer publishes a schedule (or calls one off) for `region` */
export const hasSchedule = (a: PostAnalysis, region: RegionId) => gpvEvents(a, region).length > 0

/**
 * Analysed posts → what they say per date, for yesterday and later, dates sorted. Posts are
 * ranked by `publishedAt`; among posts with the same time, the one earlier in the list is newer.
 * Only `gpv` events count: a "start" or "change" lists queues and hours, a "cancel" calls the
 * day's schedule off, which leaves that date not known.
 *
 * With `updates: 'layer'`, a post replaces what was published before from the time it says
 * ("оновлено з 15:00": the event's `at`), else from its own time when it is about its own day,
 * else the whole day.
 */
export function postsToDays(
  analyzed: readonly Analyzed[],
  region: RegionId,
  now: Date,
  opts: PostsOptions = {},
): Map<string, PostDay> {
  return daysOf(
    untilFurtherNotice(textPublications(analyzed, region, now, opts), analyzed, region, now, opts),
    opts,
  )
}

/** One publication about one date, with the post it came from (its index) and time (ms, NaN unknown) */
export interface DatedPublication {
  date: string
  at: number
  post: number
  pub: Publication
  /** Among the same or no time, the higher is newer: a Telegram message id, minus a page's index */
  seq?: number
}

/** Order among posts of the same time: a Telegram message's id; a page's lower index is newer */
const seqOf = (input: Analyzed['input'], index: number) => {
  const id = input.source.kind === 'telegram' ? Number(input.url.split('/').pop()) : NaN
  return Number.isFinite(id) ? id : -index
}

/** The `gpv` events of analysed posts → publications, yesterday and later */
export function textPublications(
  analyzed: readonly Analyzed[],
  region: RegionId,
  now: Date,
  opts: PostsOptions = {},
): DatedPublication[] {
  const out: DatedPublication[] = []
  const from = addDays(kyivDate(now), -1)
  analyzed.forEach(({ input, analysis }, post) => {
    if (!analysis) return
    const at = opts.timeless ? NaN : Date.parse(input.publishedAt)
    const ref = new Date(Date.parse(input.publishedAt) || now.getTime())
    for (const ev of gpvEvents(analysis, region)) {
      const date = ev.date ?? kyivDate(ref)
      if (date < from) continue
      const cancelled = ev.action === 'cancel'
      // hours in the post's picture, not its text: the picture reader has them
      if (!cancelled && !ev.schedule.length) continue
      const groups: Record<string, MinuteSlot[] | null> = {}
      if (!cancelled) for (const q of ev.schedule) groups[q.queue] = q.intervals ? toSlots(q.intervals) : null
      const during = Number.isFinite(at) && kyivDate(ref) === date ? kyivMinuteOfDay(ref) : 0
      out.push({
        date,
        at,
        post,
        seq: seqOf(input, post),
        pub: {
          groups,
          // "з 14:00" said in the post is where it starts, in either mode; with 'layer', a post
          // during its day otherwise starts at its own time
          from: ev.at
            ? clockMinutes(ev.at)
            : opts.updates === 'layer' && opts.layerFrom !== 'stated'
              ? during
              : 0,
          // a list for a window of the day ("з 10:00 до 16:00") leaves the hours after it alone
          ...(ev.at && ev.until ? { to: clockMinutes(ev.until, true) } : {}),
          ...(cancelled ? { cancelled } : {}),
          ...(ev.action === 'change' ? { add: true } : {}),
        },
      })
    }
  })
  return out
}

/**
 * "ГПВ скасовано до окремого розпорядження": the days already published after it (in words or
 * in pictures) are off too, until a newer list brings one back. `pubs` gains the cancellations
 */
export function untilFurtherNotice(
  out: DatedPublication[],
  analyzed: readonly Analyzed[],
  region: RegionId,
  now: Date,
  opts: PostsOptions = {},
): DatedPublication[] {
  for (const { input, analysis } of analyzed) {
    if (!analysis) continue
    for (const ev of gpvEvents(analysis, region)) {
      if (ev.action !== 'cancel' || !ev.untilFurtherNotice) continue
      const at = Date.parse(input.publishedAt)
      const ref = new Date(at || now.getTime())
      const day = ev.date ?? kyivDate(ref)
      const post = analyzed.findIndex((a) => a.input === input)
      for (const date of new Set(out.map((p) => p.date)))
        if (date > day)
          out.push({
            date,
            at: opts.timeless ? NaN : at,
            post,
            pub: { groups: {}, from: 0, cancelled: true },
          })
    }
  }
  return out
}

/**
 * Publications → what they say per date, dates sorted. Ranked by time; among the same or no
 * time, the one with the lower post index is newer (lists are newest first).
 */
export function daysOf(pubs: readonly DatedPublication[], opts: PostsOptions = {}): Map<string, PostDay> {
  const byDate = new Map<string, DatedPublication[]>()
  for (const p of pubs) byDate.set(p.date, [...(byDate.get(p.date) ?? []), p])
  const out = new Map<string, PostDay>()
  for (const date of [...byDate.keys()].sort()) {
    // oldest first
    const list = byDate
      .get(date)!
      .sort((a, b) =>
        Number.isFinite(a.at) && Number.isFinite(b.at) && a.at !== b.at
          ? a.at - b.at
          : (a.seq ?? -a.post) - (b.seq ?? -b.post),
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

/**
 * A publication that is the whole day (a list or picture for all of it, or a cancellation): the
 * only thing that stands in for a newer post about the day that couldn't be read. A correction
 * (`add`), a window, or an update for the hours ahead don't. The one place this is decided
 */
export const isWhole = (p: Publication): boolean =>
  !!p.cancelled || (!p.add && p.from <= 0 && (p.to ?? 1440) >= 1440)

/** A post (by index) that couldn't be read, and the days it may be about */
export interface UnreadItem {
  post: number
  days: string[]
  error: OutageError
}

/** The days a post that couldn't be read may be about: its own and the next; on a page without times, yesterday to tomorrow */
export function unreadCandidates(input: PostInput, now: Date, opts: PostsOptions = {}): string[] {
  const today = kyivDate(now)
  if (opts.timeless) return [addDays(today, -1), today, addDays(today, 1)]
  const day = kyivDate(new Date(Date.parse(input.publishedAt) || now.getTime()))
  return [day, addDays(day, 1)]
}

/**
 * What a text reader can't read: posts whose answer failed, and the newest schedule post of a
 * day whose hours are elsewhere (a picture, a link) for a reader without pictures (`blind`)
 */
export function textUnread(
  analyzed: readonly Analyzed[],
  region: RegionId,
  now: Date,
  opts: PostsOptions = {},
  { blind = true }: { blind?: boolean } = {},
): UnreadItem[] {
  const out: UnreadItem[] = []
  analyzed.forEach((a, post) => {
    if (a.error) {
      const error =
        a.error instanceof OutageError
          ? a.error
          : new OutageError('parse', String(a.error), { region, url: a.input.url })
      out.push({ post, days: unreadCandidates(a.input, now, opts), error })
      return
    }
    if (!a.analysis || !blind) return
    for (const e of gpvEvents(a.analysis, region)) {
      if (e.action === 'cancel' || e.schedule.length) continue
      const d =
        e.date ??
        (opts.timeless ? kyivDate(now) : kyivDate(new Date(Date.parse(a.input.publishedAt) || now.getTime())))
      out.push({
        post,
        days: [d],
        error: new OutageError(
          'parse',
          `${a.input.url}: the newest schedule post for ${d} has its hours outside its text`,
          {
            region,
            url: a.input.url,
          },
        ),
      })
    }
  })
  return out
}

/** Which of two posts (by index) is newer: by time, then message id; on a page without times, the higher on the page */
export function newerThan(analyzed: readonly Analyzed[], opts: PostsOptions = {}) {
  const rank = (i: number): [number, number] => {
    const input = analyzed[i]?.input
    if (!input || opts.timeless) return [-i, 0]
    return [Date.parse(input.publishedAt) || 0, seqOf(input, i)]
  }
  return (a: number, b: number) => {
    const [x, y] = [rank(a), rank(b)]
    return x[0] > y[0] || (x[0] === y[0] && x[1] > y[1])
  }
}

/**
 * The days (today and later) an unread post may have changed that no newer whole publication
 * stands in for: day → the item. The first item found per day is kept
 */
export function resolveUnread(
  items: readonly UnreadItem[],
  pubs: readonly DatedPublication[],
  newer: (a: number, b: number) => boolean,
  now: Date,
): Map<string, UnreadItem> {
  const today = kyivDate(now)
  const out = new Map<string, UnreadItem>()
  for (const item of items)
    for (const d of item.days)
      if (
        d >= today &&
        !out.has(d) &&
        !pubs.some((p) => p.date === d && isWhole(p.pub) && newer(p.post, item.post))
      )
        out.set(d, item)
  return out
}

/**
 * Publications and what couldn't be read → days: the publications layered (see `daysOf`), and a
 * day an unread post may have changed flagged (`PostDay.unread`): it stays as read, or, with
 * nothing read for it, is added as not known. Every post reader goes through here
 */
export function assembleDays(
  analyzed: readonly Analyzed[],
  pubs: DatedPublication[],
  items: readonly UnreadItem[],
  region: RegionId,
  now: Date,
  opts: PostsOptions = {},
): Map<string, PostDay> {
  const all = untilFurtherNotice(pubs, analyzed, region, now, opts)
  const unread = resolveUnread(items, all, newerThan(analyzed, opts), now)
  const days = daysOf(all, opts)
  for (const [d, item] of unread) {
    const day = days.get(d)
    const at = opts.timeless ? NaN : Date.parse(analyzed[item.post]?.input.publishedAt ?? '')
    days.set(d, day ? { ...day, unread: item.error } : unreadDay(at, item.post, item.error))
  }
  return new Map([...days.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Text posts through the text processor, then `assembleDays`. A post that can't be read (yet)
 * leaves the days it may be about as read, flagged
 */
export async function readSchedulePosts(
  ctx: ProviderContext,
  region: RegionId,
  inputs: readonly PostInput[],
  opts: PostsOptions = {},
): Promise<{ days: Map<string, PostDay>; analyzed: Analyzed[] }> {
  const now = ctx.now()
  const analyzed = groundTimeless(await analyzeAll(ctx, region, inputs), region, opts)
  const days = assembleDays(
    analyzed,
    textPublications(analyzed, region, now, opts),
    textUnread(analyzed, region, now, opts),
    region,
    now,
    opts,
  )
  return { days, analyzed }
}

/**
 * A page without times (`timeless`) is read against today, and may still show yesterday's
 * article: one that names no day can't be dated, and is as good as unread
 */
export function groundTimeless(analyzed: Analyzed[], region: RegionId, opts: PostsOptions): Analyzed[] {
  if (!opts.timeless) return analyzed
  return analyzed.map((a) =>
    a.analysis && gpvEvents(a.analysis, region).some((e) => !e.date && !e.dateNamed)
      ? {
          ...a,
          analysis: null,
          error: new OutageError(
            'parse',
            `${a.input.url}: a schedule on a page without times that names no day`,
            {
              region,
              url: a.input.url,
            },
          ),
        }
      : a,
  )
}

/** One date's groups → a `DaySchedule` per group of the region */
function dayOf(date: string, day: PostDay, groups: readonly GroupId[], opts: PostsOptions): DaySchedule[] {
  return groups.map((g) => {
    const slots = day.groups[g]
    if (slots) return makeDay(date, slots)
    // named in the post without times or a "power on" statement, or a cancelled day: not known
    if (slots === null || day.cancelled) return { date, status: 'unknown' as const, intervals: [] }
    // a group missing from that day's post: no outages if the operator lists only the
    // groups that have them (in a whole day it published), otherwise we just don't know
    return opts.omitted === 'none' && day.based
      ? makeDay(date, [])
      : { date, status: 'unknown' as const, intervals: [] }
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
      ...(day.unread ? { unread: day.unread.message } : {}),
      // only part of the day, with no whole day under it: not known, but newer news than an older
      // whole day elsewhere ("оновлено з 19:00" on the channel after the site's 18:00 version)
      ...(!day.based && !day.cancelled && Object.keys(day.groups).length ? { partial: true } : {}),
      publishedAt: opts.publishedAt
        ? opts.publishedAt(day, date)
        : Number.isFinite(day.at)
          ? toKyivIso(new Date(day.at))
          : null,
    }
  }
  return { days: out, groups }
}

/** Days read from posts → the region's schedule (the region's groups listed even when unnamed) */
export function postsToSchedule(
  region: RegionId,
  days: Map<string, PostDay>,
  now: Date,
  opts: PostsOptions = {},
): RegionSchedule {
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
  const { days } = await readSchedulePosts(ctx, region, channelInputs(posts, region), opts)
  for (const date of [...days.keys()]) if (date < today) days.delete(date)
  return { read: daysToSource(days, opts), days }
}
