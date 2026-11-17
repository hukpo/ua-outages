import type { Http } from '../http.js'
import type {
  AddressQuery,
  City,
  EmergencyStatus,
  GroupMatch,
  House,
  HouseOutage,
  ProviderInfo,
  RegionSchedule,
  Street,
} from '../types.js'
import { SharedTask } from '../util.js'

export interface ProviderContext {
  /** Already bound to `signal`: every request through it stops when the call is cancelled */
  http: Http
  now: () => Date
  /**
   * The caller's cancellation, if any. Requests stop by themselves; pass it to `mapLimit` and
   * check it in long loops. Work shared between calls (a session several calls wait for) should
   * run on `http.withSignal(undefined)` and be awaited with `abortable(…, signal)`, so one
   * caller giving up doesn't fail the others.
   */
  signal?: AbortSignal
  /** The caller asked for fresh data: skip caches shared between regions (e.g. channel pages) */
  fresh?: boolean
}

/**
 * One grid operator area. Only `info` and `getSchedules` are required; address search
 * methods exist only when the operator offers a lookup.
 *
 * Address search is a chain: cities → streets → houses → group. Regions served by a
 * single-city operator (e.g. Kyiv) skip `searchCities`.
 *
 * `searchCities` / `searchStreets` return *candidates*: the whole directory when the provider
 * has it, or what the operator's server found for the query. The client ranks them with a
 * typo-tolerant matcher, so providers should not filter by name themselves.
 */
export interface Provider {
  readonly info: ProviderInfo
  /**
   * Set when the operator's server does the name search (substring match) instead of the
   * provider holding a directory. The client then also queries word fragments, so a typo in
   * one part of a name still finds it.
   */
  readonly remoteSearch?: { cities?: boolean; streets?: boolean }
  /** A real public address used by the health check to verify the lookup still works */
  readonly sampleAddress?: AddressQuery
  getSchedules(ctx: ProviderContext): Promise<RegionSchedule>

  searchCities?(ctx: ProviderContext, query: string): Promise<City[]>
  searchStreets?(ctx: ProviderContext, query: string, city?: City): Promise<Street[]>
  searchHouses?(ctx: ProviderContext, street: Street, query?: string): Promise<House[]>
  groupOf?(ctx: ProviderContext, house: House, street: Street, city?: City): Promise<GroupMatch>

  /**
   * For operators without street/house directories that answer a free-text address directly.
   * `findGroup` uses it instead of the search chain when present.
   */
  lookupAddress?(ctx: ProviderContext, address: AddressQuery): Promise<GroupMatch>

  /**
   * Whether a house is off right now and why (`OutageClient.getHouseOutage`), on this provider's
   * own address chain; null when the operator lists no outage there.
   */
  outageOf?(ctx: ProviderContext, house: House, street: Street, city?: City): Promise<HouseOutage | null>
  /**
   * Another provider with `outageOf` and its own address chain, for a region whose lookup reads a
   * source without per-house status (Kyiv and Dnipro: YASNO for groups, the DTEK site for this).
   */
  readonly houseOutages?: Provider
  /**
   * ГАВ / СГАВ status of the region now (`OutageClient.getEmergency`). Present only when the
   * region has a source for it; nothing announced is `inactive`, never an error.
   */
  getEmergency?(ctx: ProviderContext, opts?: { previous?: EmergencyStatus }): Promise<EmergencyStatus>
}

/**
 * A list several calls share (the settlements of a region, the streets of a city): loaded once,
 * kept for `ttlMs`, loaded again after that or after a failure. The load runs on a signal of its
 * own (`SharedTask`), bound to no single caller: one caller cancelling doesn't fail the others
 * waiting for it, and it stops when all of them have left.
 */
export function sharedList<T>(
  ttlMs: number,
  load: (ctx: ProviderContext) => Promise<T>,
): (ctx: ProviderContext) => Promise<T> {
  let task: SharedTask<T> | null = null
  let at = 0
  return (ctx) => {
    if (!task || task.aborted || Date.now() - at > ttlMs) {
      at = Date.now()
      const t = new SharedTask((signal) => load({ ...ctx, http: ctx.http.withSignal(signal), signal }))
      task = t
      t.promise.catch(() => {
        if (task === t) task = null
      })
    }
    return task.join(ctx.signal)
  }
}
