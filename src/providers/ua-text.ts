/**
 * Parsing helpers for schedules that operators publish as Ukrainian prose:
 * "5 листопада 2026 року", "1.1: 08:00 – 12:00, 18:00 – 22:00",
 * "Група 1.1. Електроенергії немає з 08:00 до 12:00".
 */
import { normalizeGroup, type MinuteSlot } from '../schedule.js'
import { kyivDate, parseClock } from '../time.js'

const MONTHS: Record<string, number> = {
  січня: 1,
  лютого: 2,
  березня: 3,
  квітня: 4,
  травня: 5,
  червня: 6,
  липня: 7,
  серпня: 8,
  вересня: 9,
  жовтня: 10,
  листопада: 11,
  грудня: 12,
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * First date in the text: "5 листопада 2026", "05 листопада", "05.11.2026", "05.11".
 * Without a year, picks the one that puts the date closest to `now` (schedules are for
 * yesterday … tomorrow, so 31 грудня read on 1 січня belongs to last year).
 */
export function findUaDate(text: string, now: Date): string | null {
  const lower = text.toLowerCase()
  const named = new RegExp(`(\\d{1,2})\\s+(${Object.keys(MONTHS).join('|')})(?:\\s+(\\d{4}))?`).exec(lower)
  // two-digit month only: "3.1" is a group, not 3 January; skip impossible ones like "21.25"
  const numeric = [...lower.matchAll(/\b(\d{1,2})\.(\d{2})(?:\.(\d{4}))?\b/g)].find(
    (m) => Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 1 && Number(m[1]) <= 31,
  )
  const pickFirst =
    named && numeric
      ? named.index <= numeric.index
        ? 'named'
        : 'numeric'
      : named
        ? 'named'
        : numeric
          ? 'numeric'
          : null
  if (!pickFirst) return null
  const [day, month, year] =
    pickFirst === 'named'
      ? [Number(named![1]), MONTHS[named![2]!]!, named![3] ? Number(named![3]) : null]
      : [Number(numeric![1]), Number(numeric![2]), numeric![3] ? Number(numeric![3]) : null]
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (year) return `${year}-${pad(month)}-${pad(day)}`
  const today = kyivDate(now)
  const y = Number(today.slice(0, 4))
  const candidates = [y - 1, y, y + 1].map((yy) => `${yy}-${pad(month)}-${pad(day)}`)
  const t = Date.parse(today)
  return candidates.sort((a, b) => Math.abs(Date.parse(a) - t) - Math.abs(Date.parse(b) - t))[0]!
}

/**
 * Every date in the text, in the order they stand, each with where it starts. A "DD.MM" that
 * stands as a clock time in a range ("з 18.11 до 20.00") is left out; one with a year never is.
 */
export function findUaDates(text: string, now: Date): { date: string; index: number }[] {
  const lower = text.toLowerCase()
  const out: { date: string; index: number }[] = []
  const add = (index: number, part: string) => {
    const date = findUaDate(part, now)
    if (date && isRealDate(date)) out.push({ date, index })
  }
  for (const m of lower.matchAll(
    new RegExp(`(\\d{1,2})\\s+(${Object.keys(MONTHS).join('|')})(?:\\s+(\\d{4}))?`, 'g'),
  ))
    add(m.index, m[0])
  for (const m of lower.matchAll(/\b(\d{1,2})\.(\d{2})(?:\.(\d{4}))?\b/g)) {
    if (!m[3]) {
      const before = lower.slice(0, m.index)
      const after = lower.slice(m.index + m[0].length)
      if (
        /(?<!\p{L})(?:з|до|по|об?)\s*$/u.test(before) ||
        /^\s*(?:[-–—−]|до(?!\p{L})|по(?!\p{L})|год)/u.test(after)
      )
        continue
    }
    add(m.index, m[0])
  }
  return out.sort((a, b) => a.index - b.index)
}

/** A real calendar date ("31 листопада" is none) */
const isRealDate = (date: string) => {
  const t = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === date
}

const TIME = String.raw`(\d{1,2}[:.]\d{2})`
const RANGE_RE = new RegExp(`(?:з\\s*)?${TIME}\\s*(?:[-–—−]|до|по)\\s*${TIME}`, 'gi')

/** Every "HH:MM–HH:MM" / "з HH:MM до HH:MM" in the text, as minutes. "23:59" counts as midnight. */
export function findTimeRanges(text: string): [number, number][] {
  const out: [number, number][] = []
  for (const m of text.matchAll(RANGE_RE)) {
    const a = parseClock(m[1]!)
    let b = parseClock(m[2]!)
    if (a === null || b === null) continue
    if (b === 1439) b = 1440
    // "22:00 – 00:00" ends at midnight
    if (b === 0) b = 1440
    // an overnight range "23:00 – 02:00" only covers this day up to midnight
    if (b <= a) b = 1440
    out.push([a, b])
  }
  return out
}

/** A group line without times that says the power stays on ("Група 2.1. Електроенергія є.") */
const POWER_ON =
  /електроенергі[яї]\s+є|світло\s+є|без\s+відключень|відключен\S*\s+не\s+(?:передбачен|планує|застосов)/i

/**
 * Lines like "1.1 00:00-03:00; 08:00-13:30", "1.1: 12:00 – 17:00", "Група 1.1. … з 08:00 до 12:00"
 * → group → off slots. A group mentioned with no times gets `[]` only when the line says the
 * power stays on ("Електроенергія є"); otherwise ("1.1: графік уточнюється") it gets `null`:
 * named, but its schedule is not known. Lines that name several groups ("Групи 1.1, 1.2: …")
 * apply the times to each.
 */
export function parseGroupLines(
  text: string,
  kind: 'off' | 'maybe' = 'off',
): Record<string, MinuteSlot[] | null> {
  const out: Record<string, MinuteSlot[] | null> = {}
  for (const rawLine of text.split(/\n|<br\s*\/?>|<\/p>|<\/li>|<\/div>/i)) {
    const line = rawLine
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .trim()
    if (!line) continue
    // group tokens before the first time range: "1.1", "1.1.", "Черга 1.1", "Групи 1.1, 1.2".
    // Subgroups are 1 or 2, so "в обсязі 2.5 черги" is not a group.
    const firstTime = line.search(/\d{1,2}[:.]\d{2}\s*(?:[-–—−]|до|по)/)
    const head = firstTime === -1 ? line : line.slice(0, firstTime)
    const groups = [...head.matchAll(/(?<![\d:.])(\d{1,2})\s*[.,]\s*([12])(?!\d)/g)]
      .map((m) => normalizeGroup(`${m[1]}.${m[2]}`))
      .filter((g): g is string => !!g)
    if (!groups.length) continue
    const ranges = firstTime === -1 ? [] : findTimeRanges(line.slice(firstTime))
    const known = ranges.length > 0 || POWER_ON.test(line)
    for (const g of groups) {
      if (!known) {
        if (!(g in out)) out[g] = null
        continue
      }
      const list = (out[g] ??= [])
      for (const [start, end] of ranges) list.push({ start, end, kind })
    }
  }
  return out
}

/**
 * Card layouts, where a group stands on its own line and its times follow on the next lines:
 *
 * ```
 * 1.1
 * 00:00 - 02:30
 * 09:30 - 16:30
 * ```
 *
 * Also accepts "1.1: 00:00-02:30, 09:30-16:30" on one line.
 */
export function parseGroupBlocks(text: string, kind: 'off' | 'maybe' = 'off'): Record<string, MinuteSlot[]> {
  const out: Record<string, MinuteSlot[]> = {}
  let current: string | null = null
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const firstTime = line.search(/\d{1,2}[:.]\d{2}\s*(?:[-–—−]|до|по)/)
    const head = firstTime === -1 ? line : line.slice(0, firstTime)
    const group = /(?<![\d:.])(\d{1,2})\s*[.,]\s*([12])(?!\d)/.exec(head)
    if (group) {
      current = normalizeGroup(`${group[1]}.${group[2]}`)
      if (current) out[current] ??= []
    }
    if (firstTime === -1 || !current) continue
    for (const [start, end] of findTimeRanges(line.slice(firstTime))) out[current]!.push({ start, end, kind })
  }
  return out
}

const GROUP_TOKEN = /(?<![\d:.])(\d{1,2})\s*[.,]\s*([12])(?!\d)/g
const FIRST_TIME = /\d{1,2}[:.]\d{2}\s*(?:[-–—−]|до|по)/

/** A line that holds time ranges and nothing else: "з 10:00 до 15:00", "00:00 - 02:30, 09:30 - 16:30" */
function onlyRanges(line: string): boolean {
  const rest = line.replace(RANGE_RE, '')
  return rest !== line && !/[\p{L}\d]/u.test(rest.replace(/(?<!\p{L})(?:та|і|й)(?!\p{L})/giu, ''))
}

/** A clock time, "з 7" / "до 22", or bare hours "19-22": a time outside any full range */
const LOOSE_TIME = /\d{1,2}[:.]\d{2}|(?<!\p{L})(?:з|до|по)\s+\d|\d{1,2}\s*[-–—−]\s*\d{1,2}(?![\d:.])/iu

/** A line of times and nothing else where not all of it is full ranges: "з 21:30", "до 06:00" */
function onlyTimes(line: string): boolean {
  const rest = line.replace(RANGE_RE, ' ')
  return (
    LOOSE_TIME.test(rest) &&
    !/\p{L}/u.test(rest.replace(/(?<!\p{L})(?:з|до|по|та|і|й|год\p{L}*)(?!\p{L})/giu, ''))
  )
}

/** A line that only names groups: "⚡ Черга 1.1", "Підчерги 1.1, 1.2:" */
function bareGroupHeader(line: string): boolean {
  return !/\p{L}/u.test(line.replace(GROUP_TOKEN, '').replace(/(?:під)?черг\p{L}*|груп\p{L}*/giu, ''))
}

/**
 * A whole announcement → group → off slots: the lines `parseGroupLines` reads, and blocks where
 * a group stands alone on its line with its times on the lines below:
 *
 * ```
 * ⚡ Черга 1.1
 * з 10:00 до 15:00
 * з 23:30 до 24:00
 * ```
 *
 * Stricter than `parseGroupBlocks`: a block ends at the first line that isn't only time ranges,
 * so a sentence after the last group ("Також з 00:00 до 24:00 діятимуть ГОП") adds nothing to
 * it. A group that gets times in two places (two days in one post) is `null`, not their union.
 */
export function parseGroupPost(
  text: string,
  kind: 'off' | 'maybe' = 'off',
): Record<string, MinuteSlot[] | null> {
  const out: Record<string, MinuteSlot[] | null> = {}
  const twice = new Set<string>()
  /** Groups of the open block, when the last group line was a bare header */
  let block: string[] | null = null
  const add = (g: string, ranges: [number, number][], fresh: boolean) => {
    // times in a second place: which of the two is meant can't be told
    if (fresh && out[g]) twice.add(g)
    const list = (out[g] ??= [])
    for (const [start, end] of ranges) list.push({ start, end, kind })
  }
  /** Named, with times that can't be read exactly: not known, whatever else the post says */
  const unread = (g: string) => {
    out[g] ??= null
    twice.add(g)
  }
  for (const rawLine of text.split(/\n|<br\s*\/?>|<\/p>|<\/li>|<\/div>|<\/tr>/i)) {
    const line = rawLine
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .trim()
    if (!line) continue
    const firstTime = line.search(FIRST_TIME)
    const head = firstTime === -1 ? line : line.slice(0, firstTime)
    const groups = [...head.matchAll(GROUP_TOKEN)]
      .map((m) => normalizeGroup(`${m[1]}.${m[2]}`))
      .filter((g): g is string => !!g)
    if (!groups.length) {
      if (block && onlyRanges(line)) {
        const ranges = findTimeRanges(line)
        for (const g of block) add(g, ranges, false)
      } else {
        // "з 21:30" under a group: one of its times, and not one that can be read
        if (block && onlyTimes(line)) for (const g of block) unread(g)
        block = null
      }
      continue
    }
    const tail = firstTime === -1 ? '' : line.slice(firstTime)
    const ranges = findTimeRanges(tail)
    // what the ranges leave over: a time that is half a range ("до 12:00, 18:00-22:00",
    // "… та з 21:30", "19-22") or another group with its own times ("1.1 – …; 1.2 – …")
    const left = tail.replace(RANGE_RE, ' ')
    const others = [...left.matchAll(GROUP_TOKEN)]
      .map((m) => normalizeGroup(`${m[1]}.${m[2]}`))
      .filter((g): g is string => !!g)
    if (others.length || /\d{1,2}:\d{2}/.test(head) || LOOSE_TIME.test(left.replace(GROUP_TOKEN, ' '))) {
      for (const g of [...groups, ...others]) unread(g)
      block = null
      continue
    }
    const known = ranges.length > 0 || POWER_ON.test(line)
    block = !known && bareGroupHeader(line) ? groups : null
    for (const g of groups) {
      if (known) add(g, ranges, true)
      else if (block && out[g]) twice.add(g)
      else if (!(g in out)) out[g] = null
    }
  }
  for (const g of twice) out[g] = null
  return out
}
