/**
 * Date and time-range helpers for the structured pages some operators publish (HTML tables:
 * Poltava's block headers, UZ's table headings and cells, Rivne's cells): "5 листопада 2026",
 * "05.11", "08:00 – 12:00". Free text (posts, news) is read by the text processor, not here.
 */
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
