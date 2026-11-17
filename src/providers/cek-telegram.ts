import { readChannelWindow, type TelegramPost } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { makeDay, type MinuteSlot } from '../schedule.js'
import { addDays, kyivDate, kyivInstant, kyivMinuteOfDay, parseClock, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId } from '../types.js'
import type { SourceRead, SourceSpec } from './sources.js'
import { findUaDate } from './ua-text.js'

/**
 * ЦЕК's own channel, @cek_info. It posts each day's ГПВ as text the evening before (21:00–23:10)
 * and every change during the day, well ahead of YASNO's feed for the same operator (3/303),
 * which on 16–17.11.2026 still said "emergency, no schedule" 90 minutes after ЦЕК had cancelled
 * the emergency and published the list.
 *
 * Kinds of post, all without a year ("16 ЛИСТОПАДА", once "11.11"):
 *
 * ```
 * … 16 ЛИСТОПАДА з 00:00 до 24:00 застосовуватимуться відключення наступних черг:   the whole day
 * 🔹 Черга 1.1
 * 00:30-04:00
 * 11:00-14:30
 * ```
 * (also "діятимуть наступні черги:" with bare "1.1" lines, and "✅ 01:30-04:00")
 *
 * - `зміни у ГПВ на 16 ЛИСТОПАДА за розпорядженням …:` + the same blocks: the whole day again;
 * - `зміни у ГПВ на 12 ЛИСТОПАДА з 16:00 до 24:00, …:` (or `з 04:00`) + blocks: that part of the
 *   day again; a group it leaves out has no outage in it, the hours before stay as they were;
 * - prose: `зміни в ГПВ 13 ЛИСТОПАДА, … з 00:00 до 06:00 додатково застосовуються відлючення
 *   черги 3.1, 3.2`. One window and the groups it names can be applied exactly (they are off
 *   then). Anything else ("з 02:30 додатково … 6.1, 6.2" with no end, two windows in a sentence,
 *   a negation: "… не застосовуються відключення …", "скасовуються …")
 *   can't: the groups it names become `unknown` for that day until the next list, the others stay;
 * - `скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ ‼️ Повертаємося до ГРАФІКІВ ПОГОДИННИХ ВІДКЛЮЧЕНЬ`: the list
 *   of that day stands again, as of this post. That is what lets it win over a YASNO feed still
 *   showing the emergency;
 * - lists for one town with their own numbering (`м. ПАВЛОГРАД … 📌 2.2 черга:`), notices to
 *   other towns, planned works and the emergency notices themselves aren't the regional
 *   schedule and are skipped (`getEmergency` reads the emergencies).
 */
export const CEK_CHANNEL = 'cek_info'

export const CEK_GROUPS: readonly GroupId[] = [1, 2, 3, 4, 5, 6].flatMap((q) => [`${q}.1`, `${q}.2`])

/** One day as the channel's posts leave it */
export interface CekDay {
  /** Time of the newest post that says something about the day's ГПВ, ms */
  at: number
  /** That post */
  url: string
  /** Off slots per group; null when a change that can't be applied exactly made them unknown */
  groups: Record<GroupId, MinuteSlot[] | null>
}

const MONTHS = 'січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня'
const DAY = new RegExp(
  `(\\d{1,2})\\s+(?:${MONTHS})(?![\\p{L}])|(?<![\\d.:])\\d{1,2}\\.\\d{2}(?![\\d.:])`,
  'iu',
)
const WHOLE_DAY = /з\s+00:00\s+до\s+24:00\s+(?:застосовуватимуться|діятимуть)/i
const CHANGE = /зміни\s+[ув]\s+ГПВ/i
const BACK_TO_GPV = /скасування\s+ЕКСТРЕНИХ\s+ВІДКЛЮЧЕНЬ[\s\S]*Повертаємося\s+до\s+ГРАФІК/i
const LABEL = /^(?:🔹\s*)?(?:Черга\s+)?(\d+)\.(\d+)$/
const TIMES = /^(?:✅\s*)?(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/
const GROUP = /(?<![\d:.])(\d)\.(\d)(?![\d:])/g
/** "м. ПАВЛОГРАД", "м. ЖОВТІ ВОДИ": the towns are in capitals */
const TOWN = /(?<![\p{L}])м\.\s*([\p{Lu}][\p{Lu}'ʼ’ -]+)/u
const CLOCK = String.raw`(\d{1,2}:\d{2})`
const FROM = new RegExp(`^[\\s,]*з\\s+${CLOCK}(?:\\s+до\\s+${CLOCK})?`, 'i')
const CLOCK_ANYWHERE = /\d{1,2}[:.]\d{2}/
const WINDOWS = new RegExp(`(?:з\\s+${CLOCK}\\s+)?до\\s+${CLOCK}|з\\s+${CLOCK}`, 'gi')

/**
 * The channel's posts → each day's ГПВ as it stands, by date. A post that is a ГПВ list and
 * can't be read exactly is a `parse` error when it is recent enough to matter (posted since
 * yesterday); older ones are skipped. Exported for tests.
 */
export function parseCekPosts(posts: readonly TelegramPost[], now: Date): Map<string, CekDay> {
  const recent = kyivInstant(addDays(kyivDate(now), -1), 0).getTime()
  const days = new Map<string, CekDay>()
  for (const p of [...posts].sort((a, b) => a.id - b.id)) {
    const postedAt = Date.parse(p.at)
    try {
      applyPost(days, p, postedAt)
    } catch (e) {
      if (postedAt >= recent) throw e
    }
  }
  return days
}

function applyPost(days: Map<string, CekDay>, p: TelegramPost, postedAt: number): void {
  const fail = (what: string): never => {
    throw new OutageError('parse', `Telegram @${p.channel}: ГПВ post ${p.id}: ${what}`, {
      region: 'dnipro-cek',
      url: p.url,
    })
  }
  const lines = p.text.split('\n').map((l) => l.trim())
  const first = lines.findIndex((l) => LABEL.test(l))
  const head = (first === -1 ? lines : lines.slice(0, first)).join(' ')
  const town = TOWN.exec(head)?.[1]?.trim()
  // one town's notice or its separate list ("📌 2.2 черга:"), not the region's schedule
  if ((town && !/^ДНІПРО$/u.test(town)) || /окремим\s+графіком/i.test(head)) return

  const posted = kyivDate(new Date(postedAt))
  if (BACK_TO_GPV.test(head)) {
    const day = days.get(posted)
    if (!day) return
    days.set(posted, { ...day, at: postedAt, url: p.url })
    // "… - до 22:00 відключаються черги: 1.1, 1.2": true for a while, in no list
    if (named(head).length) setUnknown(days, posted, named(head), postedAt, p.url)
    return
  }
  const whole = WHOLE_DAY.test(head)
  if (!whole && !CHANGE.test(head)) {
    if (first !== -1) fail('a list under an unknown heading')
    return
  }
  const d = DAY.exec(head)
  const date = d && findUaDate(d[0], new Date(postedAt))
  if (!d || !date) return fail('no date in the heading')
  if (date < posted || date > addDays(posted, 2)) fail(`the date ${date} doesn't fit a post of ${posted}`)
  const rest = head.slice(d.index + d[0].length)

  if (first === -1) {
    if (whole) fail('no list under the heading')
    return applyProse(days, date, rest, postedAt, p.url)
  }
  const listed = readBlocks(lines.slice(first), fail)
  const from = whole ? null : FROM.exec(rest)
  // hours said some other way ("… на 17 ЛИСТОПАДА: з 10:00 до 16:00", "у період з …") are the
  // part of the day the list is for: read as the whole day, the list would wipe the rest
  if (!whole && CLOCK_ANYWHERE.test(`${head.slice(0, d.index)} ${rest.slice(from?.[0].length ?? 0)}`))
    return fail('hours in the heading in an unknown wording')
  const start = from ? parseClock(from[1]!) : 0
  const end = from?.[2] ? parseClock(from[2]) : 1440
  if (start === null || end === null || !(start < end)) return fail(`unexpected hours "${from?.[0]}"`)

  const before = days.get(date)?.groups
  const groups: Record<GroupId, MinuteSlot[] | null> = {}
  for (const g of CEK_GROUPS) {
    const now = listed[g] ?? []
    if (start === 0 && end === 1440) groups[g] = now
    else {
      const was = before?.[g]
      // without the hours before the window the day isn't known, unless they are over: a
      // change "з 10:00 до 24:00" is posted around 10:00
      if (was) groups[g] = [...outside(was, start, end), ...now]
      else groups[g] = end === 1440 && start <= minuteOf(date, postedAt) + 60 ? now : null
    }
  }
  days.set(date, { at: postedAt, url: p.url, groups })
}

/** "🔹 Черга 1.1" / "1.1", then its "HH:MM-HH:MM" lines, up to the closing "Попереджаємо, …" */
function readBlocks(lines: string[], fail: (what: string) => never): Record<GroupId, MinuteSlot[]> {
  const out: Record<GroupId, MinuteSlot[]> = {}
  let current: MinuteSlot[] | null = null
  for (const line of lines) {
    if (!line) continue
    if (/^Попереджаємо/i.test(line)) break
    const label = LABEL.exec(line)
    if (label) {
      const group = `${Number(label[1])}.${Number(label[2])}`
      if (!CEK_GROUPS.includes(group)) return fail(`unknown group "${line}"`)
      if (out[group]) return fail(`group ${group} is listed twice`)
      current = out[group] = []
      continue
    }
    const t = TIMES.exec(line)
    const start = t ? parseClock(t[1]!) : null
    // "20:00-00:00" ends at midnight
    const end = t ? parseClock(t[2]!) || 1440 : null
    if (!current || start === null || end === null || !(start < end)) return fail(`unexpected line "${line}"`)
    current.push({ start, end, kind: 'off' })
  }
  for (const [g, slots] of Object.entries(out)) if (!slots.length) fail(`group ${g} has no hours`)
  if (!Object.keys(out).length) fail('no groups in the list')
  return out
}

/** A change told in a sentence: applied when it is one window for named groups, else those groups are unknown. */
function applyProse(days: Map<string, CekDay>, date: string, rest: string, at: number, url: string): void {
  const day = days.get(date)
  // nothing known about the day yet: a change to it tells nothing either
  if (!day) return
  const groups = named(rest)
  const windows = [...rest.matchAll(WINDOWS)]
  // "з 18:00 до 22:00 не застосовуються відключення …", "скасовуються …": the opposite of an outage
  const negated = /(?<![\p{L}])(?:не|без)(?![\p{L}])|скасов|відмін/iu.test(
    rest.slice(0, rest.search(/Попереджаємо/i) === -1 ? undefined : rest.search(/Попереджаємо/i)),
  )
  const w = windows.length === 1 ? windows[0]! : null
  const start = w?.[1] ? parseClock(w[1]) : null
  const end = w?.[2] ? parseClock(w[2]) : null
  const exact =
    groups.length > 0 &&
    start !== null &&
    end !== null &&
    start < end &&
    !negated &&
    /додатково|відключаються|застосовуються\s+відк?лючення/i.test(rest)
  if (!exact) return setUnknown(days, date, groups.length ? groups : CEK_GROUPS, at, url)
  const next = { ...day.groups }
  for (const g of groups) if (next[g]) next[g] = [...next[g], { start: start, end: end, kind: 'off' }]
  days.set(date, { at, url, groups: next })
}

function setUnknown(
  days: Map<string, CekDay>,
  date: string,
  groups: readonly GroupId[],
  at: number,
  url: string,
): void {
  const day = days.get(date)
  if (!day) return
  const next = { ...day.groups }
  for (const g of groups) next[g] = null
  days.set(date, { at, url, groups: next })
}

/** The groups a sentence names ("черги 5.1, 5.2 ,6.1,6.2") */
const named = (text: string): GroupId[] => [
  ...new Set([...text.matchAll(GROUP)].map((m) => `${m[1]}.${m[2]}`).filter((g) => CEK_GROUPS.includes(g))),
]

/** The parts of the slots outside [start, end) */
function outside(slots: readonly MinuteSlot[], start: number, end: number): MinuteSlot[] {
  const out: MinuteSlot[] = []
  for (const s of slots) {
    if (s.start < start) out.push({ ...s, end: Math.min(s.end, start) })
    if (s.end > end) out.push({ ...s, start: Math.max(s.start, end) })
  }
  return out
}

/** Minutes from the midnight of `date` to the instant; negative the evening before */
const minuteOf = (date: string, at: number) =>
  kyivDate(new Date(at)) === date ? kyivMinuteOfDay(new Date(at)) : at < Date.parse(date) ? -1440 : 1440

/** The channel as a schedule source: today and later. Exported for tests. */
export function cekDaysToSource(days: ReadonlyMap<string, CekDay>, now: Date): SourceRead {
  const today = kyivDate(now)
  const out: SourceRead['days'] = {}
  let newest: CekDay | undefined
  for (const [date, day] of days) {
    if (date < today) continue
    const schedules: Record<GroupId, DaySchedule> = {}
    for (const g of CEK_GROUPS) {
      const slots = day.groups[g]
      schedules[g] = slots ? makeDay(date, slots) : { date, status: 'unknown', intervals: [] }
    }
    out[date] = { schedules, publishedAt: toKyivIso(new Date(day.at)) }
    if (!newest || day.at > newest.at) newest = day
  }
  return { days: out, groups: [...CEK_GROUPS], ...(newest ? { url: newest.url } : {}) }
}

/** @cek_info as a `mergeSources` channel. */
export function cekTelegramSource(): SourceSpec {
  return {
    id: `telegram:@${CEK_CHANNEL}`,
    url: `https://t.me/s/${CEK_CHANNEL}`,
    read: async (ctx) => {
      const now = ctx.now()
      // back to the list posted the evening before yesterday, which later changes build on
      const since = kyivInstant(addDays(kyivDate(now), -2), 12 * 60)
      const { posts } = await readChannelWindow(ctx, CEK_CHANNEL, {
        region: 'dnipro-cek',
        since,
        maxPages: 6,
      })
      return cekDaysToSource(parseCekPosts(posts, now), now)
    },
  }
}
