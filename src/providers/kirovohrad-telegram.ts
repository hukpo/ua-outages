import { analyzeAll, channelInputs, type Analyzed } from '../ai/posts.js'
import { clockMinutes } from '../ai/validate.js'
import { readChannelWindow, type TelegramPost } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { makeDay, type MinuteSlot } from '../schedule.js'
import { addDays, kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId } from '../types.js'
import {
  gpvEvents,
  isWhole,
  newerThan,
  resolveUnread,
  textPublications,
  textUnread,
  type DatedPublication,
  type UnreadItem,
} from './posts.js'
import type { ProviderContext } from './provider.js'
import type { SourceRead } from './sources.js'

/**
 * Kirovohradoblenergo's Telegram channels: the dispatcher's system posts the whole ГПВ list as
 * text the evening before, and again on every change; the posts are read by the client's text
 * processor.
 *
 * ```
 * 17.11.2026 за розпорядженням НЕК "Укренерго" буде діяти наступний графік погодинних відключень (ГПВ):
 *
 * Черга 1.1: 08-10, 16-18, 20-22
 * ```
 *
 * ```
 * На 15.11.2026 за розпорядженням НЕК "Укренерго" внесено зміни до графіка погодинних відключень (ГПВ) станом на 15:45 15.11.2026:
 *
 * Черга 2.1: 20-22
 * ```
 *
 * ```
 * 15.11.2026 за наказом НЕК "Укренерго" ГПВ та ГОП скасовано до окремого розпорядження.
 * ```
 *
 * Every list states the whole day as ordered at that moment: it replaces the one before, and a
 * group it leaves out has no outages (post 1816 of 15.11 lists ten groups, 1820 six). Hours come
 * without minutes ("14-16"), half hours as "00-00:30". The text has no "possible outage" half
 * hours: those exist only in the site's grid.
 *
 * The 21 district channels carry the same posts; the city's is read (see docs/sources/kirovohrad.md).
 */
export const KIROVOHRAD_CHANNEL = 'SvitloKropyvnytskyiMisto'

export const KIROVOHRAD_GROUPS: readonly GroupId[] = [1, 2, 3, 4, 5, 6].flatMap((q) => [`${q}.1`, `${q}.2`])

/** One statement of a day's ГПВ: a list, or a cancellation (no outages for anyone). */
export interface GpvVersion {
  /** The day it is about, "YYYY-MM-DD" */
  date: string
  /** The operator's change time: "станом на HH:MM DD.MM.YYYY" when the post has it, else the post time. ISO */
  at: string
  /** Post time, ISO */
  postedAt: string
  url: string
  /** "ГПВ … скасовано": nobody is switched off any more */
  cancelled: boolean
  /** "… скасовано до окремого розпорядження": the lists already posted for later days are void too */
  untilFurtherOrder?: boolean
  /** Off slots per group; a group that isn't listed has none */
  slots: Record<GroupId, MinuteSlot[]>
}

/** The channel's ГПВ statements, and the days a newer post about couldn't be read (yet) */
export interface GpvChannel {
  /** Whole lists and cancellations, oldest first */
  versions: GpvVersion[]
  /** date → why: the day stands as read before it, flagged; read again on a later poll */
  unread: Map<string, OutageError>
}

/**
 * The ГПВ statements among a channel's posts, read by the client's text processor and put
 * together like every other post reader's (`textPublications`, `isWhole`, `resolveUnread`).
 * Posts of another kind (СГАВ notices, forecasts, ГОП orders) give none.
 *
 * Every list states the whole day, so a correction ("внесено зміни …") naming every group is a
 * whole list too, whatever the processor calls it. What a reader of whole lists can't apply is as
 * good as unread for its day: a correction of some groups, a list for part of the day ("з 16:00
 * до 18:00"), a group listed without hours, hours that are only in a picture, a date that doesn't
 * fit the post. The operator's change time ("станом на 15:45 15.11.2026") is the version's time
 * when the post follows it within the hour.
 */
export async function gpvVersions(ctx: ProviderContext, posts: readonly TelegramPost[]): Promise<GpvChannel> {
  const region = 'kirovohrad'
  const now = ctx.now()
  const sorted = [...posts].sort((a, b) => a.id - b.id)
  const raw = await analyzeAll(ctx, region, channelInputs(sorted, region))
  // a "change" listing every group, for the whole day: the day's list
  const analyzed: Analyzed[] = raw.map((a) =>
    a.analysis
      ? {
          ...a,
          analysis: {
            ...a.analysis,
            events: a.analysis.events.map((e) =>
              e.kind === 'gpv' &&
              e.action === 'change' &&
              !e.at &&
              !e.until &&
              KIROVOHRAD_GROUPS.every((g) => e.schedule.some((q) => q.queue === g))
                ? { ...e, action: 'start' as const }
                : e,
            ),
          },
        }
      : a,
  )
  const items: UnreadItem[] = textUnread(analyzed, region, now)
  const whole: DatedPublication[] = []
  const cantApply = (post: number, date: string, why: string) =>
    items.push({
      post,
      days: [date],
      error: new OutageError('parse', `${analyzed[post]!.input.url}: ${why}`, {
        region,
        url: analyzed[post]!.input.url,
      }),
    })
  // back to the day before yesterday: yesterday's grid on the site is recognised after midnight
  for (const p of textPublications(analyzed, region, now, {}, addDays(kyivDate(now), -2))) {
    const posted = kyivDate(new Date(analyzed[p.post]!.input.publishedAt))
    if (p.date < posted || p.date > addDays(posted, 2))
      cantApply(p.post, p.date, `the date ${p.date} doesn't fit a post of ${posted}`)
    else if (!isWhole(p.pub))
      cantApply(p.post, p.date, `a correction or part of the day, which a list reader can't apply`)
    else if (Object.values(p.pub.groups).some((slots) => slots === null))
      cantApply(p.post, p.date, `a group is listed without hours`)
    else whole.push(p)
  }
  const unread = new Map(
    [...resolveUnread(items, whole, newerThan(analyzed), now)].map(([d, item]) => [d, item.error]),
  )
  const versions = whole.map((p): GpvVersion => {
    const { input, analysis } = analyzed[p.post]!
    const cancel = analysis
      ? gpvEvents(analysis, region).find(
          (e) => e.action === 'cancel' && (e.date ?? kyivDate(new Date(input.publishedAt))) === p.date,
        )
      : undefined
    return {
      date: p.date,
      at: stampOr(analysis?.statedAt ?? null, p.date, input.publishedAt),
      postedAt: input.publishedAt,
      url: input.url,
      cancelled: !!p.pub.cancelled,
      ...(cancel?.untilFurtherNotice ? { untilFurtherOrder: true } : {}),
      slots: p.pub.cancelled ? {} : (p.pub.groups as Record<GroupId, MinuteSlot[]>),
    }
  })
  return { versions, unread }
}

/** "станом на 23:56" is the change itself, when the post follows within the hour */
function stampOr(stated: string | null, date: string, postIso: string): string {
  if (!stated) return postIso
  const postedAt = Date.parse(postIso)
  const m = clockMinutes(stated)
  for (const day of [kyivDate(new Date(postedAt)), date, addDays(date, -1)]) {
    const stamp = kyivInstant(day, m).getTime()
    if (postedAt - stamp >= 0 && postedAt - stamp <= 3600_000) return toKyivIso(new Date(stamp))
  }
  return postIso
}

/**
 * What stands for each day after all the statements, oldest first: the newest one for the day.
 * "Скасовано до окремого розпорядження" also withdraws the lists already
 * posted for later days; they come back with the next order.
 */
export function standingVersions(versions: readonly GpvVersion[]): Map<string, GpvVersion> {
  const current = new Map<string, GpvVersion>()
  for (const v of versions) {
    current.set(v.date, v)
    if (v.untilFurtherOrder) for (const d of [...current.keys()]) if (d > v.date) current.delete(d)
  }
  return current
}

export function versionDay(v: GpvVersion): Record<GroupId, DaySchedule> {
  const out: Record<GroupId, DaySchedule> = {}
  for (const g of KIROVOHRAD_GROUPS)
    out[g] = v.cancelled
      ? { date: v.date, status: 'no-outages', intervals: [] }
      : makeDay(v.date, v.slots[g] ?? [])
  return out
}

/** The channel as a schedule source: today and later, each day as it stands now, flagged when a newer post about it couldn't be read. */
export function gpvVersionsToSource({ versions, unread }: GpvChannel, now: Date): SourceRead {
  const today = kyivDate(now)
  const days: SourceRead['days'] = {}
  for (const [date, v] of standingVersions(versions))
    if (date >= today)
      days[date] = {
        schedules: versionDay(v),
        // known to be behind (a newer post couldn't be read): no time to win the day by, so the
        // site's grid, which may show the newer list, stands where it has one
        publishedAt: unread.has(date) ? null : v.at,
        ...(unread.has(date) ? { unread: unread.get(date)!.message } : {}),
      }
  for (const [date, error] of unread)
    if (date >= today && !days[date]) days[date] = { schedules: {}, publishedAt: null, unread: error.message }
  return { days, groups: [...KIROVOHRAD_GROUPS] }
}

/**
 * Reads the channel back to the evening two days ago: far enough for every statement about
 * yesterday (needed to recognise yesterday's grid on the site after midnight), today and tomorrow.
 */
export async function readGpvChannel(ctx: ProviderContext): Promise<GpvChannel> {
  const now = ctx.now()
  const since = kyivInstant(addDays(kyivDate(now), -2), 12 * 60)
  const { posts, from } = await readChannelWindow(ctx, KIROVOHRAD_CHANNEL, {
    region: 'kirovohrad',
    since,
    maxPages: 4,
  })
  // a post among the ones missed may be a newer version of a day, unread or blind
  if (Date.parse(from) > since.getTime())
    throw new OutageError(
      'parse',
      `Telegram @${KIROVOHRAD_CHANNEL}: the posts since ${toKyivIso(since)} couldn't all be read (only from ${from})`,
      { region: 'kirovohrad', url: `https://t.me/s/${KIROVOHRAD_CHANNEL}` },
    )
  return gpvVersions(ctx, posts)
}
