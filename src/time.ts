/**
 * Kyiv time helpers without a timezone library. Grid operators publish local wall-clock
 * hours; DST (EET/EEST) means a day isn't always 24 h long, so offsets are computed per instant.
 */
export const KYIV_TZ = 'Europe/Kyiv'

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: KYIV_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallClock(date: Date): WallClock {
  const p: Record<string, number> = {}
  for (const { type, value } of partsFmt.formatToParts(date)) p[type] = Number(value)
  return {
    year: p.year!,
    month: p.month!,
    day: p.day!,
    hour: p.hour!,
    minute: p.minute!,
    second: p.second!,
  }
}

/** Kyiv UTC offset at an instant, in minutes (120 in winter, 180 in summer). */
export function kyivOffsetMinutes(date: Date): number {
  const w = wallClock(date)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000)
}

/** "YYYY-MM-DD" of the Kyiv calendar day containing `date`. */
export function kyivDate(date: Date = new Date()): string {
  const w = wallClock(date)
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`
}

/** Minutes since Kyiv midnight. */
export function kyivMinuteOfDay(date: Date): number {
  const w = wallClock(date)
  return w.hour * 60 + w.minute
}

/**
 * The instant at `minutes` past Kyiv midnight of `day` ("YYYY-MM-DD"). 1440 = next midnight.
 * Wall-clock minutes are mapped through the offset valid at that moment.
 */
export function kyivInstant(day: string, minutes: number): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const guess = Date.UTC(y, m - 1, d, 0, minutes)
  // the offset may differ between the guess and the real instant around DST changes
  let t = guess - kyivOffsetMinutes(new Date(guess)) * 60_000
  t = guess - kyivOffsetMinutes(new Date(t)) * 60_000
  return new Date(t)
}

/** ISO string with the Kyiv offset, e.g. "2026-11-05T08:00:00+02:00". */
export function toKyivIso(date: Date): string {
  const w = wallClock(date)
  const off = kyivOffsetMinutes(date)
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

/** "YYYY-MM-DD" shifted by whole days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** Parses "HH:MM", "H:MM", "HH.MM" or "24:00" into minutes of the day; null if invalid. */
export function parseClock(text: string): number | null {
  const m = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*$/.exec(text)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null
  return h * 60 + min
}

const pad = (n: number) => String(n).padStart(2, '0')
