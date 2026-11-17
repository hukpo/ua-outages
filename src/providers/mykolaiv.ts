import { emergencyQueues } from '../emergency/queues.js'
import { OutageError } from '../errors.js'
import { compareGroups, makeDay, unpublished, type MinuteSlot } from '../schedule.js'
import { kyivDate, toKyivIso } from '../time.js'
import type { City, DaySchedule, GroupMatch, ProviderInfo, RegionSchedule } from '../types.js'
import { asSource } from './as-source.js'
import { sharedList, type Provider, type ProviderContext } from './provider.js'
import { mergeSources } from './sources.js'

/**
 * Mykolaivoblenergo (off.energy.mk.ua): a JSON API with 48 half-hour slots per day and a full
 * address chain district → settlement → street → house → queue.
 */
const BASE = 'https://off.energy.mk.ua/api'
/** `outageType.id`: 1 ГАВ, 2 СГАВ, 3 ГПВ */
const GAV_TYPE = 1
const SGAV_TYPE = 2
const GPV_TYPE = 3

const DIRECTORY_TTL_MS = 24 * 3_600_000

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

/** `ENABLE` is what the operator's own page shows for a slot with power */
const KIND: Record<string, 'off' | 'maybe' | null | undefined> = {
  OFF: 'off',
  SURE_OFF: 'off',
  PROBABLY_OFF: 'maybe',
  ENABLE: null,
}

const INFO: ProviderInfo = {
  id: 'mykolaiv',
  name: 'Миколаївська область',
  operator: 'Миколаївобленерго',
  website: 'https://off.energy.mk.ua/',
  capabilities: { schedule: true, addressSearch: true },
}

export function mykolaivProvider(): Provider {
  const region = INFO.id

  const get = <T>(ctx: ProviderContext, path: string) => ctx.http.json<T>(`${BASE}${path}`, { region })
  const list = async <T>(ctx: ProviderContext, path: string) => {
    const data = await get<T[]>(ctx, path)
    if (!Array.isArray(data)) throw new OutageError('parse', `Mykolaiv ${path}: expected a list`, { region })
    return data
  }

  // static lists: kept for a day, and loaded on a signal of their own
  const settlements = sharedList(DIRECTORY_TTL_MS, async (ctx): Promise<City[]> => {
    const filii = await list<{ idfilial: number; fullname: string }>(ctx, '/addr/filii')
    const per = await Promise.all(
      filii.map(async (f) =>
        (await list<{ idnaspunkt: number; naznaspunkt: string }>(ctx, `/addr/filii/${f.idfilial}/ns`)).map(
          (n) => ({
            id: String(n.idnaspunkt),
            name: n.naznaspunkt.trim(),
            district: f.fullname.trim(),
          }),
        ),
      ),
    )
    return per.flat()
  })

  return {
    info: INFO,
    sampleAddress: { city: 'Миколаїв', street: 'вул. Соборна', house: '1' },

    getSchedules(ctx) {
      // the API is the only channel (the operator's Telegram has the same list 2 minutes earlier)
      return mergeSources(ctx, region, [
        {
          id: 'api',
          url: INFO.website,
          read: async () => {
            const [slots, queues, active] = await Promise.all([
              list<Slot>(ctx, '/schedule/time-series'),
              list<Queue>(ctx, `/outage-queue/by-type/${GPV_TYPE}`),
              list<ActiveDay>(ctx, '/v2/schedule/active'),
            ])
            return asSource(parseActive(slots, queues, active, ctx.now()))
          },
        },
      ])
    },

    async searchCities(ctx) {
      return settlements(ctx)
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
      const streets = await list<{ idstreet: number; nazstreet: string }>(ctx, `/addr/ns/${city.id}/street`)
      return streets.map((s) => ({ id: String(s.idstreet), name: s.nazstreet.trim(), cityId: city.id }))
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
      const of = (type: number) =>
        rows.filter((r) => r.outage?.type_id === type).map((r) => r.outage!.name.trim())
      const gpv = of(GPV_TYPE)
      // ГАВ names are "1".."10" and the reserve "1(Р)".."10(Р)"
      const emergency = emergencyQueues({ gav: of(GAV_TYPE), sgav: of(SGAV_TYPE) })
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
        ...(emergency ? { emergency } : {}),
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
      const group = nameOf.get(row.outage_queue_id)
      // queues of the other schedules (ГАВ, СГАВ) are not this one's rows
      if (!group) continue
      const kind = KIND[row.type]
      const start = startOf.get(row.time_series_id)
      // a row this reader doesn't understand is reported, never dropped: dropping it reads as "on"
      if (kind === undefined)
        throw new OutageError('parse', `Mykolaiv: unknown slot type "${row.type}" for queue ${group}`, {
          region,
        })
      if (start === undefined)
        throw new OutageError(
          'parse',
          `Mykolaiv: queue ${group} names a time slot (${row.time_series_id}) that is not in the list`,
          { region },
        )
      if (!kind) continue
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
  // no active day: nothing published, which is not "no outages"
  if (!dates.length) return unpublished(region, groups, now)
  for (const g of groups) schedules[g] = dates.map((d) => makeDay(d, byDate.get(d)!.get(g) ?? []))

  return {
    region,
    groups,
    schedules,
    updatedAt: updated ? toKyivIso(new Date(updated)) : null,
    fetchedAt: toKyivIso(now),
  }
}
