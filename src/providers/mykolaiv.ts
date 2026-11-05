import { OutageError } from '../errors.js'
import { compareGroups, makeDay, type MinuteSlot } from '../schedule.js'
import { kyivDate, toKyivIso } from '../time.js'
import { matchScore } from '../text.js'
import type { City, DaySchedule, GroupMatch, RegionInfo, RegionSchedule } from '../types.js'
import type { Provider, ProviderContext } from './provider.js'

/**
 * Mykolaivoblenergo (off.energy.mk.ua): a JSON API with 48 half-hour slots per day and a full
 * address chain district → settlement → street → house → queue.
 */
const BASE = 'https://off.energy.mk.ua/api'
const GPV_TYPE = 3

interface Slot {
  id: number
  start: string
}
interface Queue {
  id: number
  name: string
}
interface ActiveDay {
  from: string
  series: { time_series_id: number; outage_queue_id: number; type: string; updated_at?: string }[]
}

const KIND: Record<string, 'off' | 'maybe' | undefined> = {
  OFF: 'off',
  SURE_OFF: 'off',
  PROBABLY_OFF: 'maybe',
}

const INFO: RegionInfo = {
  id: 'mykolaiv',
  name: 'Миколаївська область',
  operator: 'Миколаївобленерго',
  website: 'https://off.energy.mk.ua/',
  capabilities: { schedule: true, addressSearch: true },
}

export function mykolaivProvider(): Provider {
  const region = INFO.id
  // static lists: fetched once per provider instance
  let settlements: Promise<City[]> | null = null

  const get = <T>(ctx: ProviderContext, path: string) => ctx.http.json<T>(`${BASE}${path}`, { region })
  const list = async <T>(ctx: ProviderContext, path: string) => {
    const data = await get<T[]>(ctx, path)
    if (!Array.isArray(data)) throw new OutageError('parse', `Mykolaiv ${path}: expected a list`, { region })
    return data
  }

  return {
    info: INFO,
    sampleAddress: { city: 'Миколаїв', street: 'вул. Соборна', house: '1' },

    async getSchedules(ctx) {
      const [slots, queues, active] = await Promise.all([
        list<Slot>(ctx, '/schedule/time-series'),
        list<Queue>(ctx, `/outage-queue/by-type/${GPV_TYPE}`),
        list<ActiveDay>(ctx, '/v2/schedule/active'),
      ])
      return parseActive(slots, queues, active, ctx.now())
    },

    async searchCities(ctx, query) {
      settlements ??= (async () => {
        const filii = await list<{ idfilial: number; fullname: string }>(ctx, '/addr/filii')
        const per = await Promise.all(
          filii.map(async (f) =>
            (
              await list<{ idnaspunkt: number; naznaspunkt: string }>(ctx, `/addr/filii/${f.idfilial}/ns`)
            ).map((n) => ({
              id: String(n.idnaspunkt),
              name: n.naznaspunkt.trim(),
              district: f.fullname.trim(),
            })),
          ),
        )
        return per.flat()
      })().catch((e) => {
        settlements = null
        throw e
      })
      const all = await settlements
      return all.filter((c) => matchScore(query, c.name, 'settlement') > 0)
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
      const streets = await list<{ idstreet: number; nazstreet: string }>(ctx, `/addr/ns/${city.id}/street`)
      return streets
        .map((s) => ({ id: String(s.idstreet), name: s.nazstreet.trim(), cityId: city.id }))
        .filter((s) => matchScore(query, s.name) > 0)
    },

    async searchHouses(ctx, street) {
      const houses = await list<{ iddom: number; nazdom: string }>(ctx, `/addr/street/${street.id}/dom`)
      return houses.map((h) => ({ id: String(h.iddom), number: h.nazdom.trim(), streetId: street.id }))
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      const rows = await list<{ outage?: { name: string; type_id: number } }>(
        ctx,
        `/addr/dom/${house.id}/outage-queue`,
      )
      const gpv = rows.filter((r) => r.outage?.type_id === GPV_TYPE).map((r) => r.outage!.name.trim())
      if (!gpv.length)
        throw new OutageError(
          'not-found',
          `${house.number}, ${street.name}: the operator has no group for this house`,
          {
            region,
          },
        )
      return {
        region,
        group: gpv[0]!,
        ...(gpv.length > 1 ? { otherGroups: gpv.slice(1) } : {}),
        address: { city: city?.name, street: street.name, house: house.number },
      }
    },
  }
}

/** Exported for tests. */
export function parseActive(slots: Slot[], queues: Queue[], active: ActiveDay[], now: Date): RegionSchedule {
  const region = INFO.id
  const startOf = new Map<number, number>()
  for (const s of slots) {
    const m = /^(\d{2}):(\d{2})/.exec(s.start)
    if (m) startOf.set(s.id, Number(m[1]) * 60 + Number(m[2]))
  }
  if (startOf.size !== 48)
    throw new OutageError('parse', `Mykolaiv time-series: expected 48 slots, got ${startOf.size}`, { region })
  const nameOf = new Map(queues.map((q) => [q.id, q.name.trim()]))

  // several day objects can share one Kyiv date: concatenate their series
  const byDate = new Map<string, Map<string, MinuteSlot[]>>()
  let updated = 0
  for (const day of active) {
    const date = kyivDate(new Date(day.from))
    const groups = byDate.get(date) ?? new Map<string, MinuteSlot[]>()
    byDate.set(date, groups)
    for (const row of day.series ?? []) {
      const kind = KIND[row.type]
      const group = nameOf.get(row.outage_queue_id)
      const start = startOf.get(row.time_series_id)
      if (!kind || !group || start === undefined) continue
      const list = groups.get(group) ?? []
      list.push({ start, end: start + 30, kind })
      groups.set(group, list)
      const u = row.updated_at ? Date.parse(row.updated_at) : NaN
      if (Number.isFinite(u) && u > updated) updated = u
    }
  }

  const groups = [...nameOf.values()].sort(compareGroups)
  const schedules: Record<string, DaySchedule[]> = {}
  const dates = [...byDate.keys()].sort()
  for (const g of groups) schedules[g] = dates.map((d) => makeDay(d, byDate.get(d)!.get(g) ?? []))

  return {
    region,
    groups: dates.length ? groups : [],
    schedules: dates.length ? schedules : {},
    updatedAt: updated ? toKyivIso(new Date(updated)) : null,
    fetchedAt: toKyivIso(now),
  }
}
