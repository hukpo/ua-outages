import { OutageError } from '../errors.js'
import { compareGroups, makeDay, normalizeGroup, type MinuteSlot } from '../schedule.js'
import { parseClock, toKyivIso } from '../time.js'
import type { AddressQuery, DaySchedule, GroupId, GroupMatch, RegionInfo, RegionSchedule } from '../types.js'
import type { Provider, ProviderContext } from './provider.js'
import { parseUaDateTime } from './gpv.js'

/**
 * Prykarpattiaoblenergo (svitlo.oe.if.ua). The SPA talks to a small JSON backend: one schedule
 * request per group, and an address lookup that takes free text ("city,street,house") and
 * answers with the HTTP status: 200 one group, 300 several, 404 unknown address.
 * There is no street directory, so address search goes through `lookupAddress`.
 */
const API = 'https://be-svitlo.oe.if.ua'

const INFO: RegionInfo = {
  id: 'ivano-frankivsk',
  name: 'Івано-Франківська область',
  operator: 'Прикарпаттяобленерго',
  website: 'https://svitlo.oe.if.ua/',
  capabilities: { schedule: true, addressSearch: true },
}

/** The operator's twelve groups (also served by `/gpv-queue-list`, which never changes). */
const GROUPS: readonly GroupId[] = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2']

/** Parallel schedule requests; the backend is small, so stay polite. */
const CONCURRENCY = 4

/** One published day as `/schedule-by-queue` and `/schedule-by-search` return it. */
export interface IfScheduleDay {
  /** "DD.MM.YYYY", Kyiv */
  eventDate: string
  queues: Record<string, IfInterval[] | null | undefined>
  createdAt?: string
  scheduleApprovedSince?: string
}

interface IfInterval {
  from: string
  to: string
  /** 1 = scheduled outage, 0 = power on */
  status: number
}

interface SearchAnswer {
  current?: {
    queue?: string
    subQueue?: string
    hasQueue?: string
    possibleQueues?: string[]
    note?: string
  }
}

export function ivanoFrankivskProvider(): Provider {
  const region = INFO.id

  return {
    info: INFO,
    sampleAddress: { city: 'Івано-Франківськ', street: 'Галицька', house: '1' },

    async getSchedules(ctx) {
      const responses = await mapLimit(GROUPS, CONCURRENCY, (g) =>
        ctx.http.json<unknown>(`${API}/schedule-by-queue?queue=${g}`, { region }),
      )
      return parseQueueSchedules(responses, ctx.now())
    },

    async lookupAddress(ctx, address) {
      return lookup(ctx, address)
    },
  }

  async function lookup(ctx: ProviderContext, address: AddressQuery): Promise<GroupMatch> {
    if (!address.city)
      throw new OutageError('not-found', `${INFO.name}: specify a city or village`, { region })
    // the backend matches the triple literally (case-insensitive): "вул." or "м." break it
    const city = withoutTypes(address.city)
    const street = withoutTypes(address.street)
    const house = address.house.trim()
    const res = await ctx.http.raw(`${API}/schedule-by-search`, {
      region,
      method: 'POST',
      body: new URLSearchParams({ accountNumber: '', userSearchChoice: 'pob', address: `${city},${street},${house}` }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      // these statuses are answers: several groups / not found / not in any group
      acceptStatus: [204, 300, 404],
    })
    const where = `${address.house}, ${address.street}, ${address.city}`
    if (res.status === 404)
      throw new OutageError('not-found', `${INFO.operator} knows no address "${where}"`, { region, status: 404 })
    if (res.status === 204)
      throw new OutageError('not-found', `${where}: the address is not in any hourly-outage group`, { region, status: 204 })
    const match = parseSearchAnswer(res.body, res.status)
    return { region, ...match, address: { city, street, house } }
  }
}

/**
 * Merges the per-group responses. Each is a list of days; a day may list only the requested
 * group or all of them, so every group found in any response is used. Exported for tests.
 */
export function parseQueueSchedules(responses: readonly unknown[], now: Date): RegionSchedule {
  const region = INFO.id
  // date → group → day; a later row for the same date replaces an earlier one
  const byDate = new Map<string, Map<GroupId, DaySchedule>>()
  let updated: string | null = null

  for (const days of responses) {
    if (!Array.isArray(days))
      throw new OutageError('parse', 'Ivano-Frankivsk: expected a list of days', { region })
    for (const day of days as IfScheduleDay[]) {
      const date = parseDate(day?.eventDate)
      if (!date || !day.queues || typeof day.queues !== 'object')
        throw new OutageError('parse', `Ivano-Frankivsk: unexpected day ${JSON.stringify(day).slice(0, 120)}`, { region })
      const groups = byDate.get(date) ?? new Map<GroupId, DaySchedule>()
      byDate.set(date, groups)
      for (const [raw, intervals] of Object.entries(day.queues)) {
        const group = normalizeGroup(raw)
        if (!group) continue
        groups.set(group, toDay(date, intervals ?? []))
      }
      const stamp = parseUaDateTime(day.scheduleApprovedSince ?? day.createdAt)
      if (stamp && (!updated || Date.parse(stamp) > Date.parse(updated))) updated = stamp
    }
  }

  const dates = [...byDate.keys()].sort()
  if (!dates.length)
    return { region, groups: [], schedules: {}, updatedAt: null, fetchedAt: toKyivIso(now) }

  const groups = [...new Set([...GROUPS, ...dates.flatMap((d) => [...byDate.get(d)!.keys()])])].sort(compareGroups)
  const schedules: Record<GroupId, DaySchedule[]> = {}
  for (const g of groups)
    schedules[g] = dates.map((d) => byDate.get(d)!.get(g) ?? { date: d, status: 'unknown', intervals: [] })
  return { region, groups, schedules, updatedAt: updated, fetchedAt: toKyivIso(now) }
}

/** `/schedule-by-search` body → group(s). Exported for tests. */
export function parseSearchAnswer(body: string, status: number): { group: GroupId; otherGroups?: GroupId[] } {
  const region = INFO.id
  let data: SearchAnswer
  try {
    data = JSON.parse(body) as SearchAnswer
  } catch (cause) {
    throw new OutageError('parse', 'Ivano-Frankivsk address search: expected JSON', { region, cause })
  }
  const cur = data?.current
  if (!cur) throw new OutageError('parse', 'Ivano-Frankivsk address search: no "current" block', { region })

  // 300 = "the consumer may belong to several groups" (several connections at one address)
  if (status === 300 || cur.hasQueue === 'many') {
    const all = [...new Set((cur.possibleQueues ?? []).map((q) => normalizeGroup(q)).filter((g): g is GroupId => !!g))]
    if (!all.length) throw new OutageError('parse', 'Ivano-Frankivsk address search: several groups but none listed', { region })
    all.sort(compareGroups)
    return all.length > 1 ? { group: all[0]!, otherGroups: all.slice(1) } : { group: all[0]! }
  }
  const group = cur.queue && cur.subQueue ? normalizeGroup(`${cur.queue}.${cur.subQueue}`) : null
  if (!group)
    throw new OutageError('not-found', cur.note?.trim() || 'Ivano-Frankivsk: the operator returned no group', { region })
  return { group }
}

function toDay(date: string, intervals: readonly IfInterval[]): DaySchedule {
  const region = INFO.id
  if (!Array.isArray(intervals))
    throw new OutageError('parse', `Ivano-Frankivsk: intervals of ${date} are not a list`, { region })
  // an empty list on a published day = "no outages planned" for this group
  if (!intervals.length) return { date, status: 'no-outages', intervals: [] }
  const slots: MinuteSlot[] = []
  for (const i of intervals) {
    if (i.status === 0) continue
    const start = parseClock(i.from)
    let end = parseClock(i.to)
    if (start === null || end === null)
      throw new OutageError('parse', `Ivano-Frankivsk: bad interval ${i.from}-${i.to}`, { region })
    if (end === 1439 || end <= start) end = 1440 // "23:59" / "00:00" = end of day
    // status 1 is the only documented outage value; anything new is shown as possible
    slots.push({ start, end, kind: i.status === 1 ? 'off' : 'maybe' })
  }
  return makeDay(date, slots)
}

/** Address type words the backend doesn't expect ("м.", "вул.", …). */
const TYPE_RE =
  /(^|\s)(?:м|місто|с|село|смт|селище|с-ще|вул|вулиця|просп|проспект|пр-т|пров|провулок|бул|бульв|бульвар|пл|площа|наб|набережна)(?:\.|(?=\s|$))/giu

/** "вул. Галицька" → "Галицька"; also drops commas, which separate the address parts. Exported for tests. */
export function withoutTypes(text: string): string {
  return text.replace(/,/g, ' ').replace(TYPE_RE, ' ').replace(/\s+/g, ' ').trim()
}

function parseDate(text: unknown): string | null {
  const m = typeof text === 'string' ? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim()) : null
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
