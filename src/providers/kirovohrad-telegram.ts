import { readChannelWindow, type TelegramPost } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { makeDay, type MinuteSlot } from '../schedule.js'
import { addDays, kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId } from '../types.js'
import type { ProviderContext } from './provider.js'
import type { SourceRead } from './sources.js'

/**
 * Kirovohradoblenergo's Telegram channels: the dispatcher's system posts the whole ГПВ list as
 * text the evening before, and again on every change.
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

const DATE = String.raw`(\d{2})\.(\d{2})\.(\d{4})`
// the day a list is for: "[На ]17.11.2026 за розпорядженням …", and until 05.11.2026
// "За розпорядженням НЕК "Укренерго" 05.11.2026 буде діяти …"
const LIST_DATE = [
  new RegExp(`^(?:На\\s+)?${DATE}\\s+за\\s+(?:розпорядженням|наказом)`, 'i'),
  new RegExp(`Укренерго["”»]?\\s+${DATE}\\s+(?:буде\\s+діяти|внесено\\s+зміни)`, 'i'),
]
const STAMP = new RegExp(`(?:станом\\s+на|Зміни\\s+на)\\s+(\\d{1,2}):(\\d{2})\\s+${DATE}`, 'i')
const CANCEL = new RegExp(
  `^${DATE}\\s+за\\s+(?:наказом|розпорядженням)\\s+НЕК\\s+["“«]?Укренерго["”»]?\\s+ГПВ(?:\\s+та\\s+ГОП)?\\s+скасовано`,
  'i',
)
// the dispatcher's system also posts an emptied list: "На 15.11.2026 за розпорядженням НЕК "Укренерго"
// скасовано графік погодинних відключень (ГПВ) станом на 20:00 15.11.2026:" (seen in a district
// channel, t.me/SvitloHolovanivskohoRayonu/1792)
const CANCEL_DAY = new RegExp(
  `^(?:На\\s+)?${DATE}\\s+за\\s+(?:наказом|розпорядженням)\\s+НЕК\\s+["“«]?Укренерго["”»]?\\s+скасовано\\s+графік\\S*\\s+погодинних\\s+відключень`,
  'i',
)
const GROUP_LINE = /^Черга\s+(\d+)\.(\d+)\s*:\s*(.*)$/
const RANGE = /^(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?$/

const iso = (m: RegExpExecArray, from: number) => `${m[from + 2]}-${m[from + 1]}-${m[from]}`

/**
 * The ГПВ statements among a channel's posts, oldest first. Posts of another kind (СГАВ notices,
 * forecasts, ГОП orders) are skipped. A post that is a ГПВ list or cancellation and can't be read
 * exactly is a `parse` error when it is recent enough to matter (posted since yesterday): a list
 * read wrong, or skipped while an older one stands, would be shown as the schedule.
 */
export function parseGpvPosts(posts: readonly TelegramPost[], now: Date): GpvVersion[] {
  const recent = kyivInstant(addDays(kyivDate(now), -1), 0).getTime()
  const out: GpvVersion[] = []
  for (const p of [...posts].sort((a, b) => a.id - b.id)) {
    const postedAt = Date.parse(p.at)
    const fail = (what: string): never => {
      throw new OutageError('parse', `Telegram @${p.channel}: ГПВ post ${p.id}: ${what}`, {
        region: 'kirovohrad',
        url: p.url,
      })
    }
    try {
      const v = parsePost(p, postedAt, fail)
      if (v) out.push(v)
    } catch (e) {
      if (postedAt >= recent) throw e
    }
  }
  return out
}

function parsePost(p: TelegramPost, postedAt: number, fail: (what: string) => never): GpvVersion | null {
  const text = p.text.trim()
  const base = { postedAt: p.at, url: p.url }
  const cancel = CANCEL.exec(text)
  if (cancel) {
    const date = iso(cancel, 1)
    checkDate(date, postedAt, fail)
    return { ...base, date, at: p.at, cancelled: true, untilFurtherOrder: true, slots: {} }
  }
  const cancelDay = CANCEL_DAY.exec(text)
  if (cancelDay) {
    const date = iso(cancelDay, 1)
    checkDate(date, postedAt, fail)
    return { ...base, date, at: stampOr(text, p.at, postedAt), cancelled: true, slots: {} }
  }
  const lines = text.split('\n').map((l) => l.trim())
  const first = lines.findIndex((l) => /^Черга\s+\d/.test(l))
  if (first === -1) {
    // "16.11.26 у 19:00 скасовано СГАВ" is the emergency reader's; a ГПВ cancel in new words isn't
    if (/скасовано/i.test(text) && /(?<![\p{L}])ГПВ(?![\p{L}])/u.test(text))
      fail('a cancellation in an unknown wording')
    return null
  }
  const head = lines.slice(0, first).join(' ')
  if (!/погодинних\s+відключень/i.test(head)) return null
  const m = LIST_DATE.map((re) => re.exec(head)).find(Boolean)
  if (!m) return fail('no date in the heading')
  const date = iso(m, 1)
  checkDate(date, postedAt, fail)

  const slots: Record<GroupId, MinuteSlot[]> = {}
  for (const line of lines.slice(first)) {
    if (!/^Черга(?![\p{L}])/u.test(line)) continue
    const g = GROUP_LINE.exec(line)
    const group = g ? `${Number(g[1])}.${Number(g[2])}` : ''
    if (!g || !KIROVOHRAD_GROUPS.includes(group)) return fail(`unexpected line "${line}"`)
    if (slots[group]) return fail(`group ${group} is listed twice`)
    slots[group] = g[3]!.split(',').map((part): MinuteSlot => {
      const r = RANGE.exec(part.trim())
      const start = r ? Number(r[1]) * 60 + Number(r[2] ?? 0) : NaN
      const end = r ? Number(r[3]) * 60 + Number(r[4] ?? 0) : NaN
      if (!r || Number(r[2] ?? 0) > 59 || Number(r[4] ?? 0) > 59 || !(start < end) || end > 1440)
        return fail(`unexpected hours "${part.trim()}" for group ${group}`)
      return { start, end, kind: 'off' }
    })
  }

  return { ...base, date, at: stampOr(head, p.at, postedAt), cancelled: false, slots }
}

/** "станом на 23:56 16.11.2026" is the change itself; the post follows within minutes */
function stampOr(head: string, postIso: string, postedAt: number): string {
  const s = STAMP.exec(head)
  const stamp = s ? kyivInstant(iso(s, 3), Number(s[1]) * 60 + Number(s[2])).getTime() : NaN
  return postedAt - stamp >= 0 && postedAt - stamp <= 3600_000 ? toKyivIso(new Date(stamp)) : postIso
}

/** A list is posted for the day it is posted on or the next one; anything else is a misread */
function checkDate(date: string, postedAt: number, fail: (what: string) => never): void {
  const posted = kyivDate(new Date(postedAt))
  if (addDays(date, 0) !== date || date < posted || date > addDays(posted, 2))
    fail(`the date ${date} doesn't fit a post of ${posted}`)
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
  const { posts } = await readChannelWindow(ctx, KIROVOHRAD_CHANNEL, {
    region: 'kirovohrad',
    since,
    maxPages: 4,
  })
  return parseGpvPosts(posts, now)
}
