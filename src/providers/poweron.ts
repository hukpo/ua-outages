import { OutageError } from '../errors.js'
import type { RequestOptions } from '../http.js'
import { normalizeGroup, STANDARD_GROUPS } from '../schedule.js'
import { houseKey } from '../text.js'
import { kyivInstant, toKyivIso } from '../time.js'
import type {
  City,
  EmergencyQueues,
  GroupId,
  GroupMatch,
  House,
  HouseOutage,
  HouseOutageKind,
  ProviderInfo,
  Street,
} from '../types.js'
import { sharedList, type Provider, type ProviderContext } from './provider.js'

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
export { STANDARD_GROUPS }

/**
 * Items of an API Platform collection. Depending on the endpoint, the CDN cache and the
 * `Accept` header the same resource comes as JSON-LD (`{"hydra:member": [...]}`, or `member`
 * in newer versions) or as a plain array; an empty JSON-LD result can carry `null`.
 */
export function hydraList<T>(data: unknown, what: string, region: ProviderInfo['id']): T[] {
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

/** A CDN copy older than this (seconds, the `Age` header) is asked for again */
export const MAX_CDN_AGE_S = 600

/**
 * `ctx.http.json` past the CDN. Lviv's and Ternopil's schedule APIs sit behind Cloudflare with
 * `s-maxage=7200`: without this a change can stay hidden for two hours. A query parameter the
 * backend ignores (`_=<unix seconds>`) makes every call a new cache key, which Cloudflare
 * forwards to the origin (`cf-cache-status: MISS`, checked 2026-11-17 on both hosts). Should a
 * copy older than `MAX_CDN_AGE_S` come back anyway, it is asked for once more under another key;
 * what that returns is used as is, since an `Age` header can't be told to the caller.
 */
export async function uncachedJson<T = unknown>(
  ctx: ProviderContext,
  url: string,
  opts: RequestOptions = {},
): Promise<T> {
  const stamp = Math.floor(ctx.now().getTime() / 1000)
  const get = (tag: string) => ctx.http.raw(`${url}${url.includes('?') ? '&' : '?'}_=${tag}`, opts)
  let res = await get(String(stamp))
  if (Number(res.headers.get('age')) > MAX_CDN_AGE_S) res = await get(`${stamp}r`)
  try {
    return JSON.parse(res.body) as T
  } catch (cause) {
    throw new OutageError('parse', `${new URL(url).host} returned invalid JSON`, {
      region: opts.region,
      url,
      cause,
    })
  }
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
  /** ГАВ / СГАВ / АЧР queues, when the backend lists them (`chergGav`, `chergSgav`, `chergAchr`) */
  emergency?: EmergencyQueues
}

export interface PowerOnAddressOptions {
  info: ProviderInfo
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
  /** Adds `outageOf`, read from the backend's `pw_accidents` (see `powerOnOutages`) */
  outages?: Omit<PowerOnOutageOptions, 'info' | 'label' | 'api'>
}

/** Settlements and streets: the lists change rarely (Cherkasy keeps its directory as long) */
const LIST_TTL_MS = 24 * 3_600_000
/** The buildings of a street with their groups */
const BUILDINGS_TTL_MS = 6 * 3_600_000

type AddressSearch = Required<Pick<Provider, 'searchCities' | 'searchStreets' | 'searchHouses' | 'groupOf'>> &
  Pick<Provider, 'outageOf'>

/**
 * City → street → house → group lookup on a PowerOn backend. Static lists (all settlements,
 * the streets of a city, the buildings of a street) are kept per provider instance: the
 * operators rate-limit crawlers, and the official sites load the same lists once per visit.
 */
export function powerOnAddressSearch(opts: PowerOnAddressOptions): AddressSearch {
  const region = opts.info.id
  // one request for the whole region (a few hundred KB) instead of one per hromada
  const cities = sharedList(LIST_TTL_MS, async (ctx): Promise<City[]> => {
    const data = await ctx.http.json(`${opts.api}/pw_cities?pagination=false`, { region })
    const all = hydraList<{ id: number; name: string; otg?: { name?: string } | string }>(
      data,
      `${opts.label} pw_cities`,
      region,
    )
      .filter((c) => c.name?.trim())
      .map((c) => ({
        id: String(c.id),
        name: c.name.trim(),
        ...(typeof c.otg === 'object' && c.otg?.name ? { district: `${c.otg.name.trim()} громада` } : {}),
      }))
    // thrown here, so an empty answer is not kept as the list
    if (!all.length) throw new OutageError('parse', `${opts.label}: the settlement list is empty`, { region })
    return all
  })
  const streets = new LruCache<string, (ctx: ProviderContext) => Promise<Street[]>>(8)
  /** street id → building number → groups; `complete` once the whole street was loaded */
  const buildings = new LruCache<
    string,
    { complete: boolean; byNumber: Map<string, PowerOnBuilding>; at: number }
  >(32)
  /** What is kept of a street, while it is recent enough: a building's group can change */
  const kept = (street: Street) => {
    const entry = buildings.get(street.id)
    if (entry && Date.now() - entry.at > BUILDINGS_TTL_MS) {
      buildings.delete(street.id)
      return undefined
    }
    return entry
  }

  const remember = (street: Street, list: PowerOnBuilding[], complete: boolean) => {
    // a whole street replaces what was kept; a single building joins it
    const entry = (complete ? undefined : kept(street)) ?? {
      complete: false,
      byNumber: new Map(),
      at: Date.now(),
    }
    for (const b of list) entry.byNumber.set(b.number, b)
    entry.complete ||= complete
    buildings.set(street.id, entry)
    return entry
  }

  const loadStreet = async (ctx: ProviderContext, street: Street) => {
    const cached = kept(street)
    if (cached?.complete) return cached
    return remember(street, await opts.streetBuildings(ctx, street), true)
  }

  const find = (e: { byNumber: Map<string, PowerOnBuilding> } | undefined, house: House) =>
    e?.byNumber.get(house.number) ??
    [...(e?.byNumber.values() ?? [])].find((b) => houseKey(b.number) === houseKey(house.number))

  const toHouse = (street: Street, b: PowerOnBuilding): House => ({
    id: b.number,
    number: b.number,
    streetId: street.id,
  })

  const outages =
    opts.outages && powerOnOutages({ ...opts.outages, info: opts.info, label: opts.label, api: opts.api })

  return {
    ...(outages
      ? {
          // the groups come from the building list the address lookup has just read
          outageOf: (ctx: ProviderContext, house: House, street: Street, city?: City) =>
            outages.outageOf(ctx, house, street, city, find(kept(street), house)?.groups ?? []),
        }
      : {}),

    async searchCities(ctx) {
      return cities(ctx)
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${opts.info.name}: pick a city first`, { region })
      let list = streets.get(city.id)
      if (!list) {
        list = sharedList(LIST_TTL_MS, async (ctx) => {
          const data = await ctx.http.json(
            `${opts.api}/pw_streets?pagination=false&city.id=${encodeURIComponent(city.id)}`,
            {
              region,
            },
          )
          return hydraList<{ id: number; name: string }>(data, `${opts.label} pw_streets`, region)
            .filter((s) => s.name?.trim())
            .map((s) => ({ id: String(s.id), name: s.name.trim().replace(/\s+/g, ' '), cityId: city.id }))
        })
        streets.set(city.id, list)
      }
      return list(ctx)
    },

    async searchHouses(ctx, street, query) {
      const cached = kept(street)
      if (!cached?.complete && query && opts.findBuilding) {
        // "1/1" is not "11": compare what `houseKey` keeps apart
        const want = houseKey(query)
        const known = [...(cached?.byNumber.values() ?? [])].filter((b) => houseKey(b.number) === want)
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
      // the emergency queues come with the building lists; no extra request just for them
      let emergency = find(kept(street), house)?.emergency
      if (opts.buildingGroups) groups = await opts.buildingGroups(ctx, street, house)
      if (!groups?.length) {
        let b = find(kept(street), house)
        if (!b && opts.findBuilding) b = (await opts.findBuilding(ctx, street, house.number))[0]
        if (!b) b = find(await loadStreet(ctx, street), house)
        if (!b)
          throw new OutageError(
            'not-found',
            `${house.number}, ${street.name}: no such building in the operator's list`,
            { region },
          )
        groups = b.groups
        emergency = b.emergency
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
        ...(emergency ? { emergency } : {}),
      }
    },
  }
}

// --- outages now (`pw_accidents`) ---

/**
 * A row of `pw_accidents`: an outage the operator's dispatchers have logged, for the houses
 * of one street (`buildingNames`, comma-separated). `koment` is the dispatcher's own note: the
 * operators' sites never show it, and it can carry names (Zakarpattia, 17.11.2026), so only a
 * bare group ("3,1", Zhytomyr's ГПВ rows) is read from it.
 */
export interface PowerOnAccident {
  city?: { id?: number; name?: string } | null
  street?: { id?: number; name?: string } | null
  buildingNames?: string | null
  /** When it started */
  dateEvent?: string | null
  /** When power is expected back */
  datePlanIn?: string | null
  typeOff?: number | null
  switchSubReason?: number | null
  koment?: string | null
}

/**
 * The SPA's own labels («Чому немає світла?», `main.*.js` of Zhytomyr and Lviv, 16.11.2026):
 * `switchSubReason`, when above 0, says which schedule switched the houses off; otherwise
 * `typeOff` says what kind of outage it is.
 *
 * Seen live (17.11.2026): `switchSubReason` 2 in Zhytomyr (every ГПВ slot, one row per street
 * and group), and `typeOff` 0 and 1 with `switchSubReason` 0 in Lviv, Zhytomyr and Zakarpattia.
 * UNVERIFIED: `switchSubReason` 1 and 3 (ГАВ, СГАВ) have not been seen in a live list; no ГАВ
 * was in force while this was written. They are mapped to `emergency` because the operator's
 * own site labels them as those schedules, not on a guess.
 */
const SWITCH_SUB_REASON: Record<number, { kind: HouseOutageKind; reason: string }> = {
  1: { kind: 'emergency', reason: 'Графік аварійних відключень' },
  2: { kind: 'scheduled', reason: 'Графік погодинних відключень' },
  3: { kind: 'emergency', reason: 'Спеціальний графік аварійних відключень' },
}
const TYPE_OFF: Record<number, { kind: HouseOutageKind; reason: string }> = {
  0: { kind: 'planned', reason: 'Планове відключення' },
  // the operators' unscheduled outage: local damage, a drone strike ("УДАР БПЛА" in Zhytomyr's
  // note), a line cut off on request. Not ГАВ: that is `switchSubReason` 1
  1: { kind: 'repair', reason: 'Аварійне відключення' },
  2: { kind: 'other', reason: 'Оперативні перемикання' },
  // Lviv's SPA only
  30: { kind: 'other', reason: 'Можливе аварійне вимкнення' },
}

/** Rows whose planned end is this far behind are no longer taken as current */
const ACCIDENT_GRACE_MS = 30 * 60_000

/**
 * The outage a row describes, the way the operator's site labels it. Exported for tests.
 * `trustOffset` as for `parsePowerOnTime`.
 */
export function accidentOutage(
  row: PowerOnAccident,
  trustOffset = false,
): Pick<HouseOutage, 'kind' | 'reason' | 'scheduleApplies' | 'from' | 'to'> {
  const sub = row.switchSubReason ?? 0
  const label =
    sub > 0
      ? (SWITCH_SUB_REASON[sub] ?? { kind: 'other' as const, reason: `switchSubReason ${sub}` })
      : (TYPE_OFF[row.typeOff ?? -1] ?? { kind: 'other' as const, reason: `typeOff ${row.typeOff ?? '?'}` })
  return {
    ...label,
    scheduleApplies: label.kind === 'emergency' ? false : label.kind === 'scheduled' ? true : null,
    from: parsePowerOnTime(row.dateEvent, trustOffset),
    to: parsePowerOnTime(row.datePlanIn, trustOffset),
  }
}

/** House numbers of a row: "1, 10, 17а, 2-А" (Zakarpattia also has blanks and "б/н") */
export function accidentHouses(row: PowerOnAccident): string[] {
  return (row.buildingNames ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h && /\d/.test(h))
}

/** Which outages come first when several rows list a house */
const KIND_RANK: Record<HouseOutageKind, number> = {
  emergency: 0,
  repair: 1,
  planned: 2,
  other: 3,
  scheduled: 4,
}

/**
 * The row that says why `house` is off at `now`, or null. A row counts while it has started
 * and its planned end is less than half an hour behind (the ГПВ rows' own "+30 хв на
 * перемикання"). The lists are not cleaned up: Zakarpattia's held rows from June 2025 and
 * Zhytomyr's kept every ГПВ slot for an hour and more after it ended (17.11.2026), so a row
 * past its planned end says nothing about now. Exported for tests.
 */
export function currentAccident(
  rows: readonly PowerOnAccident[],
  house: string,
  now: Date,
  trustOffset = false,
): { row: PowerOnAccident; outage: ReturnType<typeof accidentOutage> } | null {
  const want = houseKey(house)
  const t = now.getTime()
  let best: { row: PowerOnAccident; outage: ReturnType<typeof accidentOutage> } | null = null
  for (const row of rows) {
    if (!accidentHouses(row).some((h) => houseKey(h) === want)) continue
    const outage = accidentOutage(row, trustOffset)
    if (outage.from && Date.parse(outage.from) > t) continue
    if (outage.to && Date.parse(outage.to) + ACCIDENT_GRACE_MS <= t) continue
    if (
      !best ||
      KIND_RANK[outage.kind] < KIND_RANK[best.outage.kind] ||
      (KIND_RANK[outage.kind] === KIND_RANK[best.outage.kind] &&
        (outage.to ?? '\uffff') > (best.outage.to ?? '\uffff'))
    )
      best = { row, outage }
  }
  return best
}

export interface PowerOnOutageOptions {
  info: ProviderInfo
  label: string
  api: string
  /** The public page of the list («Чому немає світла?»), for `HouseOutage.url` */
  site: string
  /** The backend's times carry a real offset (Lviv); see `parsePowerOnTime` */
  trustOffset?: boolean
}

/** A street's rows are read once per this; the list changes by the minute */
const ACCIDENTS_TTL_MS = 5 * 60_000
/** `fresh` still takes what the same call has just read */
const FRESH_TTL_MS = 15_000
/** A street has a few rows; pages are 30 rows */
const MAX_ACCIDENT_PAGES = 5

/**
 * `outageOf` on a PowerOn backend: the street's rows of `pw_accidents`, the list the site shows
 * under «Чому немає світла?», by the same ids as the address lookup. One request per street
 * (more only past 30 rows), kept 5 minutes.
 */
export function powerOnOutages(opts: PowerOnOutageOptions) {
  const region = opts.info.id
  const cache = new Map<string, { at: number; rows: Promise<PowerOnAccident[]> }>()

  const load = async (ctx: ProviderContext, cityId: string, streetId: string) => {
    const rows: PowerOnAccident[] = []
    for (let page = 1; page <= MAX_ACCIDENT_PAGES; page++) {
      // the query the site itself sends; past the CDN, which may keep a list for minutes
      const q = `page=${page}&otg.id=&city.id=${encodeURIComponent(cityId)}&street.id=${encodeURIComponent(streetId)}`
      const data = await uncachedJson<{ 'hydra:view'?: { 'hydra:next'?: string } }>(
        ctx,
        `${opts.api}/pw_accidents?${q}`,
        { region },
      )
      rows.push(...hydraList<PowerOnAccident>(data, `${opts.label} pw_accidents`, region))
      if (!data || typeof data !== 'object' || !data['hydra:view']?.['hydra:next']) break
    }
    return rows
  }

  const streetRows = (ctx: ProviderContext, cityId: string, streetId: string) => {
    const key = `${cityId}\u0000${streetId}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < (ctx.fresh ? FRESH_TTL_MS : ACCIDENTS_TTL_MS)) return hit.rows
    const rows = load(ctx, cityId, streetId)
    if (cache.size > 500) cache.clear()
    cache.set(key, { at: Date.now(), rows })
    rows.catch(() => {
      if (cache.get(key)?.rows === rows) cache.delete(key)
    })
    return rows
  }

  return {
    async outageOf(
      ctx: ProviderContext,
      house: House,
      street: Street,
      city: City | undefined,
      groups: readonly GroupId[],
    ): Promise<HouseOutage | null> {
      const cityId = street.cityId ?? city?.id ?? ''
      const rows = (await streetRows(ctx, cityId, street.id)).filter(
        (r) =>
          (r.street?.id === undefined || String(r.street.id) === street.id) &&
          (r.city?.id === undefined || String(r.city.id) === cityId),
      )
      const hit = currentAccident(rows, house.number, ctx.now(), opts.trustOffset)
      if (!hit) return null
      // a ГПВ row is per group; its note is that group ("3,1")
      const noted = hit.outage.kind === 'scheduled' ? parseCherg(hit.row.koment) : null
      return {
        region,
        address: { city: city?.name ?? hit.row.city?.name, street: street.name, house: house.number },
        ...hit.outage,
        groups: groups.length ? [...groups] : noted ? [noted] : [],
        updatedAt: null,
        url: opts.site,
        fetchedAt: toKyivIso(ctx.now()),
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
