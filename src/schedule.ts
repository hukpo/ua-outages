import { kyivDate, kyivInstant, toKyivIso } from './time.js'
import type { DaySchedule, DayStatus, GroupId, Interval, IntervalKind } from './types.js'

/** A span inside one day, in minutes from Kyiv midnight (end may be 1440). */
export interface MinuteSlot {
  start: number
  end: number
  kind: IntervalKind
}

/**
 * Turns minute slots of one day into sorted, merged intervals.
 * Overlaps resolve to the stronger kind (`off` beats `maybe`).
 */
export function slotsToIntervals(day: string, slots: readonly MinuteSlot[]): Interval[] {
  const off = new Uint8Array(1440) // 0 none, 1 maybe, 2 off
  for (const s of slots) {
    const a = clamp(Math.floor(s.start))
    const b = clamp(Math.ceil(s.end))
    const v = s.kind === 'off' ? 2 : 1
    for (let i = a; i < b; i++) if (off[i]! < v) off[i] = v
  }
  const out: Interval[] = []
  let i = 0
  while (i < 1440) {
    const v = off[i]!
    if (v === 0) {
      i++
      continue
    }
    let j = i
    while (j < 1440 && off[j] === v) j++
    out.push({
      from: toKyivIso(kyivInstant(day, i)),
      to: toKyivIso(kyivInstant(day, j)),
      kind: v === 2 ? 'off' : 'maybe',
    })
    i = j
  }
  return out
}

/**
 * Builds a day from equal-length cells (24 hourly or 48 half-hourly), as many operators publish.
 * `null` = power on.
 */
export function cellsToIntervals(day: string, cells: readonly (IntervalKind | null)[]): Interval[] {
  const size = 1440 / cells.length
  const slots: MinuteSlot[] = []
  cells.forEach((kind, i) => {
    if (kind) slots.push({ start: i * size, end: (i + 1) * size, kind })
  })
  return slotsToIntervals(day, slots)
}

export function makeDay(day: string, slots: readonly MinuteSlot[], status?: DayStatus): DaySchedule {
  const intervals = slotsToIntervals(day, slots)
  return { date: day, status: status ?? 'scheduled', intervals }
}

/**
 * Normalizes how operators name groups: "GPV1.1", "1.1", "Черга 1.1", "1 черга 2 підчерга",
 * "Група 3.2", "4" → "1.1", "1.1", "1.1", "1.2", "3.2", "4". Returns null if there's no number.
 */
export function normalizeGroup(raw: string): GroupId | null {
  const s = raw.toLowerCase()
  const sub = /(\d+)\s*(?:черга|queue)?\D{0,12}?(\d+)\s*під/.exec(s)
  if (sub) return `${Number(sub[1])}.${Number(sub[2])}`
  const m = /(\d+)\s*[.,_-]\s*(\d+)/.exec(s) ?? /(\d+)/.exec(s)
  if (!m) return null
  return m[2] === undefined ? String(Number(m[1])) : `${Number(m[1])}.${Number(m[2])}`
}

/** Sorts "1.1" < "1.2" < "2.1" < "10.1". */
export function compareGroups(a: GroupId, b: GroupId): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

// --- public helpers that answer "what does this mean for me now?" ---

export type PowerState = 'on' | 'off' | 'maybe' | 'unknown'

/** Power state at an instant according to the schedule. `unknown` if the day isn't covered. */
export function stateAt(days: readonly DaySchedule[], at: Date = new Date()): PowerState {
  const day = days.find((d) => d.date === kyivDate(at))
  if (!day || day.status === 'unknown' || day.status === 'emergency') return 'unknown'
  const t = at.getTime()
  const hit = day.intervals.find((i) => Date.parse(i.from) <= t && t < Date.parse(i.to))
  return hit ? hit.kind : 'on'
}

/** The interval covering `at`, if any. */
export function intervalAt(days: readonly DaySchedule[], at: Date = new Date()): Interval | null {
  const t = at.getTime()
  for (const d of days)
    for (const i of d.intervals) if (Date.parse(i.from) <= t && t < Date.parse(i.to)) return i
  return null
}

/**
 * The next outage starting after `from` (or the current one if `includeCurrent`).
 * Adjacent intervals across midnight are merged, so an outage 22:00–02:00 comes back whole.
 */
export function nextOutage(
  days: readonly DaySchedule[],
  from: Date = new Date(),
  opts: { kinds?: IntervalKind[]; includeCurrent?: boolean } = {},
): Interval | null {
  const kinds = opts.kinds ?? ['off']
  const all = mergeAdjacent(days.flatMap((d) => d.intervals).filter((i) => kinds.includes(i.kind)))
  const t = from.getTime()
  return all.find((i) => (opts.includeCurrent ? Date.parse(i.to) > t : Date.parse(i.from) > t)) ?? null
}

/** Total scheduled minutes of a kind on a day. */
export function minutesOf(day: DaySchedule, kind: IntervalKind = 'off'): number {
  return day.intervals
    .filter((i) => i.kind === kind)
    .reduce((sum, i) => sum + (Date.parse(i.to) - Date.parse(i.from)) / 60_000, 0)
}

function mergeAdjacent(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => Date.parse(a.from) - Date.parse(b.from))
  const out: Interval[] = []
  for (const i of sorted) {
    const last = out[out.length - 1]
    if (last && last.kind === i.kind && Date.parse(last.to) >= Date.parse(i.from)) {
      if (Date.parse(i.to) > Date.parse(last.to)) last.to = i.to
    } else out.push({ ...i })
  }
  return out
}

const clamp = (n: number) => Math.min(1440, Math.max(0, n))
