/**
 * Shared by build-data.ts (the site) and relay.ts (a collector run in Ukraine): fetches one
 * region with the SDK and turns it into the compact form the page reads.
 */
import { kyivDate } from '../../src/index.js'
import type { DaySchedule, OutageClient, RegionId, RegionInfo } from '../../src/index.js'

/** Regions that answer from Ukraine but not from GitHub's runners (checked 2026-11-07) */
import { UZ_PAGES } from '../../src/providers/uz.js'
export const RELAYED: RegionId[] = [
  'kharkiv',
  'chernivtsi',
  'poltava',
  'zaporizhzhia',
  // uz.gov.ua doesn't answer from abroad either
  ...UZ_PAGES.map(([id]) => id),
]
/** Branch the relay publishes `relay.json` to */
export const RELAY_BRANCH = 'relay'

/** One group's day: status code and [startMin, endMin, kind] with kind 0 = off, 1 = maybe */
export interface CompactDay {
  s: 's' | 'n' | 'e' | 'u'
  i: [number, number, 0 | 1][]
}
/** date → group → day */
export type Days = Record<string, Record<string, CompactDay>>

export interface RegionEntry {
  id: RegionId
  name: string
  operator: string
  website: string
  ok: boolean
  /** The source failed this time; `days` come from an earlier run (`fetchedAt`) */
  stale?: boolean
  /** Collected by the relay in Ukraine, because the source refuses servers abroad */
  relayed?: boolean
  message?: string
  latencyMs: number
  updatedAt?: string | null
  fetchedAt?: string
  groups: string[]
  days?: Days
}

const STATUS = { scheduled: 's', 'no-outages': 'n', emergency: 'e', unknown: 'u' } as const

/** Wall-clock minutes of an ISO time inside `day`; the next midnight is 1440 */
function minutesIn(day: string, iso: string): number {
  if (iso.slice(0, 10) > day) return 1440
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16))
}

export const compact = (d: DaySchedule): CompactDay => ({
  s: STATUS[d.status],
  i: d.intervals.map((x) => [minutesIn(d.date, x.from), minutesIn(d.date, x.to), x.kind === 'off' ? 0 : 1]),
})

export const pick = (info: RegionInfo) => ({
  id: info.id,
  name: info.name,
  operator: info.operator,
  website: info.website,
})

/** Today's and later days of one region; never throws, a failure becomes `ok: false` */
export async function collect(client: OutageClient, info: RegionInfo, now: Date): Promise<RegionEntry> {
  const today = kyivDate(now)
  const started = performance.now()
  try {
    const s = await client.getSchedules(info.id, { fresh: true })
    const days: Days = {}
    for (const g of s.groups)
      for (const d of s.schedules[g] ?? []) if (d.date >= today) (days[d.date] ??= {})[g] = compact(d)
    return {
      ...pick(info),
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      updatedAt: s.updatedAt,
      fetchedAt: s.fetchedAt,
      groups: s.groups,
      days,
    }
  } catch (e) {
    return {
      ...pick(info),
      ok: false,
      message: (e as Error).message,
      latencyMs: Math.round(performance.now() - started),
      groups: [],
    }
  }
}

export function logEntry(r: RegionEntry): void {
  const tag = r.ok ? (r.stale ? 'stale' : r.relayed ? 'relay' : 'ok') : 'error'
  const what = r.ok ? `${r.groups.length} groups` : r.message
  console.log(
    `${tag.padEnd(5)} ${r.id.padEnd(16)} ${what}  ${r.latencyMs} ms${r.stale || r.relayed ? `  (fetched ${r.fetchedAt})` : ''}`,
  )
}
