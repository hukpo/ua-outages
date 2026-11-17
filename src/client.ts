import { OutageError, type OutageErrorCode } from './errors.js'
import { assessFreshness } from './freshness.js'
import { Http, type HttpOptions } from './http.js'
import { createProviders } from './providers/index.js'
import type { Provider, ProviderContext } from './providers/provider.js'
import { normalizeGroup } from './schedule.js'
import { fuzzyScore, rankByName, sameStreet, searchFragments, tokens, type NameKind } from './fuzzy.js'
import { decideHouseStatus } from './house-status.js'
import { houseKey, normalizeSettlement, normalizeStreet, streetType } from './text.js'
import { toKyivIso } from './time.js'
import type {
  AddressQuery,
  City,
  EmergencyStatus,
  GroupId,
  GroupMatch,
  GroupSchedule,
  House,
  HouseOutage,
  HouseStatus,
  HouseStatusGap,
  RegionHealth,
  RegionId,
  RegionInfo,
  RegionSchedule,
  Street,
} from './types.js'
import { abortable, mapLimit } from './util.js'
import { validateSchedule } from './validate.js'

export interface OutageClientOptions extends HttpOptions {
  /** How long fetched schedules are reused, default 5 min. 0 disables the cache. */
  cacheTtlMs?: number
  /** Clock override, mostly for tests */
  now?: () => Date
  /** Replace the built-in providers (tests, or your own sources) */
  providers?: readonly Provider[]
  /**
   * Also read channels that are not the operator's own, for regions whose operator has none a
   * plain request can read. Today: a community mirror for `vinnytsia`, which otherwise has no
   * schedule. Such a channel has `official: false` in the result's `sources`. Off by default.
   */
  unofficialSources?: boolean
  /** Default of `ScheduleOptions.staleIfError` for every `getSchedules` / `getSchedule` call. Off by default */
  staleIfError?: StaleIfError
}

/** `true`, or how old the last good result may be (default 6 h) */
export type StaleIfError = boolean | { maxAgeMs?: number }

export interface HealthCheckOptions {
  /** Only these regions; default all */
  regions?: RegionId[]
  /** Also run the address lookup with each region's sample address */
  address?: boolean
  /**
   * Also run `getHouseOutage` with the sample address, in the regions that support it: catches a
   * per-house source that changed or went away. One or two more requests per region (DTEK's sites
   * are behind a bot check, so don't run this every minute)
   */
  houseOutage?: boolean
  /** Passed to `assessFreshness`: `updatedAt` older than this with today not published is `stale`. Default 36 */
  staleAfterHours?: number
  /** Passed to `assessFreshness`: Kyiv "HH:MM" after which a missing tomorrow is listed as an issue */
  tomorrowExpectedAt?: string
  /** `ok` is false for `stale` and `degraded` regions too, not only for broken ones */
  strict?: boolean
  /** Parallel requests, default 6 */
  concurrency?: number
  /** Cancels the check: no further regions are fetched and the call rejects with the signal's reason */
  signal?: AbortSignal
}

export interface HealthReport {
  checkedAt: string
  /** No region is `error` and no address lookup or house outage check failed; with `strict`, none is `stale` or `degraded` either */
  ok: boolean
  /** Some region lost a channel but still gave a result */
  degraded: boolean
  /** Some region's data is out of date */
  stale: boolean
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
  private readonly cache = new Map<
    RegionId,
    { at: number; seq: number; value: Promise<RegionSchedule>; ok?: boolean }
  >()
  /** Fetches started, so a slower older one never replaces a newer one in the cache */
  private seq = 0
  private readonly staleIfError: StaleIfError
  /** Each region's last successful result, for `staleIfError` */
  private readonly lastGood = new Map<RegionId, RegionSchedule>()
  /** Regions whose last fetch failed and was answered with the last good result, see `STALE_RETRY_MS` */
  private readonly failed = new Map<RegionId, { at: number; error: OutageError }>()
  private readonly searchCache = new Map<string, { at: number; value: Promise<unknown[]> }>()
  private readonly emergencyCache = new Map<
    RegionId,
    { at: number; seq: number; value: Promise<EmergencyStatus> }
  >()

  constructor(opts: OutageClientOptions = {}) {
    this.ctx = { http: new Http(opts), now: opts.now ?? (() => new Date()) }
    this.cacheTtlMs = opts.cacheTtlMs ?? 5 * 60_000
    this.staleIfError = opts.staleIfError ?? false
    this.providers = new Map(
      (opts.providers ?? createProviders({ unofficialSources: opts.unofficialSources })).map((p) => [
        p.info.id,
        p,
      ]),
    )
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
        emergency: !!p.getEmergency,
        houseOutage: !!(p.houseOutages ?? p).outageOf,
      },
    }
  }

  // --- schedules ---

  /**
   * All groups of a region.
   *
   * `signal` cancels the call: it rejects with the signal's reason right away and sends no
   * further requests to the operator (the one in flight is aborted too).
   *
   * Every result is checked with `validateSchedule` first: a malformed one is a `parse` error.
   *
   * With `staleIfError`, a `network`, `http`, `blocked` or `parse` failure is answered with the
   * region's last good result (marked `stale`) while that is recent enough; see `ScheduleOptions`.
   */
  async getSchedules(region: RegionId, opts: ScheduleOptions = {}): Promise<RegionSchedule> {
    const p = this.provider(region)
    const { signal } = opts
    signal?.throwIfAborted()
    const staleIfError = opts.staleIfError ?? this.staleIfError
    const hit = this.cache.get(region)
    const now = Date.now()
    /** With `staleIfError`, a failure of `result` is answered with the last good result */
    const orLastGood = (result: Promise<RegionSchedule>): Promise<RegionSchedule> =>
      staleIfError
        ? result.catch((e: unknown) => {
            const good = signal?.aborted ? null : this.lastGoodFor(region, e, staleIfError, opts.previous)
            if (!good) throw e
            this.failed.set(region, { at: Date.now(), error: e as OutageError })
            return good
          })
        : result
    // a caller that joins a fetch still running gets the same fallback as the one that started it
    if (!opts.fresh && hit && now - hit.at < this.cacheTtlMs) return orLastGood(abortable(hit.value, signal))
    if (staleIfError && !opts.fresh) {
      // the operator just failed: don't ask again on every call
      const down = this.failed.get(region)
      const good =
        down && now - down.at < Math.min(this.cacheTtlMs, STALE_RETRY_MS)
          ? this.lastGoodFor(region, down.error, staleIfError, opts.previous)
          : null
      if (good) return good
    }
    const value = p
      .getSchedules({ ...this.context(signal), ...(opts.fresh ? { fresh: true } : {}) })
      .then((s) => {
        validateSchedule(s, region, this.latestNow())
        const last = this.lastGood.get(region)
        if (!last || Date.parse(last.fetchedAt) <= Date.parse(s.fetchedAt)) this.lastGood.set(region, s)
        this.failed.delete(region)
        return s
      })
    const entry: { at: number; seq: number; value: Promise<RegionSchedule>; ok?: boolean } = {
      at: now,
      seq: ++this.seq,
      value,
    }
    value.then(
      () => (entry.ok = true),
      () => {},
    )
    if (this.cacheTtlMs > 0) {
      if (signal) {
        // a cancellable call isn't shared while it runs, so another caller never inherits its
        // cancellation; what it fetched is cached once it arrives, unless a fetch started later
        // already is
        value.then(
          () => {
            if ((this.cache.get(region)?.seq ?? 0) < entry.seq) this.cache.set(region, entry)
          },
          () => {},
        )
      } else {
        this.cache.set(region, entry)
        value.catch(() => {
          if (this.cache.get(region) !== entry) return
          // a failed `fresh` fetch doesn't cost the good result it pushed out of the cache
          if (hit?.ok && Date.now() - hit.at < this.cacheTtlMs) this.cache.set(region, hit)
          else this.cache.delete(region)
        })
      }
    }
    // a provider may wait on work it shares with other calls: the caller still leaves at once
    return orLastGood(abortable(value, signal))
  }

  /**
   * The later of the client's clock and the system's, for judging "in the future": a `now` set
   * back to replay saved responses doesn't make them invalid.
   */
  private latestNow(): Date {
    return new Date(Math.max(this.ctx.now().getTime(), Date.now()))
  }

  /**
   * The last good result of a region as the answer to a failed fetch: a copy marked `stale`, or
   * null when the failure isn't one to paper over (cancelled, `unsupported`, `not-found`, a bug)
   * or nothing recent enough is known.
   */
  private lastGoodFor(
    region: RegionId,
    error: unknown,
    staleIfError: true | { maxAgeMs?: number },
    previous: RegionSchedule | undefined,
  ): RegionSchedule | null {
    if (!(error instanceof OutageError) || !STALE_CODES.has(error.code)) return null
    let good = this.lastGood.get(region)
    if (previous && this.usable(previous, region)) {
      if (!good || Date.parse(previous.fetchedAt) > Date.parse(good.fetchedAt)) good = previous
    }
    if (!good) return null
    const maxAgeMs = (staleIfError === true ? undefined : staleIfError.maxAgeMs) ?? 6 * 3600_000
    if (this.ctx.now().getTime() - Date.parse(good.fetchedAt) > maxAgeMs) return null
    return { ...good, stale: { since: good.fetchedAt, error: { code: error.code, message: error.message } } }
  }

  /** A `previous` the app handed in is somebody's stored JSON: used only when it is a sound schedule of this region */
  private usable(previous: RegionSchedule, region: RegionId): boolean {
    try {
      validateSchedule(previous, region, this.latestNow())
      return true
    } catch {
      return false
    }
  }

  /** One group. Accepts loose spellings: "3.1", "GPV3.1", "черга 3.1". */
  async getSchedule(region: RegionId, group: string, opts: ScheduleOptions = {}): Promise<GroupSchedule> {
    const id = normalizeGroup(group)
    const all = await this.getSchedules(region, opts)
    const days = id ? all.schedules[id] : undefined
    if (!id || !days)
      throw new OutageError(
        'not-found',
        `Group "${group}" not found in ${region}. Known groups: ${all.groups.join(', ') || 'none'}`,
        { region },
      )
    return {
      region,
      group: id,
      days,
      updatedAt: all.updatedAt,
      fetchedAt: all.fetchedAt,
      ...(all.sources ? { sources: all.sources } : {}),
      ...(all.stale ? { stale: all.stale } : {}),
    }
  }

  // --- emergency schedules ---

  /**
   * Whether emergency schedules (ГАВ, СГАВ, emergency shutdowns) are in force in a region now,
   * read from the operator's announcements (mostly its Telegram channel). Check
   * `region(id).capabilities.emergency` first: regions without a source throw `unsupported`.
   *
   * Nothing posted is not an error: it is `inactive` with `kind: null`. Many operators never
   * post a cancellation; an announcement nobody followed up on for 12 h counts as ended
   * (`inferred: true`). Cached like schedules; `fresh` skips the cache. Pass `previous` (the last
   * status you stored): after a restart an emergency seen only through YASNO can still end, an
   * "UPD … скасовано" edit gets the time it was first seen, and while one source is down an
   * ongoing episode keeps its details.
   */
  async getEmergency(region: RegionId, opts: EmergencyOptions = {}): Promise<EmergencyStatus> {
    const p = this.provider(region)
    if (!p.getEmergency)
      throw new OutageError('unsupported', `${p.info.name}: no source of emergency (ГАВ) announcements`, {
        region,
      })
    const { signal } = opts
    signal?.throwIfAborted()
    const hit = this.emergencyCache.get(region)
    const now = Date.now()
    if (!opts.fresh && hit && now - hit.at < this.cacheTtlMs) return abortable(hit.value, signal)
    const ctx = { ...this.context(signal), ...(opts.fresh ? { fresh: true } : {}) }
    const value = p.getEmergency(ctx, opts.previous ? { previous: opts.previous } : undefined)
    const entry = { at: now, seq: ++this.seq, value }
    if (this.cacheTtlMs > 0) {
      if (signal)
        value.then(
          () => {
            if ((this.emergencyCache.get(region)?.seq ?? 0) < entry.seq)
              this.emergencyCache.set(region, entry)
          },
          () => {},
        )
      else {
        this.emergencyCache.set(region, entry)
        value.catch(() => {
          if (this.emergencyCache.get(region) === entry) this.emergencyCache.delete(region)
        })
      }
    }
    return abortable(value, signal)
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
    return this.searchCitiesIn(this.ctx, region, query, opts)
  }

  private async searchCitiesIn(
    ctx: ProviderContext,
    region: RegionId,
    query: string,
    opts: SearchOptions & { district?: string },
    chain: AddressChain = { p: this.provider(region), tag: '' },
  ): Promise<City[]> {
    const { p, tag } = chain
    if (!p.searchCities) return []
    const found = await this.rankedSearch(
      ctx,
      region,
      'settlement',
      query,
      `${tag}cities`,
      !!p.remoteSearch?.cities,
      (q) => p.searchCities!(ctx, q),
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
    return this.searchStreetsIn(this.ctx, region, query, opts)
  }

  private async searchStreetsIn(
    ctx: ProviderContext,
    region: RegionId,
    query: string,
    opts: SearchOptions & { city?: City },
    chain: AddressChain = { p: this.addressProvider(region), tag: '' },
  ): Promise<Street[]> {
    const { p, tag } = chain
    if (p.searchCities && !opts.city)
      throw new OutageError('not-found', `${p.info.name}: pick a city first`, { region })
    return this.rankedSearch(
      ctx,
      region,
      'street',
      query,
      `${tag}streets:${opts.city?.id ?? ''}`,
      !!p.remoteSearch?.streets,
      (q) => p.searchStreets!(ctx, q, opts.city),
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
      await this.candidates(this.ctx, region, 'cities', '', false, (q) => p.searchCities!(this.ctx, q))
    if (opts.city && p.searchStreets && !p.remoteSearch?.streets)
      await this.candidates(this.ctx, region, `streets:${opts.city.id}`, '', false, (q) =>
        p.searchStreets!(this.ctx, q, opts.city),
      )
  }

  /**
   * Finds the outage group of an address in one call. Names may be misspelled; when the street
   * or settlement can't be picked with confidence, throws `not-found` listing the suggestions.
   */
  async findGroup(region: RegionId, address: AddressQuery): Promise<GroupMatch> {
    return this.findGroupIn(this.ctx, region, address)
  }

  private async findGroupIn(
    ctx: ProviderContext,
    region: RegionId,
    address: AddressQuery,
  ): Promise<GroupMatch> {
    const direct = this.provider(region)
    if (direct.lookupAddress) return direct.lookupAddress(ctx, address)
    const p = this.addressProvider(region)
    const { house, street, city } = await this.resolveAddress(ctx, region, address, { p, tag: '' })
    return p.groupOf!(ctx, house, street, city)
  }

  /**
   * Whether a house is off right now and why, from the operator's own record of the address
   * (`capabilities.houseOutage`: DTEK's sites, the PowerOn lists of Lviv, Ternopil, Zakarpattia
   * and Zhytomyr, Mykolaiv's outage feed, Sumy's and Poltava's per-address status). `null` when
   * the operator lists no outage there.
   *
   * This is the only place that sees per-house emergency outages: while a region as a whole is
   * back on the schedule (`getEmergency` is `inactive`), some houses can still be off under
   * "екстрені відключення" until a time of their own, and others off for local repairs. A
   * `kind: 'emergency'` result means the schedule doesn't apply to this house now.
   *
   * The address is looked up on the operator's site, so names may be spelled as for `findGroup`.
   * One request per street (or house), cached for 5 minutes (`fresh: true` skips that). Ask for
   * the houses people asked about; DTEK's sites are behind a bot check that blocks a client
   * asking for hundreds of streets in a row, and the others rate-limit too.
   */
  async getHouseOutage(
    region: RegionId,
    address: AddressQuery,
    opts: { signal?: AbortSignal; fresh?: boolean } = {},
  ): Promise<HouseOutage | null> {
    const direct = this.provider(region)
    const p = direct.houseOutages ?? direct
    if (!p.outageOf || !p.searchStreets || !p.searchHouses)
      throw new OutageError(
        'unsupported',
        `${direct.info.name}: the operator publishes no per-house status`,
        {
          region,
        },
      )
    opts.signal?.throwIfAborted()
    const base = this.context(opts.signal)
    const ctx = opts.fresh ? { ...base, fresh: true } : base
    const chain = { p, tag: p === direct ? '' : 'site:' }
    const { house, street, city } = await abortable(
      this.resolveAddress(ctx, region, address, chain),
      opts.signal,
    )
    return abortable(p.outageOf(ctx, house, street, city), opts.signal)
  }

  /**
   * Is the power on at this house now, and why not: one answer from everything the SDK knows
   * about the address, read together (`findGroup` for its groups and ГАВ queues, `getHouseOutage`,
   * `getEmergency`, the group's schedule). See `HouseStatus` for the result and
   * `decideHouseStatus` for the order: the operator's record of the house first, then a ГАВ in
   * force, then the schedule.
   *
   * A part the region doesn't have, or that fails, is listed in `gaps` and the answer is made
   * from the rest; `on` is said only when today's schedule is published with no outage now and
   * every part the region has was read. Throws `not-found` when no lookup finds the address (as
   * `findGroup`), rethrows anything that isn't an `OutageError`, and rejects when cancelled.
   * Requests and caching as for the four calls it makes; `fresh` skips the caches.
   */
  async getHouseStatus(
    region: RegionId,
    address: AddressQuery,
    opts: { signal?: AbortSignal; fresh?: boolean } = {},
  ): Promise<HouseStatus> {
    const { signal, fresh } = opts
    const caps = this.region(region).capabilities
    signal?.throwIfAborted()
    const gaps: HouseStatusGap[] = []
    const part = async <T>(name: HouseStatusGap['part'], run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run()
      } catch (e) {
        if (signal?.aborted) throw signal.reason
        if (!(e instanceof OutageError)) throw e
        gaps.push({ part: name, code: e.code, message: e.message })
        return null
      }
    }
    const missing = (name: HouseStatusGap['part'], message: string) => {
      gaps.push({ part: name, code: 'unsupported', message })
      return null
    }

    // the address first, then the house record: the two often walk the same address chain, and
    // one after the other the second finds the first's lists cached
    const house = (async () => {
      const ctx = fresh ? { ...this.context(signal), fresh: true } : this.context(signal)
      const match = await part('address', () => abortable(this.findGroupIn(ctx, region, address), signal))
      const outage = caps.houseOutage
        ? await part('house-outage', () => this.getHouseOutage(region, address, { signal, fresh }))
        : missing('house-outage', 'the operator publishes no per-house status')
      return { match, outage }
    })()
    const [{ match, outage }, emergency, schedule] = await Promise.all([
      house,
      caps.emergency
        ? part('emergency', () => this.getEmergency(region, { signal, fresh }))
        : Promise.resolve(missing('emergency', 'no source of emergency (ГАВ) announcements')),
      // a last good schedule says nothing about now: a failed read is a gap, not an old answer
      part('schedule', () => this.getSchedules(region, { signal, fresh, staleIfError: false })),
    ])

    // an address nobody could find is the caller's to fix, not an unknown state
    const lookup = gaps.find((g) => g.part === 'address')?.code
    const houseGap = gaps.find((g) => g.part === 'house-outage')
    const missed = (c: string | undefined) => c === 'not-found' || c === 'unsupported'
    if (
      missed(lookup) &&
      missed(houseGap?.code) &&
      (lookup === 'not-found' || houseGap?.code === 'not-found')
    ) {
      const why = gaps.find((g) => g.part === 'address' && g.code === 'not-found') ?? houseGap!
      throw new OutageError('not-found', why.message, { region })
    }

    // the group of the lookup, or of the house record when the lookup failed
    const group = match?.group ?? outage?.groups[0]
    let days = null
    if (group && schedule) {
      days = schedule.schedules[group] ?? null
      if (!days)
        gaps.push({
          part: 'schedule',
          code: 'not-found',
          message: `group ${group} is not in the region's schedule`,
        })
    }
    const now = this.ctx.now()
    // in a fixed order, not the order the parts happened to finish in
    const order: HouseStatusGap['part'][] = ['address', 'house-outage', 'emergency', 'schedule']
    gaps.sort((a, b) => order.indexOf(a.part) - order.indexOf(b.part))
    return {
      ...decideHouseStatus({ region, now, match, outage, emergency, days, gaps }),
      fetchedAt: toKyivIso(now),
    }
  }

  /** An address down a provider's chain: settlement (if it has them), street, house. */
  private async resolveAddress(
    ctx: ProviderContext,
    region: RegionId,
    address: AddressQuery,
    chain: AddressChain,
  ): Promise<{ house: House; street: Street; city?: City }> {
    const { p } = chain
    let city: City | undefined
    if (p.searchCities && !address.city && chain.tag) {
      // another provider's chain for a region asked about without a city (Kyiv: YASNO has no
      // cities, DTEK's site lists "м. Київ" alone) takes its city when it has only one
      const all = await this.candidates(ctx, region, `${chain.tag}cities`, '', false, (q) =>
        p.searchCities!(ctx, q),
      )
      if (all.length !== 1)
        throw new OutageError('not-found', `${p.info.name}: specify a city or village`, { region })
      city = all[0]
    } else if (p.searchCities) {
      if (!address.city)
        throw new OutageError('not-found', `${p.info.name}: specify a city or village`, { region })
      const cities = await this.searchCitiesIn(
        ctx,
        region,
        address.city,
        { limit: 10, district: address.district },
        chain,
      )
      city = choose(address.city, cities, 'city', region, (c) =>
        c.district ? `${c.name} (${c.district})` : c.name,
      )
    }

    const ranked = await this.searchStreetsIn(ctx, region, address.street, { city, limit: 10 }, chain)
    // a street with another number or of another type is a neighbour, however close the name
    const streets = ranked.filter((s) => sameStreet(address.street, s.name))
    if (ranked.length && !streets.length)
      throw new OutageError(
        'not-found',
        `No street matches "${address.street}". Did you mean: ${ranked
          .slice(0, 6)
          .map((s) => s.name)
          .join('; ')}?`,
        { region },
      )
    const street = choose(address.street, streets, 'street', region, (s) => s.name)

    const houses = await p.searchHouses!(ctx, street, address.house)
    // "2/3" is not "23": only a number that differs in spelling alone is the house asked for
    const want = houseKey(address.house)
    const house = houses.find((h) => houseKey(h.number) === want)
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
    return { house, street, city }
  }

  /**
   * Ranks a provider's candidates. Providers with a directory return it whole (cached here);
   * providers whose operator searches server-side get the query, plus word fragments when the
   * query alone finds little, so a typo in one part of the name still lands.
   */
  private async rankedSearch<T extends { id: string; name: string }>(
    ctx: ProviderContext,
    region: RegionId,
    kind: NameKind,
    query: string,
    scope: string,
    remote: boolean,
    fetch: (q: string) => Promise<T[]>,
    limit: number,
  ): Promise<(T & { score: number })[]> {
    if (!query.trim()) return []
    let pool = await this.candidates(ctx, region, scope, query, remote, fetch)
    let ranked = rankByName(query, pool, (t) => t.name, kind)
    // a typo defeats the operator's substring search: retry with fragments of the word
    if (remote && (ranked[0]?.score ?? 0) < 0.9) {
      const extra = await Promise.all(
        searchFragments(query, kind).map((f) =>
          this.candidates(ctx, region, scope, f, true, fetch).catch(() => {
            // a cancelled lookup stops here; any other failure of a fragment is just no extra hits
            ctx.signal?.throwIfAborted()
            return []
          }),
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
    ctx: ProviderContext,
    region: RegionId,
    scope: string,
    query: string,
    remote: boolean,
    fetch: (q: string) => Promise<T[]>,
  ): Promise<T[]> {
    const key = `${region}|${scope}|${remote ? query.trim().toLowerCase() : ''}`
    const hit = this.searchCache.get(key)
    if (hit && Date.now() - hit.at < Math.max(this.cacheTtlMs, 60_000))
      return abortable(hit.value as Promise<T[]>, ctx.signal)
    const value = fetch(query)
    const store = () => {
      if (this.searchCache.size > 500) this.searchCache.clear()
      this.searchCache.set(key, { at: Date.now(), value })
    }
    // a cancellable lookup isn't shared while it runs, so no other caller inherits its cancellation
    if (ctx.signal) value.then(store, () => {})
    else {
      store()
      value.catch(() => this.searchCache.delete(key))
    }
    return value
  }

  // --- health ---

  /**
   * Fetches every region (bypassing the cache and `staleIfError`) and reports whether parsing
   * still works and how fresh the data is. Use it in CI or a cron job to notice when an operator
   * changes its site, a channel goes down or a source stops updating.
   */
  async healthCheck(opts: HealthCheckOptions = {}): Promise<HealthReport> {
    const ids = opts.regions ?? [...this.providers.keys()]
    const { signal } = opts
    const results = await mapLimit(
      ids,
      opts.concurrency ?? 6,
      async (id): Promise<RegionHealth> => {
        let health = await this.checkRegion(id, opts, signal)
        const p = this.provider(id)
        if (opts.address && p.sampleAddress && p.info.capabilities.addressSearch) {
          signal?.throwIfAborted()
          try {
            const m = await abortable(this.findGroupIn(this.context(signal), id, p.sampleAddress), signal)
            health = { ...health, address: { ok: true, group: m.group } }
          } catch (e) {
            if (signal?.aborted) throw signal.reason
            health = { ...health, address: { ok: false, message: errorMessage(e) } }
          }
        }
        // the sub-provider's own sample when it has one (its names can differ from the region's)
        const sample = (p.houseOutages ?? p).sampleAddress ?? p.sampleAddress
        if (opts.houseOutage && sample && this.describe(p).capabilities.houseOutage) {
          signal?.throwIfAborted()
          try {
            const o = await this.getHouseOutage(id, sample, { signal, fresh: true })
            health = { ...health, houseOutage: { ok: true, kind: o?.kind ?? null } }
          } catch (e) {
            if (signal?.aborted) throw signal.reason
            health = { ...health, houseOutage: { ok: false, message: errorMessage(e) } }
          }
        }
        return health
      },
      signal,
    )
    return {
      checkedAt: this.ctx.now().toISOString(),
      ok: results.every(
        (r) =>
          r.status !== 'error' &&
          (r.address?.ok ?? true) &&
          (r.houseOutage?.ok ?? true) &&
          !(opts.strict && (r.status === 'stale' || r.degraded)),
      ),
      degraded: results.some((r) => r.degraded),
      stale: results.some((r) => r.status === 'stale'),
      regions: results,
    }
  }

  private async checkRegion(
    region: RegionId,
    opts: HealthCheckOptions,
    signal?: AbortSignal,
  ): Promise<RegionHealth> {
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
      // a last good result would hide exactly what this check is for
      const s = await this.getSchedules(region, { fresh: true, signal, staleIfError: false })
      const latencyMs = Math.round(performance.now() - started)
      const freshness = assessFreshness(s, {
        now: this.ctx.now(),
        staleAfterHours: opts.staleAfterHours,
        tomorrowExpectedAt: opts.tomorrowExpectedAt,
      })
      const message = (code: string) => freshness.issues.find((i) => i.code === code)?.message
      const failed = message('source-failed')
      const base = {
        region,
        latencyMs,
        groups: s.groups.length,
        updatedAt: s.updatedAt,
        freshness,
        ...(s.sources ? { sources: s.sources } : {}),
        ...(failed ? { degraded: true } : {}),
      }
      const and = failed ? `; ${failed}` : ''
      // anything the operator published counts, a day without outages included
      if (!s.groups.length || freshness.coveredThrough === null)
        return { ...base, status: 'empty', message: `No schedule published right now${and}` }
      if (freshness.state === 'stale') {
        const why = ['behind', 'not-updated', 'last-good', 'fetched-long-ago'].map(message).filter(Boolean)
        return { ...base, status: 'stale', message: why.join('; ') + and }
      }
      return { ...base, status: 'ok', ...(failed ? { message: failed } : {}) }
    } catch (e) {
      if (signal?.aborted) throw signal.reason
      // e.g. a region that publishes only an image the SDK can't read
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

  /** Provider context for one call; with a signal, its requests stop when the call is cancelled */
  private context(signal?: AbortSignal): ProviderContext {
    return signal ? { ...this.ctx, http: this.ctx.http.withSignal(signal), signal } : this.ctx
  }

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

/** A provider whose address chain is walked, and the prefix of its entries in the search cache */
interface AddressChain {
  p: Provider
  tag: string
}

/**
 * Picks the one result the user meant, or explains why not: nothing close enough, or several
 * equally good ("Соборна" is both a вулиця and a площа).
 */
function choose<T extends { score?: number; name: string }>(
  query: string,
  ranked: readonly T[],
  label: 'city' | 'street',
  region: RegionId,
  describe: (t: T) => string,
): T {
  const [top, second] = ranked
  if (!top) throw new OutageError('not-found', `No ${label} matches "${query}"`, { region })
  // the name as typed, letter for letter, beats a near-duplicate ("Бердичівська" next to the
  // directory's misspelled "Бердичивська"); for streets the type, when given, settles two of them
  const norm = label === 'street' ? normalizeStreet : normalizeSettlement
  let exact = ranked.filter((r) => norm(r.name) === norm(query))
  if (exact.length > 1 && label === 'street' && streetType(query))
    exact = exact.filter((r) => streetType(r.name) === streetType(query))
  if (exact.length === 1) return exact[0]!
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

/** A rejection's message, whatever was thrown */
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Failures a last good result may stand in for: the operator couldn't be read. Not a wrong question, not a cancel */
const STALE_CODES: ReadonlySet<OutageErrorCode> = new Set([
  'network',
  'http',
  'blocked',
  'parse',
  'too-large',
])
/**
 * After a failure answered with the last good result, calls with `staleIfError` get that answer
 * again without asking the operator for this long (or the cache TTL, when shorter): a source
 * that is down isn't hit on every call, and its recovery is noticed within a minute.
 */
const STALE_RETRY_MS = 60_000

/** Results per search unless the caller asks otherwise */
const DEFAULT_LIMIT = 10
const MAX_CANDIDATES = 200
/** findGroup picks a name automatically only at or above this score… */
const CONFIDENT = 0.7
/** …and only when the runner-up is further behind than this */
const TIE = 0.025

export interface ScheduleOptions {
  /** Skip the cache and fetch from the operator */
  fresh?: boolean
  /** Cancels the call: it rejects with the signal's reason and sends no further requests */
  signal?: AbortSignal
  /**
   * When the operator can't be read (`network`, `http`, `blocked` or `parse`; not `unsupported`,
   * `not-found` or a cancelled call), return the region's last good result instead of throwing:
   * a copy with `stale: { since, error }` set, `since` being its `fetchedAt`. The client
   * remembers each region's last successful result; `previous` adds one from before a restart.
   * Used only while it is at most `maxAgeMs` old (default 6 h); older, the error is thrown.
   *
   * The failure is never cached as a result: the operator is asked again on the next call once
   * a minute has passed (or the cache TTL, when shorter), and at once with `fresh: true`. Calls
   * without `staleIfError` are not affected. Overrides the client-wide default; default off.
   */
  staleIfError?: StaleIfError
  /**
   * A result of `getSchedules` the app kept (e.g. across a restart), for `staleIfError`: the
   * fallback is this or the one the client remembers, whichever was fetched later. Ignored when
   * it isn't a valid schedule of this region.
   */
  previous?: RegionSchedule
}

export interface EmergencyOptions extends Pick<ScheduleOptions, 'fresh' | 'signal'> {
  /**
   * The status this call returned last time, if the app kept it (e.g. across a restart). The
   * client remembers on its own which emergencies YASNO showed, so that it can tell when YASNO
   * stops showing one; a new process doesn't, and without this would never see that end (an
   * `unknown` status with YASNO's end counts too). It also dates an apply post later edited into
   * "UPD … скасовано" (the edit came after the reading that still saw it in force), and keeps an
   * ongoing episode's kind, queues, area, start and message while one of the region's sources
   * is down and the rest only say it is on.
   */
  previous?: EmergencyStatus
}

export interface SearchOptions {
  /** Max results, default 10 */
  limit?: number
}
