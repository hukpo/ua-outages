import { toSlots } from '../ai/map.js'
import { analyzeAll, channelInputs } from '../ai/posts.js'
import { clockMinutes } from '../ai/validate.js'
import { readChannelWindow, type TelegramPost } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { makeDay, type MinuteSlot } from '../schedule.js'
import { addDays, kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId } from '../types.js'
import { gpvEvents } from './posts.js'
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

/**
 * The ГПВ statements among a channel's posts, oldest first, read by the client's text processor.
 * Posts of another kind (СГАВ notices, forecasts, ГОП orders) give none. A post that can't be
 * read is a `parse` error when it is recent enough to matter (posted since yesterday): a list
 * read wrong, or skipped while an older one stands, would be shown as the schedule.
 *
 * Every list states the whole day, so a correction ("внесено зміни …") is a whole list too,
 * whatever the processor calls it. The operator's change time ("станом на 15:45 15.11.2026") is
 * the version's time when the post follows it within the hour.
 */
export async function gpvVersions(
  ctx: ProviderContext,
  posts: readonly TelegramPost[],
): Promise<GpvVersion[]> {
  const region = 'kirovohrad'
  const now = ctx.now()
  const recent = kyivInstant(addDays(kyivDate(now), -1), 0).getTime()
  const sorted = [...posts].sort((a, b) => a.id - b.id)
  const analyzed = await analyzeAll(ctx, region, channelInputs(sorted, region))
  const out: GpvVersion[] = []
  /** New versions whose hours aren't in their text */
  const blind: { date: string; postedAt: number; url: string }[] = []
  for (const { input, analysis, error } of analyzed) {
    const postedAt = Date.parse(input.publishedAt)
    if (!analysis) {
      if (postedAt >= recent) throw error
      continue
    }
    for (const ev of gpvEvents(analysis, region)) {
      const date = ev.date ?? kyivDate(new Date(postedAt))
      const posted = kyivDate(new Date(postedAt))
      if (date < posted || date > addDays(posted, 2)) {
        if (postedAt >= recent)
          throw new OutageError('parse', `${input.url}: the date ${date} doesn't fit a post of ${posted}`, {
            region,
            url: input.url,
          })
        continue
      }
      const base = {
        date,
        at: stampOr(analysis.statedAt, date, input.publishedAt),
        postedAt: input.publishedAt,
        url: input.url,
      }
      if (ev.action === 'cancel') {
        out.push({ ...base, cancelled: true, untilFurtherOrder: ev.untilFurtherNotice, slots: {} })
        continue
      }
      // a new version whose hours aren't in its text (a picture): it must not leave the version
      // before it standing, unless a list with hours for its day follows (checked below)
      if (!ev.schedule.length) {
        if (postedAt >= recent) blind.push({ date, postedAt, url: input.url })
        continue
      }
      // the dispatcher calls whole lists "Зміни … до графіка" too: one naming every group is the
      // day; a correction of some groups only can't be applied by a reader of whole lists
      if (ev.action === 'change' && KIROVOHRAD_GROUPS.some((g) => !ev.schedule.some((q) => q.queue === g))) {
        if (postedAt >= recent)
          throw new OutageError(
            'parse',
            `${input.url}: a correction of some groups, which a list reader can't apply`,
            {
              region,
              url: input.url,
            },
          )
        continue
      }
      const slots: Record<GroupId, MinuteSlot[]> = {}
      for (const q of ev.schedule) {
        if (!q.intervals) {
          if (postedAt >= recent)
            throw new OutageError('parse', `${input.url}: group ${q.queue} is listed without hours`, {
              region,
              url: input.url,
            })
          continue
        }
        slots[q.queue] = toSlots(q.intervals)
      }
      out.push({ ...base, cancelled: false, slots })
    }
  }
  // a version without hours ("на 06.11 діятиме графік", hours in a picture) must not leave an
  // older list standing for its day: fine when a list with hours follows it, or when there was
  // none before it (the day is then simply not known)
  const today = kyivDate(now)
  // among posts of the same second, the higher message id is the later
  const idOf = (url: string) => Number(url.split('/').pop()) || 0
  const cmp = (v: GpvVersion, b: (typeof blind)[number]) =>
    Date.parse(v.postedAt) - b.postedAt || idOf(v.url) - idOf(b.url)
  for (const b of blind)
    if (
      b.date >= today &&
      out.some((v) => v.date === b.date && cmp(v, b) < 0) &&
      !out.some((v) => v.date === b.date && cmp(v, b) > 0)
    )
      throw new OutageError(
        'parse',
        `${b.url}: the newest version for ${b.date} has its hours outside its text`,
        {
          region,
          url: b.url,
        },
      )
  return out
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

/** The channel as a schedule source: today and later, each day as it stands now. */
export function gpvVersionsToSource(versions: readonly GpvVersion[], now: Date): SourceRead {
  const today = kyivDate(now)
  const days: SourceRead['days'] = {}
  for (const [date, v] of standingVersions(versions))
    if (date >= today) days[date] = { schedules: versionDay(v), publishedAt: v.at }
  return { days, groups: [...KIROVOHRAD_GROUPS] }
}

/**
 * Reads the channel back to the evening two days ago: far enough for every statement about
 * yesterday (needed to recognise yesterday's grid on the site after midnight), today and tomorrow.
 */
export async function readGpvChannel(ctx: ProviderContext): Promise<GpvVersion[]> {
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
