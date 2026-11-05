import { OutageError } from '../errors.js'
import { normalizeGroup } from '../schedule.js'
import { matchScore, normalizeHouse } from '../text.js'
import { kyivInstant, toKyivIso } from '../time.js'
import type { City, GroupId, GroupMatch, House, RegionInfo, Street } from '../types.js'
import type { Provider, ProviderContext } from './provider.js'

/**
 * Shared pieces of the "PowerOn" platform («Чому немає світла?», by inneti) used by Lviv,
 * Ternopil and Zakarpattia oblenergos. Each operator runs its own copy of the same
 * API Platform (Symfony) backend with the same `pw_*` resources:
 *
 *   pw_otgs (hromadas) → pw_cities (settlements) → pw_streets → buildings with `chergGpv`
 *
 * Only the last step differs between operators, so this module does the city and street
 * part and lets each region describe how it reads the buildings of a street.
 */

/** Groups of the national scheme, "1.1" … "6.2". */
export const STANDARD_GROUPS: readonly GroupId[] = [1, 2, 3, 4, 5, 6].flatMap((q) => [`${q}.1`, `${q}.2`])

/**
 * Items of an API Platform collection. Depending on the endpoint, the CDN cache and the
 * `Accept` header the same resource comes as JSON-LD (`{"hydra:member": [...]}`, or `member`
 * in newer versions) or as a plain array; an empty JSON-LD result can carry `null`.
 */
export function hydraList<T>(data: unknown, what: string, region: RegionInfo['id']): T[] {
  if (data === null || data === undefined) return []
  if (Array.isArray(data)) return data as T[]
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>
    for (const key of ['hydra:member', 'member'])
      if (key in o) {
        const m = o[key]
        if (m === null) return []
        if (Array.isArray(m)) return m as T[]
      }
  }
  throw new OutageError('parse', `${what}: expected a list`, { region })
}

/**
 * `chergGpv` as the operator writes it → group id. "Не входить" (not included in the
 * schedule) and blanks give null; a "#2" suffix (second supply of a building) is dropped.
 */
export function parseCherg(raw: string | null | undefined): GroupId | null {
  const s = (raw ?? '').split('#')[0]!.trim()
  if (!/^\d+([.,]\d+)?$/.test(s)) return null
  return normalizeGroup(s)
}

/**
 * Timestamps of these backends are Kyiv wall-clock time, even when they are labelled `Z`
 * or `+00:00` (checked against the real clock: the sync stamp written at 22:00 UTC read
 * "00:00:02+00:00"). Lviv sends a correct offset. Pass `trustOffset` for such sources.
 */
export function parsePowerOnTime(text: string | null | undefined, trustOffset = false): string | null {
  if (!text) return null
  if (trustOffset) {
    const t = Date.parse(text)
    return Number.isFinite(t) ? toKyivIso(new Date(t)) : null
  }
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(text)
  if (!m) return null
  const at = kyivInstant(m[1]!, Number(m[2]) * 60 + Number(m[3]))
  return toKyivIso(new Date(at.getTime() + Number(m[4]) * 1000))
}

/** A building of a street with the groups it belongs to (several when it has several supplies). */
export interface PowerOnBuilding {
  number: string
  groups: GroupId[]
}

export interface PowerOnAddressOptions {
  info: RegionInfo
  /** Short name for error messages, e.g. "Lviv" */
  label: string
  /** API root, e.g. "https://power-api.loe.lviv.ua/api" */
  api: string
  /** Every building of a street, with groups. */
  streetBuildings(ctx: ProviderContext, street: Street): Promise<PowerOnBuilding[]>
  /**
   * Optional cheap exact lookup of one building by its number as typed. Returning `[]` means
   * "not found that way" and falls back to `streetBuildings`.
   */
  findBuilding?(ctx: ProviderContext, street: Street, house: string): Promise<PowerOnBuilding[]>
  /** Optional authoritative group lookup for one building, used by `groupOf`. */
  buildingGroups?(ctx: ProviderContext, street: Street, house: House): Promise<GroupId[]>
}

type AddressSearch = Required<Pick<Provider, 'searchCities' | 'searchStreets' | 'searchHouses' | 'groupOf'>>

/**
 * City → street → house → group lookup on a PowerOn backend. Static lists (all settlements,
 * the streets of a city, the buildings of a street) are kept per provider instance: the
 * operators rate-limit crawlers, and the official sites load the same lists once per visit.
 */
export function powerOnAddressSearch(opts: PowerOnAddressOptions): AddressSearch {
  const region = opts.info.id
  let cities: Promise<City[]> | null = null
  const streets = new LruCache<string, Promise<Street[]>>(8)
  /** street id → building number → groups; `complete` once the whole street was loaded */
  const buildings = new LruCache<string, { complete: boolean; byNumber: Map<string, PowerOnBuilding> }>(32)

  const remember = (street: Street, list: PowerOnBuilding[], complete: boolean) => {
    const entry = buildings.get(street.id) ?? { complete: false, byNumber: new Map() }
    for (const b of list) entry.byNumber.set(b.number, b)
    entry.complete ||= complete
    buildings.set(street.id, entry)
    return entry
  }

  const loadStreet = async (ctx: ProviderContext, street: Street) => {
    const cached = buildings.get(street.id)
    if (cached?.complete) return cached
    return remember(street, await opts.streetBuildings(ctx, street), true)
  }

  const toHouse = (street: Street, b: PowerOnBuilding): House => ({ id: b.number, number: b.number, streetId: street.id })

  return {
    async searchCities(ctx, query) {
      // one request for the whole region (a few hundred KB) instead of one per hromada
      cities ??= (async () => {
        const data = await ctx.http.json(`${opts.api}/pw_cities?pagination=false`, { region })
        return hydraList<{ id: number; name: string; otg?: { name?: string } | string }>(data, `${opts.label} pw_cities`, region)
          .filter((c) => c.name?.trim())
          .map((c) => ({
            id: String(c.id),
            name: c.name.trim(),
            ...(typeof c.otg === 'object' && c.otg?.name ? { district: `${c.otg.name.trim()} громада` } : {}),
          }))
      })().catch((e) => {
        cities = null
        throw e
      })
      const all = await cities
      if (!all.length) throw new OutageError('parse', `${opts.label}: the settlement list is empty`, { region })
      return all.filter((c) => matchScore(query, c.name, 'settlement') > 0)
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${opts.info.name}: pick a city first`, { region })
      let list = streets.get(city.id)
      if (!list) {
        list = (async () => {
          const data = await ctx.http.json(`${opts.api}/pw_streets?pagination=false&city.id=${encodeURIComponent(city.id)}`, {
            region,
          })
          return hydraList<{ id: number; name: string }>(data, `${opts.label} pw_streets`, region)
            .filter((s) => s.name?.trim())
            .map((s) => ({ id: String(s.id), name: s.name.trim().replace(/\s+/g, ' '), cityId: city.id }))
        })()
        list.catch(() => streets.delete(city.id))
        streets.set(city.id, list)
      }
      return (await list).filter((s) => matchScore(query, s.name) > 0)
    },

    async searchHouses(ctx, street, query) {
      const cached = buildings.get(street.id)
      if (!cached?.complete && query && opts.findBuilding) {
        const want = normalizeHouse(query)
        const known = [...(cached?.byNumber.values() ?? [])].filter((b) => normalizeHouse(b.number) === want)
        if (known.length) return known.map((b) => toHouse(street, b))
        const exact = await opts.findBuilding(ctx, street, query.trim())
        if (exact.length) {
          remember(street, exact, false)
          return exact.map((b) => toHouse(street, b))
        }
      }
      const entry = await loadStreet(ctx, street)
      return [...entry.byNumber.values()].map((b) => toHouse(street, b))
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      let groups: GroupId[] | undefined
      if (opts.buildingGroups) groups = await opts.buildingGroups(ctx, street, house)
      if (!groups?.length) {
        const find = (e: { byNumber: Map<string, PowerOnBuilding> } | undefined) =>
          e?.byNumber.get(house.number) ??
          [...(e?.byNumber.values() ?? [])].find((b) => normalizeHouse(b.number) === normalizeHouse(house.number))
        let b = find(buildings.get(street.id))
        if (!b && opts.findBuilding) b = (await opts.findBuilding(ctx, street, house.number))[0]
        if (!b) b = find(await loadStreet(ctx, street))
        if (!b)
          throw new OutageError('not-found', `${house.number}, ${street.name}: no such building in the operator's list`, { region })
        groups = b.groups
      }
      if (!groups.length)
        throw new OutageError(
          'not-found',
          `${house.number}, ${street.name}: the operator lists this building as not included in the outage schedule`,
          { region },
        )
      return {
        region,
        group: groups[0]!,
        ...(groups.length > 1 ? { otherGroups: groups.slice(1) } : {}),
        address: { city: city?.name, street: street.name, house: house.number },
      }
    },
  }
}

/**
 * Distinct groups from per-account or per-row values, most frequent first (the group most
 * customers of a building are in is the best answer to "which group is my building?").
 */
export function rankGroups(values: readonly (string | null | undefined)[]): GroupId[] {
  const count = new Map<GroupId, number>()
  for (const v of values) {
    const g = parseCherg(v)
    if (g) count.set(g, (count.get(g) ?? 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g)
}

/** A tiny insertion-ordered LRU. */
class LruCache<K, V> {
  private readonly map = new Map<K, V>()
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }

  set(key: K, value: V) {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K)
  }

  delete(key: K) {
    this.map.delete(key)
  }
}
