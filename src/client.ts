import { OutageError } from './errors.js'
import { Http, type HttpOptions } from './http.js'
import { createProviders } from './providers/index.js'
import type { OcrFunction, Provider, ProviderContext } from './providers/provider.js'
import { normalizeGroup } from './schedule.js'
import { fuzzyScore, rankByName, searchFragments, type NameKind } from './fuzzy.js'
import { normalizeHouse } from './text.js'
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
import { mapLimit } from './util.js'

export interface OutageClientOptions extends HttpOptions {
  /** How long fetched schedules are reused, default 5 min. 0 disables the cache. */
  cacheTtlMs?: number
  /** Clock override, mostly for tests */
  now?: () => Date
  /** Replace the built-in providers (tests, or your own sources) */
  providers?: readonly Provider[]
  /**
   * Text recognition for operators that publish the schedule as a picture with text
   * (Chernihiv). Without it those regions throw `unsupported`.
   */
  ocr?: OcrFunction
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
  private readonly searchCache = new Map<string, { at: number; value: Promise<unknown[]> }>()

  constructor(opts: OutageClientOptions = {}) {
    this.ctx = { http: new Http(opts), now: opts.now ?? (() => new Date()), ocr: opts.ocr }
    this.cacheTtlMs = opts.cacheTtlMs ?? 5 * 60_000
    this.providers = new Map((opts.providers ?? createProviders()).map((p) => [p.info.id, p]))
  }

  /** Every supported region with what it can do. */
  regions(): RegionInfo[] {
    return [...this.providers.values()].map((p) => this.describe(p))
  }

  region(id: RegionId): RegionInfo {
    return this.describe(this.provider(id))
  }

  private describe(p: Provider): RegionInfo {
    return {
      ...p.info,
      capabilities: {
        ...p.info.capabilities,
        streetSearch: !!(p.searchStreets && p.searchHouses && p.groupOf),
      },
    }
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
      throw new OutageError(
        'not-found',
        `Group "${group}" not found in ${region}. Known groups: ${all.groups.join(', ') || 'none'}`,
        { region },
      )
    return { region, group: id, days, updatedAt: all.updatedAt, fetchedAt: all.fetchedAt }
  }

  // --- address search ---

  /**
   * Settlements matching what the user typed, best first. Forgiving: typos, missing "м."/"с.",
   * Russian-style spelling. Empty for single-city regions (e.g. Kyiv).
   */
  async searchCities(
    region: RegionId,
    query: string,
    opts: SearchOptions & { district?: string } = {},
  ): Promise<City[]> {
    const p = this.provider(region)
    if (!p.searchCities) return []
    const found = await this.rankedSearch(
      region,
      'settlement',
      query,
      'cities',
      !!p.remoteSearch?.cities,
      (q) => p.searchCities!(this.ctx, q),
      opts.district ? MAX_CANDIDATES : (opts.limit ?? DEFAULT_LIMIT),
    )
    if (!opts.district) return found
    const district = opts.district
    return found
      .filter((c) => !c.district || fuzzyScore(district, c.district, 'settlement') >= 0.6)
      .slice(0, opts.limit ?? DEFAULT_LIMIT)
  }

  /**
   * Streets matching what the user typed, best first, for autocomplete. Forgiving: typos
   * ("Хрищатик"), no street type, any word order, a skipped first name ("Шевченка" for
   * "Тараса Шевченка"), "и" for "і", a word typed halfway. Each result carries a `score` (0..1).
   */
  async searchStreets(
    region: RegionId,
    query: string,
    opts: SearchOptions & { city?: City } = {},
  ): Promise<Street[]> {
    const p = this.addressProvider(region)
    if (p.searchCities && !opts.city)
      throw new OutageError('not-found', `${p.info.name}: pick a city first`, { region })
    return this.rankedSearch(
      region,
      'street',
      query,
      `streets:${opts.city?.id ?? ''}`,
      !!p.remoteSearch?.streets,
      (q) => p.searchStreets!(this.ctx, q, opts.city),
      opts.limit ?? DEFAULT_LIMIT,
    )
  }

  async searchHouses(region: RegionId, street: Street, query?: string): Promise<House[]> {
    return this.addressProvider(region).searchHouses!(this.ctx, street, query)
  }

  /** Group of an exact house picked from search results. */
  async groupOf(region: RegionId, house: House, street: Street, city?: City): Promise<GroupMatch> {
    return this.addressProvider(region).groupOf!(this.ctx, house, street, city)
  }

  /**
   * Loads a region's settlement list (and a city's streets) ahead of time, so the first
   * keystrokes of an autocomplete don't wait for the operator. Optional.
   */
  async prefetch(region: RegionId, opts: { city?: City } = {}): Promise<void> {
    const p = this.provider(region)
    if (p.searchCities && !p.remoteSearch?.cities)
      await this.candidates(region, 'cities', '', false, (q) => p.searchCities!(this.ctx, q))
    if (opts.city && p.searchStreets && !p.remoteSearch?.streets)
      await this.candidates(region, `streets:${opts.city.id}`, '', false, (q) =>
        p.searchStreets!(this.ctx, q, opts.city),
      )
  }

  /**
   * Finds the outage group of an address in one call. Names may be misspelled; when the street
   * or settlement can't be picked with confidence, throws `not-found` listing the suggestions.
   */
  async findGroup(region: RegionId, address: AddressQuery): Promise<GroupMatch> {
    const direct = this.provider(region)
    if (direct.lookupAddress) return direct.lookupAddress(this.ctx, address)
    const p = this.addressProvider(region)

    let city: City | undefined
    if (p.searchCities) {
      if (!address.city)
        throw new OutageError('not-found', `${p.info.name}: specify a city or village`, { region })
      const cities = await this.searchCities(region, address.city, { limit: 10, district: address.district })
      city = choose(address.city, cities, 'city', region, (c) =>
        c.district ? `${c.name} (${c.district})` : c.name,
      )
    }

    const streets = await this.searchStreets(region, address.street, { city, limit: 10 })
    const street = choose(address.street, streets, 'street', region, (s) => s.name)

    const houses = await p.searchHouses!(this.ctx, street, address.house)
    const want = normalizeHouse(address.house)
    const house = houses.find((h) => normalizeHouse(h.number) === want)
    if (!house)
      throw new OutageError(
        'not-found',
        `House "${address.house}" not found on ${street.name}. Closest: ${
          houses
            .slice(0, 8)
            .map((h) => h.number)
            .join(', ') || 'none'
        }`,
        { region },
      )
    return p.groupOf!(this.ctx, house, street, city)
  }

  /**
   * Ranks a provider's candidates. Providers with a directory return it whole (cached here);
   * providers whose operator searches server-side get the query, plus word fragments when the
   * query alone finds little, so a typo in one part of the name still lands.
   */
  private async rankedSearch<T extends { id: string; name: string }>(
    region: RegionId,
    kind: NameKind,
    query: string,
    scope: string,
    remote: boolean,
    fetch: (q: string) => Promise<T[]>,
    limit: number,
  ): Promise<(T & { score: number })[]> {
    if (!query.trim()) return []
    let pool = await this.candidates(region, scope, query, remote, fetch)
    let ranked = rankByName(query, pool, (t) => t.name, kind)
    // a typo defeats the operator's substring search: retry with fragments of the word
    if (remote && (ranked[0]?.score ?? 0) < 0.9) {
      const extra = await Promise.all(
        searchFragments(query, kind).map((f) =>
          this.candidates(region, scope, f, true, fetch).catch(() => []),
        ),
      )
      const seen = new Map(pool.map((t) => [t.id, t]))
      for (const t of extra.flat()) if (!seen.has(t.id)) seen.set(t.id, t)
      pool = [...seen.values()]
      ranked = rankByName(query, pool, (t) => t.name, kind)
    }
    return ranked.slice(0, limit).map((r) => ({ ...r.item, score: Math.round(r.score * 100) / 100 }))
  }

  /** Candidate lists, cached briefly: whole directories per scope, server results per term. */
  private candidates<T>(
    region: RegionId,
    scope: string,
    query: string,
    remote: boolean,
    fetch: (q: string) => Promise<T[]>,
  ): Promise<T[]> {
    const key = `${region}|${scope}|${remote ? query.trim().toLowerCase() : ''}`
    const hit = this.searchCache.get(key)
    if (hit && Date.now() - hit.at < Math.max(this.cacheTtlMs, 60_000)) return hit.value as Promise<T[]>
    const value = fetch(query)
    if (this.searchCache.size > 500) this.searchCache.clear()
    this.searchCache.set(key, { at: Date.now(), value })
    value.catch(() => this.searchCache.delete(key))
    return value
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
      // e.g. a region that needs an `ocr` function the app didn't configure
      if (e instanceof OutageError && e.code === 'unsupported')
        return { region, status: 'empty', latencyMs: 0, groups: 0, updatedAt: null, message: e.message }
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
      throw new OutageError('unsupported', `${p.info.name}: the operator has no address lookup`, {
        region: id,
      })
    return p
  }
}

/**
 * Picks the one result the user meant, or explains why not: nothing close enough, or several
 * equally good ("Соборна" is both a вулиця and a площа).
 */
function choose<T extends { score?: number }>(
  query: string,
  ranked: readonly T[],
  label: 'city' | 'street',
  region: RegionId,
  describe: (t: T) => string,
): T {
  const [top, second] = ranked
  if (!top) throw new OutageError('not-found', `No ${label} matches "${query}"`, { region })
  const suggestions = (list: readonly T[]) => list.slice(0, 6).map(describe).join('; ')
  if ((top.score ?? 0) < CONFIDENT)
    throw new OutageError(
      'not-found',
      `No ${label} matches "${query}" well. Did you mean: ${suggestions(ranked)}?`,
      {
        region,
      },
    )
  if (second && (second.score ?? 0) >= (top.score ?? 0) - TIE)
    throw new OutageError(
      'not-found',
      `"${query}" matches several: ${suggestions(ranked.filter((r) => (r.score ?? 0) >= (top.score ?? 0) - 0.1))}. Be more specific${label === 'city' ? ' or pass a district' : ' (add the street type)'}.`,
      { region },
    )
  return top
}

/** Results per search unless the caller asks otherwise */
const DEFAULT_LIMIT = 10
const MAX_CANDIDATES = 200
/** findGroup picks a name automatically only at or above this score… */
const CONFIDENT = 0.7
/** …and only when the runner-up is further behind than this */
const TIE = 0.025

export interface SearchOptions {
  /** Max results, default 10 */
  limit?: number
}
