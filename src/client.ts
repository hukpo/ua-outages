import { OutageError, type OutageErrorCode } from './errors.js'
import { assessFreshness } from './freshness.js'
import { Http, type HttpOptions } from './http.js'
import { createProviders } from './providers/index.js'
import type { Provider, ProviderContext } from './providers/provider.js'
import { normalizeGroup } from './schedule.js'
import { fuzzyScore, rankByName, sameStreet, searchFragments, tokens, type NameKind } from './fuzzy.js'
import { houseKey } from './text.js'
import type {
  AddressQuery,
  City,
  EmergencyStatus,
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
  /** No region is `error` and no address lookup failed; with `strict`, none is `stale` or `degraded` either */
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
  ): Promise<City[]> {
    const p = this.provider(region)
    if (!p.searchCities) return []
    const found = await this.rankedSearch(
      ctx,
      region,
      'settlement',
      query,
      'cities',
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
  ): Promise<Street[]> {
    const p = this.addressProvider(region)
    if (p.searchCities && !opts.city)
      throw new OutageError('not-found', `${p.info.name}: pick a city first`, { region })
    return this.rankedSearch(
      ctx,
      region,
      'street',
      query,
      `streets:${opts.city?.id ?? ''}`,
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

    let city: City | undefined
    if (p.searchCities) {
      if (!address.city)
        throw new OutageError('not-found', `${p.info.name}: specify a city or village`, { region })
      const cities = await this.searchCitiesIn(ctx, region, address.city, {
        limit: 10,
        district: address.district,
      })
      city = choose(address.city, cities, 'city', region, (c) =>
        c.district ? `${c.name} (${c.district})` : c.name,
      )
    }

    const ranked = await this.searchStreetsIn(ctx, region, address.street, { city, limit: 10 })
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
    return p.groupOf!(ctx, house, street, city)
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
        const health = await this.checkRegion(id, opts, signal)
        const p = this.provider(id)
        if (!opts.address || !p.sampleAddress || !p.info.capabilities.addressSearch) return health
        signal?.throwIfAborted()
        try {
          const m = await abortable(this.findGroupIn(this.context(signal), id, p.sampleAddress), signal)
          return { ...health, address: { ok: true, group: m.group } }
        } catch (e) {
          if (signal?.aborted) throw signal.reason
          return { ...health, address: { ok: false, message: (e as Error).message } }
        }
      },
      signal,
    )
    return {
      checkedAt: this.ctx.now().toISOString(),
      ok: results.every(
        (r) =>
          r.status !== 'error' &&
          (r.address?.ok ?? true) &&
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
