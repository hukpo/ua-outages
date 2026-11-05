import { OutageError } from '../errors.js'
import { compareGroups, makeDay, normalizeGroup, type MinuteSlot } from '../schedule.js'
import { kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { DaySchedule, IntervalKind, RegionId, RegionSchedule } from '../types.js'

/**
 * The "ГПВ" hourly format shared by DTEK sites and several oblenergo:
 *
 * ```
 * { "<unix ts of Kyiv midnight>": { "GPV1.1": { "1": "yes", …, "24": "no" } } }
 * ```
 *
 * Cell values: `yes` on · `no` off · `first`/`second` off for the first/second half hour ·
 * `maybe` possibly off · `mfirst`/`msecond` possibly off for that half hour.
 */
export type GpvDays = Record<string, Record<string, Record<string, string>>> | unknown[]

const HALF: Record<string, [IntervalKind, 'all' | 'first' | 'second'] | undefined> = {
  no: ['off', 'all'],
  first: ['off', 'first'],
  second: ['off', 'second'],
  maybe: ['maybe', 'all'],
  mfirst: ['maybe', 'first'],
  msecond: ['maybe', 'second'],
}

/** One group's cells for a day → minute slots. Keys "1".."24" are hours; "1".."48" half-hours. */
export function gpvCellsToSlots(cells: Record<string, string>): MinuteSlot[] {
  const keys = Object.keys(cells).filter((k) => /^\d+$/.test(k))
  const size = keys.length > 24 ? 30 : 60
  const slots: MinuteSlot[] = []
  for (const k of keys) {
    const spec = HALF[String(cells[k]).toLowerCase()]
    if (!spec) continue
    const start = (Number(k) - 1) * size
    const [kind, part] = spec
    const half = size / 2
    if (part === 'all') slots.push({ start, end: start + size, kind })
    else if (part === 'first') slots.push({ start, end: start + half, kind })
    else slots.push({ start: start + half, end: start + size, kind })
  }
  return slots
}

/**
 * Converts the date-keyed GPV object into per-group days. An empty schedule may come as `[]`.
 * Keys are unix seconds of Kyiv midnight; dates are derived in Kyiv time (DST-safe).
 */
export function parseGpvDays(region: RegionId, data: GpvDays | null | undefined): Record<string, DaySchedule[]> {
  if (data == null || Array.isArray(data)) return {}
  if (typeof data !== 'object') throw new OutageError('parse', 'GPV: expected an object of days', { region })
  const out: Record<string, DaySchedule[]> = {}
  const dayKeys = Object.keys(data).sort((a, b) => Number(a) - Number(b))
  for (const ts of dayKeys) {
    const seconds = Number(ts)
    if (!Number.isFinite(seconds)) throw new OutageError('parse', `GPV: bad day key "${ts}"`, { region })
    // +1 h guards against a key that is midnight in a different offset
    const date = kyivDate(new Date(seconds * 1000 + 3600_000))
    const groups = (data as Record<string, Record<string, Record<string, string>>>)[ts] ?? {}
    for (const [rawGroup, cells] of Object.entries(groups)) {
      const group = normalizeGroup(rawGroup)
      if (!group || !cells || typeof cells !== 'object') continue
      ;(out[group] ??= []).push(makeDay(date, gpvCellsToSlots(cells)))
    }
  }
  return out
}

/** "05.11.2026 21:31" or "21:31 05.11.2026" (Kyiv local) → ISO; null when it doesn't parse. */
export function parseUaDateTime(text: string | null | undefined): string | null {
  if (!text) return null
  const d = /(\d{2})\.(\d{2})\.(\d{4})/.exec(text)
  const t = /(\d{1,2}):(\d{2})/.exec(text)
  if (!d) return null
  const minutes = t ? Number(t[1]) * 60 + Number(t[2]) : 0
  return toKyivIso(kyivInstant(`${d[3]}-${d[2]}-${d[1]}`, minutes))
}

export function gpvRegionSchedule(
  region: RegionId,
  data: GpvDays | null | undefined,
  updated: string | null | undefined,
  now: Date,
): RegionSchedule {
  const schedules = parseGpvDays(region, data)
  return {
    region,
    groups: Object.keys(schedules).sort(compareGroups),
    schedules,
    updatedAt: parseUaDateTime(updated),
    fetchedAt: toKyivIso(now),
  }
}
