import type { Http } from '../http.js'
import type {
  AddressQuery,
  City,
  GroupMatch,
  House,
  RegionInfo,
  RegionSchedule,
  Street,
} from '../types.js'

export interface ProviderContext {
  http: Http
  now: () => Date
}

/**
 * One grid operator area. Only `info` and `getSchedules` are required; address search
 * methods exist only when the operator offers a lookup.
 *
 * Address search is a chain: cities → streets → houses → group. Regions served by a
 * single-city operator (e.g. Kyiv) skip `searchCities`.
 */
export interface Provider {
  readonly info: RegionInfo
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
}
