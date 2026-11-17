import { emergencyQueues } from '../emergency/queues.js'
import { isEmergencyRow, MK_FEED, type MkOutageRow } from '../emergency/sources.js'
import { OutageError } from '../errors.js'
import { compareGroups, makeDay, unpublished, type MinuteSlot } from '../schedule.js'
import { kyivDate, toKyivIso } from '../time.js'
import type {
  City,
  DaySchedule,
  GroupMatch,
  HouseOutage,
  HouseOutageKind,
  ProviderInfo,
  RegionSchedule,
} from '../types.js'
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

/** A house's rows of the outage feed are read once per this */
const FEED_TTL_MS = 5 * 60_000
/** `fresh` still takes what the same call has just read */
const FRESH_TTL_MS = 15_000
/** How far back a house's rows are asked for: an outage that started earlier is not seen */
const FEED_LOOKBACK_MS = 7 * 24 * 3_600_000
const FEED_PER_PAGE = 100

export function mykolaivProvider(): Provider {
  const region = INFO.id
  const feedCache = new Map<string, { at: number; rows: Promise<MkOutageRow[]> }>()

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

    async outageOf(ctx, house, street, city): Promise<HouseOutage | null> {
      const key = house.id
      const hit = feedCache.get(key)
      let rows: Promise<MkOutageRow[]>
      if (hit && Date.now() - hit.at < (ctx.fresh ? FRESH_TTL_MS : FEED_TTL_MS)) rows = hit.rows
      else {
        rows = houseFeed(ctx, house.id, ctx.now())
        if (feedCache.size > 500) feedCache.clear()
        feedCache.set(key, { at: Date.now(), rows })
        rows.catch(() => {
          if (feedCache.get(key)?.rows === rows) feedCache.delete(key)
        })
      }
      const row = currentFeedRow(await rows, ctx.now())
      if (!row) return null
      // the groups come with the address (`outage-queue`); the feed doesn't name them for every row
      const groups = (await houseQueues(ctx, house.id)).gpv
      return {
        region,
        address: { city: city?.name, street: street.name, house: house.number },
        ...feedOutage(row),
        groups,
        updatedAt: null,
        url: 'https://www.energy.mk.ua/',
        fetchedAt: toKyivIso(ctx.now()),
      }
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      const { gpv, emergency } = await houseQueues(ctx, house.id)
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

  async function houseQueues(ctx: ProviderContext, iddom: string) {
    const rows = await list<{ outage?: { name: string; type_id: number } }>(
      ctx,
      `/addr/dom/${iddom}/outage-queue`,
    )
    const of = (type: number) =>
      rows.filter((r) => r.outage?.type_id === type).map((r) => r.outage!.name.trim())
    const gpv = of(GPV_TYPE)
    // ГАВ names are "1".."10" and the reserve "1(Р)".."10(Р)"
    const emergency = emergencyQueues({ gav: of(GAV_TYPE), sgav: of(SGAV_TYPE) })
    return { gpv, emergency }
  }

  /**
   * One house's rows of the outage feed of www.energy.mk.ua (`house_id` = the address chain's
   * `iddom`), the last week of them. With `house_id` the house's rows all come on page 1,
   * oldest first (17.11.2026: 25 rows over 14 days, page 2 empty); `total` and `last_page` are
   * of something else and are not followed. A full page is followed by the next, to be safe.
   */
  async function houseFeed(ctx: ProviderContext, iddom: string, now: Date): Promise<MkOutageRow[]> {
    const rows: MkOutageRow[] = []
    for (let page = 1; page <= 5; page++) {
      const data = await ctx.http.json<{ data?: unknown }>(MK_FEED, {
        region,
        method: 'POST',
        body: {
          page,
          perPage: FEED_PER_PAGE,
          from: Math.floor((now.getTime() - FEED_LOOKBACK_MS) / 1000),
          to: Math.floor(now.getTime() / 1000) + 3600,
          house_id: Number(iddom),
        },
      })
      if (!Array.isArray(data?.data))
        throw new OutageError('parse', 'Mykolaiv outage feed: no "data" list', { region, url: MK_FEED })
      rows.push(...(data.data as MkOutageRow[]))
      if (data.data.length < FEED_PER_PAGE) break
    }
    return rows
  }
}

/**
 * The feed row that says why a house is off at `now`: started, and `finish_at` (an estimate,
 * corrected when power is back) not reached. The newest start wins. Exported for tests.
 */
export function currentFeedRow(rows: readonly MkOutageRow[], now: Date): MkOutageRow | null {
  const t = now.getTime()
  const at = (s: string | null | undefined) => (s ? Date.parse(s) : NaN)
  return (
    rows
      .filter((r) => {
        const s = at(r.start_at)
        const f = at(r.finish_at)
        return Number.isFinite(s) && s <= t && !(Number.isFinite(f) && f <= t)
      })
      .sort((a, b) => at(b.start_at) - at(a.start_at))[0] ?? null
  )
}

/**
 * A row of the feed as a house outage. `reason` is "<category> | <dispatcher's words>", `type`
 * GAO (a schedule), AVARIYA (an accident) or PLAN. Seen on 03.11 and 17.11.2026:
 * - "Графік аварійних відключень | ГАВ черга 1" (GAO): ГАВ, `emergency`. A row of that category
 *   whose words name ГПВ or another oblenergo ("ГАВ Кіровоград Обленерго"), or typed as an
 *   accident, is not taken for it: `other`, with its words;
 * - "Графік погодинних відключень | ГПВ підчерга 5.2": `scheduled`;
 * - "Пошкодження повітряної лінії" and other "Пошкодження …" (AVARIYA, once GAO), or an AVARIYA
 *   row without words: `repair`; "Оперативні перемикання" (AVARIYA): `other`;
 * - PLAN ("Поточний ремонт", "Реконструкція", …): `planned`.
 * Exported for tests.
 */
export function feedOutage(
  row: MkOutageRow,
): Pick<HouseOutage, 'kind' | 'reason' | 'scheduleApplies' | 'from' | 'to'> {
  const reason = (row.reason ?? '').replace(/\s+/g, ' ').trim()
  const head = reason.split('|')[0]!.trim()
  const kind: HouseOutageKind = /графік\S*\s+аварійних/iu.test(head)
    ? isEmergencyRow(row)
      ? 'emergency'
      : 'other'
    : /графік\S*\s+погодинних/iu.test(head)
      ? 'scheduled'
      : /пошкодж/iu.test(head) || (row.type === 'AVARIYA' && !head)
        ? 'repair'
        : row.type === 'PLAN'
          ? 'planned'
          : 'other'
  const iso = (s: string | null | undefined) => {
    const ms = s ? Date.parse(s) : NaN
    return Number.isFinite(ms) ? toKyivIso(new Date(ms)) : null
  }
  return {
    kind,
    reason:
      reason ||
      (row.type === 'AVARIYA' ? 'Аварійне відключення' : row.type === 'PLAN' ? 'Планове відключення' : ''),
    scheduleApplies: kind === 'emergency' ? false : kind === 'scheduled' ? true : null,
    from: iso(row.start_at),
    to: iso(row.finish_at),
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
