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
  const pickFirst = named && numeric ? (named.index <= numeric.index ? 'named' : 'numeric') : named ? 'named' : numeric ? 'numeric' : null
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

/**
 * Lines like "1.1 00:00-03:00; 08:00-13:30", "1.1: 12:00 – 17:00", "Група 1.1. … з 08:00 до 12:00"
 * → group → off slots. A group mentioned with no times (e.g. "Електроенергія є") gets `[]`.
 * Lines that name several groups ("Групи 1.1, 1.2: …") apply the times to each.
 */
export function parseGroupLines(text: string, kind: 'off' | 'maybe' = 'off'): Record<string, MinuteSlot[]> {
  const out: Record<string, MinuteSlot[]> = {}
  for (const rawLine of text.split(/\n|<br\s*\/?>|<\/p>|<\/li>|<\/div>/i)) {
    const line = rawLine.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim()
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
    for (const g of groups) {
      const list = (out[g] ??= [])
      for (const [start, end] of ranges) list.push({ start, end, kind })
    }
  }
  return out
}
