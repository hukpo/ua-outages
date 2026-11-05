import { OutageError } from './errors.js'
import { Http, type HttpOptions } from './http.js'
import { createProviders } from './providers/index.js'
import type { Provider, ProviderContext } from './providers/provider.js'
import { normalizeGroup } from './schedule.js'
import { bestMatch, normalizeHouse } from './text.js'
import type {
  AddressQuery,
  City,
  GroupId,
  GroupMatch,
  GroupSchedule,
  House,
  RegionHealth,
  RegionId,
  RegionInfo,
  RegionSchedule,
  Street,
} from './types.js'

export interface OutageClientOptions extends HttpOptions {
  /** How long fetched schedules are reused, default 5 min. 0 disables the cache. */
  cacheTtlMs?: number
  /** Clock override, mostly for tests */
  now?: () => Date
  /** Replace the built-in providers (tests, or your own sources) */
  providers?: readonly Provider[]
}

export interface HealthCheckOptions {
  /** Only these regions; default all */
  regions?: RegionId[]
  /** Also run the address lookup with each region's sample address */
  address?: boolean
  /** A schedule not changed for longer than this is `stale`, default 72 h */
  staleAfterHours?: number
  /** Parallel requests, default 6 */
  concurrency?: number
}

export interface HealthReport {
  checkedAt: string
  ok: boolean
  regions: RegionHealth[]
}

/**
 * Entry point. One instance can be shared across the app; it caches schedules briefly and
 * deduplicates concurrent requests for the same region.
 *
 * ```ts
 * const outages = new OutageClient()
 * const { group } = await outages.findGroup('kyiv', { street: 'Хрещатик', house: '1' })
 * const schedule = await outages.getSchedule('kyiv', group)
 * ```
 */
export class OutageClient {
  private readonly ctx: ProviderContext
  private readonly providers: ReadonlyMap<RegionId, Provider>
  private readonly cacheTtlMs: number
  private readonly cache = new Map<RegionId, { at: number; value: Promise<RegionSchedule> }>()

  constructor(opts: OutageClientOptions = {}) {
    this.ctx = { http: new Http(opts), now: opts.now ?? (() => new Date()) }
    this.cacheTtlMs = opts.cacheTtlMs ?? 5 * 60_000
    this.providers = new Map((opts.providers ?? createProviders()).map((p) => [p.info.id, p]))
  }

  /** Every supported region with what it can do. */
  regions(): RegionInfo[] {
    return [...this.providers.values()].map((p) => p.info)
  }

  region(id: RegionId): RegionInfo {
    return this.provider(id).info
  }

  // --- schedules ---

  /** All groups of a region. */
  async getSchedules(region: RegionId, opts: { fresh?: boolean } = {}): Promise<RegionSchedule> {
    const p = this.provider(region)
    const hit = this.cache.get(region)
    const now = Date.now()
    if (!opts.fresh && hit && now - hit.at < this.cacheTtlMs) return hit.value
    const value = p.getSchedules(this.ctx)
    if (this.cacheTtlMs > 0) {
      this.cache.set(region, { at: now, value })
      value.catch(() => this.cache.delete(region))
    }
    return value
  }

  /** One group. Accepts loose spellings: "3.1", "GPV3.1", "черга 3.1". */
  async getSchedule(region: RegionId, group: string, opts: { fresh?: boolean } = {}): Promise<GroupSchedule> {
    const id = normalizeGroup(group)
    const all = await this.getSchedules(region, opts)
    const days = id ? all.schedules[id] : undefined
    if (!id || !days)
      throw new OutageError('not-found', `Group "${group}" not found in ${region}. Known groups: ${all.groups.join(', ') || 'none'}`, { region })
    return { region, group: id, days, updatedAt: all.updatedAt, fetchedAt: all.fetchedAt }
  }

  // --- address search ---

  async searchCities(region: RegionId, query: string): Promise<City[]> {
    const p = this.provider(region)
    if (!p.searchCities) return []
    return p.searchCities(this.ctx, query)
  }

  async searchStreets(region: RegionId, query: string, opts: { city?: City } = {}): Promise<Street[]> {
    return this.addressProvider(region).searchStreets!(this.ctx, query, opts.city)
  }

  async searchHouses(region: RegionId, street: Street, query?: string): Promise<House[]> {
    return this.addressProvider(region).searchHouses!(this.ctx, street, query)
  }

  /** Group of an exact house picked from search results. */
  async groupOf(region: RegionId, house: House, street: Street, city?: City): Promise<GroupMatch> {
    return this.addressProvider(region).groupOf!(this.ctx, house, street, city)
  }

  /**
   * Finds the outage group of an address in one call. Throws `not-found` when the street or
   * house can't be matched unambiguously; the message lists the closest candidates.
   */
  async findGroup(region: RegionId, address: AddressQuery): Promise<GroupMatch> {
    const p = this.addressProvider(region)

    let city: City | undefined
    if (p.searchCities) {
      if (!address.city)
        throw new OutageError('not-found', `${p.info.name}: specify a city or village`, { region })
      const cities = await p.searchCities(this.ctx, address.city)
      city = pick(address.city, cities, (c) => c.name, 'settlement', 'city', region)
    }

    const streets = await p.searchStreets!(this.ctx, address.street, city)
    const street = pick(address.street, streets, (s) => s.name, 'street', 'street', region)

    const houses = await p.searchHouses!(this.ctx, street, address.house)
    const want = normalizeHouse(address.house)
    const house = houses.find((h) => normalizeHouse(h.number) === want)
    if (!house)
      throw new OutageError(
        'not-found',
        `House "${address.house}" not found on ${street.name}. Closest: ${houses.slice(0, 8).map((h) => h.number).join(', ') || 'none'}`,
        { region },
      )
    return p.groupOf!(this.ctx, house, street, city)
  }

  // --- health ---

  /**
   * Fetches every region (bypassing the cache) and reports whether parsing still works.
   * Use it in CI or a cron job to notice when an operator changes its site.
   */
  async healthCheck(opts: HealthCheckOptions = {}): Promise<HealthReport> {
    const ids = opts.regions ?? [...this.providers.keys()]
    const staleMs = (opts.staleAfterHours ?? 72) * 3600_000
    const results = await mapLimit(ids, opts.concurrency ?? 6, async (id): Promise<RegionHealth> => {
      const health = await this.checkRegion(id, staleMs)
      const p = this.provider(id)
      if (!opts.address || !p.sampleAddress || !p.info.capabilities.addressSearch) return health
      try {
        const m = await this.findGroup(id, p.sampleAddress)
        return { ...health, address: { ok: true, group: m.group } }
      } catch (e) {
        return { ...health, address: { ok: false, message: (e as Error).message } }
      }
    })
    return {
      checkedAt: this.ctx.now().toISOString(),
      ok: results.every((r) => r.status !== 'error' && (r.address?.ok ?? true)),
      regions: results,
    }
  }

  private async checkRegion(region: RegionId, staleMs: number): Promise<RegionHealth> {
    const info = this.provider(region).info
    // e.g. operators that publish the schedule only as an image: nothing to check
    if (!info.capabilities.schedule)
      return {
        region,
        status: 'empty',
        latencyMs: 0,
        groups: 0,
        updatedAt: null,
        message: 'The operator publishes no machine-readable schedule (address lookup only)',
      }
    const started = performance.now()
    try {
      const s = await this.getSchedules(region, { fresh: true })
      const latencyMs = Math.round(performance.now() - started)
      const base = { region, latencyMs, groups: s.groups.length, updatedAt: s.updatedAt }
      const hasData = Object.values(s.schedules).some((days) =>
        days.some((d) => d.intervals.length > 0 || d.status === 'no-outages'),
      )
      if (!s.groups.length || !hasData)
        return { ...base, status: 'empty', message: 'No schedule published right now' }
      if (s.updatedAt && this.ctx.now().getTime() - Date.parse(s.updatedAt) > staleMs)
        return { ...base, status: 'stale', message: `Last updated ${s.updatedAt}` }
      return { ...base, status: 'ok' }
    } catch (e) {
      return {
        region,
        status: 'error',
        latencyMs: Math.round(performance.now() - started),
        groups: 0,
        updatedAt: null,
        message: e instanceof OutageError ? `${e.code}: ${e.message}` : String(e),
      }
    }
  }

  // --- internals ---

  private provider(id: RegionId): Provider {
    const p = this.providers.get(id)
    if (!p) throw new OutageError('unsupported', `Unknown region "${id}"`, { region: id })
    return p
  }

  private addressProvider(id: RegionId): Provider {
    const p = this.provider(id)
    if (!p.searchStreets || !p.searchHouses || !p.groupOf)
      throw new OutageError('unsupported', `${p.info.name}: the operator has no address lookup`, { region: id })
    return p
  }
}

function pick<T>(
  query: string,
  items: readonly T[],
  name: (t: T) => string,
  kind: 'street' | 'settlement',
  label: string,
  region: RegionId,
): T {
  const m = bestMatch(query, items, name, kind)
  if (!m)
    throw new OutageError('not-found', `No ${label} matches "${query}"`, { region })
  if (m.ambiguous)
    throw new OutageError(
      'not-found',
      `"${query}" matches several: ${items.slice(0, 8).map(name).join('; ')}. Be more specific.`,
      { region },
    )
  return m.item
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
