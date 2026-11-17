import { OutageError } from '../errors.js'
import { STANDARD_GROUPS } from '../image/table.js'
import { normalizeGroup, unpublished } from '../schedule.js'
import type {
  AddressQuery,
  City,
  GroupMatch,
  House,
  HouseOutage,
  HouseOutageKind,
  ProviderInfo,
  RegionId,
  RegionSchedule,
  Street,
} from '../types.js'
import { asSource, steadyStamps } from './as-source.js'
import { gpvRegionSchedule, parseUaDateTime, type GpvDays } from './gpv.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceSpec } from './sources.js'
import { toKyivIso } from '../time.js'

/**
 * DTEK grid-operator sites (www.dtek-<code>.com.ua). The /ua/shutdowns page embeds the
 * schedule and the region's whole street list as JS assignments; house → group needs a
 * POST to /ua/ajax with the session cookie and CSRF token from that page.
 *
 * The sites sit behind Imperva. Some of them challenge non-browser clients on the page; that
 * surfaces as an `OutageError` with code `blocked`.
 *
 * /ua/ajax alone gives the same three things as the page (`checkDisconUpdate` the schedule,
 * `getStreets` the street list, `getHomeNum` the houses) in a thirtieth of its size. A first
 * POST without a token is refused with 400 and sets the CSRF cookie; the token for the next
 * ones is derived from that cookie the way the page's own meta tag is.
 *
 * So /ua/ajax is read first, and the page only when that fails: a bot check put on one route
 * doesn't take the region down while the other answers (Kyiv region's page is challenged and its
 * /ua/ajax is not; Odesa's page was challenged for hours on 17.11.2026). Where both are
 * challenged (Donetsk, from Ukraine) the result is `blocked`.
 *
 * Imperva decides per site, per address and by the minute (18.11.2026 00:38: Kyiv city, Kyiv
 * region and Donetsk challenged, Dnipro and Odesa not, the other way round a quarter of an hour
 * before; a browser User-Agent got the same challenge). The SDK doesn't try to pass the check; it
 * asks less and stops asking:
 * - it keeps every cookie the site sets (Imperva's visitor cookies too) and sends them back, as a
 *   browser does, instead of arriving cookieless for each session;
 * - the CSRF token is kept while the site takes it (a 400 renews it once), so a schedule reading is
 *   one request, not two; an address needs no schedule reading; the street list is kept a day;
 * - after a `blocked` answer the site isn't asked at all for 5 minutes, doubled while it keeps
 *   answering so, up to 30: calls fail at once with `blocked` and say until when.
 */

/** One reading of the schedule */
interface Session {
  at: number
  schedule: RegionSchedule
  /** the route that answered */
  via: string
}

interface DisconUpdate {
  result: boolean
  fact?: { data?: GpvDays; update?: string }
}

/**
 * One house of `getHomeNum`. Besides its groups, the site's record of an outage there now:
 * `sub_type` the reason, `start_date` / `end_date` ("HH:MM DD.MM.YYYY", the end an estimate),
 * `type` "1" for planned repairs and "2" for everything else. All three empty = no outage known.
 * `cek` marks a house served by ЦЕК, which DTEK's site knows nothing about.
 */
export interface HomeRecord {
  sub_type?: string
  start_date?: string
  end_date?: string
  type?: string
  sub_type_reason?: string[]
  voluntarily?: unknown
  cek?: unknown
}

interface HomeNum {
  result: boolean
  data?: Record<string, HomeRecord>
  updateTimestamp?: string
}

/** Per-street house records: groups barely change, but the outage in them does */
const HOUSES_TTL = 5 * 60_000
/** The street list: it changes a few times a year, and it is 2 500 names for Kyiv */
const STREETS_TTL = 24 * 3_600_000
/** How long the site is left alone after its bot check answered: the first time, then doubled */
const MIN_BACKOFF_MS = 5 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000

/** The site's own string; its JS hides the schedule table for it */
const EMERGENCY_REASON = 'Екстренні відключення (Аварійне без застосування графіку погодинних відключень)'

export interface DtekOptions {
  info: Omit<ProviderInfo, 'capabilities'>
  /** Site code: kem, krem, dnem, dem, oem */
  code: string
  sampleAddress?: AddressQuery
}

export function dtekProvider(o: DtekOptions): Provider {
  return dtekSite(o).provider
}

/** The provider, and the reading of its schedule as it is (`load`) for `dtekSiteParts` */
function dtekSite(o: DtekOptions): { provider: Provider; load: (ctx: ProviderContext) => Promise<Session> } {
  const region = o.info.id
  const base = `https://www.dtek-${o.code}.com.ua`
  const ajax = `${base}/ua/ajax`
  let pending: Promise<Session> | null = null
  const houseCache = new Map<string, { at: number; value: HomeNum }>()
  let streets: { at: number; value: Record<string, string[]> } | null = null

  /**
   * The site's cookies, kept the way a browser keeps them: every one it sets (its session, the
   * CSRF cookie, Imperva's visitor cookies) goes back with every request, so the SDK is one
   * returning visitor rather than a new cookieless one each session.
   */
  const jar = new Map<string, string>()
  const remember = (headers: Headers) => {
    for (const c of typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []) {
      const pair = c.split(';')[0]!
      const eq = pair.indexOf('=')
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  /** The masked token for `X-CSRF-Token`, kept while the site accepts it */
  let csrf: string | null = null

  /**
   * After the bot check answers, the site is left alone for a while: every request after a
   * block is one more for Imperva to count, and it lifts sooner without them. 5 minutes,
   * doubled while it keeps answering, up to 30; a request that gets through starts over.
   */
  let backoffMs = 0
  let blockedAt = 0
  const cooling = () => blockedAt > 0 && Date.now() < blockedAt + backoffMs
  const guard = () => {
    if (!cooling()) return
    const at = (ms: number) => toKyivIso(new Date(ms)).slice(11, 16)
    throw new OutageError(
      'blocked',
      `${o.info.operator}: the site's bot check answered at ${at(blockedAt)}; not asked again before ${at(blockedAt + backoffMs)}`,
      { region, url: `${base}/ua/shutdowns` },
    )
  }
  const trip = (e: unknown) => {
    if (!(e instanceof OutageError) || e.code !== 'blocked' || cooling()) return
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, backoffMs * 2))
    blockedAt = Date.now()
  }
  const passed = () => {
    backoffMs = 0
    blockedAt = 0
  }

  /** A POST without a token is refused with 400, and the refusal sets the CSRF cookie */
  const handshakeOnce = async (ctx: ProviderContext) => {
    const first = await ctx.http.raw(ajax, {
      region,
      method: 'POST',
      body: new URLSearchParams(CHECK_ALL),
      headers: { ...xhrHeaders(base), ...(jar.size ? { Cookie: cookie() } : {}) },
      acceptStatus: [400],
    })
    remember(first.headers)
    const token = csrfFromCookie(cookie(), o.code)
    if (!token)
      throw new OutageError('parse', `${o.info.operator}: no CSRF cookie from /ua/ajax (site changed?)`, {
        region,
        url: ajax,
        status: first.status,
      })
    csrf = maskCsrfToken(token)
  }

  /**
   * The handshake and the page are shared by whoever asks while one is under way (the schedule
   * and an address lookup at the same time): one knock at a site that may be about to block
   */
  const once = <A extends unknown[], T>(f: (...a: A) => Promise<T>) => {
    let running: Promise<T> | null = null
    return (...a: A) => (running ??= f(...a).finally(() => (running = null)))
  }
  const handshake = once(handshakeOnce)
  const loadPage = once((ctx: ProviderContext) => loadPageOnce(ctx))

  /**
   * A token to start with: the handshake, or the page's (whose meta tag has it, and which also
   * carries the street list) when /ua/ajax won't give one. The error is the handshake's.
   */
  const token = async (ctx: ProviderContext) => {
    try {
      await handshake(ctx)
    } catch (first) {
      if (!(first instanceof OutageError)) throw first
      try {
        await loadPage(ctx)
      } catch (second) {
        if (!(second instanceof OutageError)) throw second
        throw first
      }
      if (!csrf) throw first
    }
  }

  /** One /ua/ajax request with the kept token; a token the site no longer takes is renewed once */
  const post = async <T>(
    ctx: ProviderContext,
    form: Record<string, string>,
    start: (ctx: ProviderContext) => Promise<void> = token,
  ): Promise<T> => {
    const send = async () => {
      const res = await ctx.http.raw(ajax, {
        region,
        method: 'POST',
        body: new URLSearchParams(form),
        headers: { ...xhrHeaders(base), 'X-CSRF-Token': csrf!, Cookie: cookie() },
      })
      remember(res.headers)
      try {
        return JSON.parse(res.body) as T
      } catch (cause) {
        throw new OutageError('parse', `${o.info.operator}: /ua/ajax returned invalid JSON`, {
          region,
          url: ajax,
          cause,
        })
      }
    }
    if (!csrf) await start(ctx)
    try {
      return await send()
    } catch (e) {
      if (!(e instanceof OutageError) || e.details.status !== 400) throw e
      await handshake(ctx)
      return send()
    }
  }

  /** A request of an address lookup: not sent while the site is cooling down, and counted when blocked */
  const lookup = async <T>(ctx: ProviderContext, form: Record<string, string>): Promise<T> => {
    guard()
    try {
      const res = await post<T>(ctx, form)
      passed()
      return res
    } catch (e) {
      trip(e)
      throw e
    }
  }

  /**
   * `fact` as a schedule. While no schedule is in force the site keeps `fact` with no days in it
   * (Donetsk, read from abroad, 17.11.2026): nothing published, so the twelve queues come back
   * with today `unknown`, not as a region without groups.
   */
  const read = (fact: { data?: GpvDays; update?: string }, now: Date): RegionSchedule => {
    const s = gpvRegionSchedule(region, fact.data, fact.update, now)
    return s.groups.length ? s : unpublished(region, STANDARD_GROUPS, now, s.updatedAt)
  }

  const loadAjax = async (ctx: ProviderContext): Promise<Session> => {
    // the handshake only: the page is `load`'s next route, not this one's
    const res = await post<DisconUpdate>(ctx, CHECK_ALL, handshake)
    if (!res.result || !res.fact)
      throw new OutageError('parse', `${o.info.operator}: /ua/ajax returned no schedule (site changed?)`, {
        region,
        url: ajax,
      })
    return { at: Date.now(), schedule: read(res.fact, ctx.now()), via: ajax }
  }

  const loadPageOnce = async (ctx: ProviderContext): Promise<Session> => {
    const { body, headers } = await ctx.http.raw(`${base}/ua/shutdowns`, {
      region,
      headers: { Accept: 'text/html,application/xhtml+xml', ...(jar.size ? { Cookie: cookie() } : {}) },
    })
    remember(headers)
    const vars = parseDisconScript(body)
    if (!vars.fact)
      throw new OutageError(
        body.length < 20_000 ? 'blocked' : 'parse',
        body.length < 20_000
          ? `${o.info.operator}: the site served a bot check instead of the schedule`
          : `${o.info.operator}: schedule not found on the page (site changed?)`,
        { region, url: `${base}/ua/shutdowns` },
      )
    const fact = vars.fact as { data?: GpvDays; update?: string }
    csrf = /<meta name="csrf-token" content="([^"]+)"/.exec(body)?.[1] ?? csrf
    // a list the page doesn't carry or that can't be read is asked for on /ua/ajax when needed;
    // the schedule doesn't depend on it
    const list = pageStreets(vars.streets, o.code)
    if (list) streets = { at: Date.now(), value: list }
    return { at: Date.now(), schedule: read(fact, ctx.now()), via: `${base}/ua/shutdowns` }
  }

  /**
   * /ua/ajax, then the page. When both fail the error is the first one's: the route that is
   * tried first. Not tried at all while the site is cooling down after a block.
   */
  const load = async (ctx: ProviderContext): Promise<Session> => {
    guard()
    try {
      const s = await loadAjax(ctx)
      passed()
      return s
    } catch (first) {
      // a cancelled call, or a bug: nothing a second route would mend
      if (!(first instanceof OutageError)) throw first
      try {
        const s = await loadPage(ctx)
        passed()
        return s
      } catch (second) {
        if (!(second instanceof OutageError)) throw second
        // the site is down for the SDK when neither route got through the bot check
        trip(first.code === 'blocked' ? first : second)
        throw first
      }
    }
  }

  /** A new reading, or the one under way: the schedule and an address lookup at the same time share it */
  const reload = (ctx: ProviderContext) => (pending ??= load(ctx).finally(() => (pending = null)))

  const streetsOf = async (ctx: ProviderContext): Promise<Record<string, string[]>> => {
    const kept = () => (streets && Date.now() - streets.at < STREETS_TTL ? streets.value : null)
    if (kept()) return kept()!
    // the page, when it is how the token comes, brings the list along
    if (!csrf) {
      guard()
      await token(ctx).catch((e: unknown) => {
        trip(e)
        throw e
      })
      if (kept()) return kept()!
    }
    const res = await lookup<{ result: boolean; streets?: unknown }>(ctx, { method: 'getStreets' })
    if (!res.result || !res.streets)
      throw new OutageError('parse', `${o.info.operator}: /ua/ajax returned no street list`, { region })
    streets = { at: Date.now(), value: streetsByCity(res.streets, o.code) }
    return streets.value
  }

  const homeNum = async (ctx: ProviderContext, city: string, street: string): Promise<HomeNum> => {
    const key = `${city}\u0000${street}`
    const hit = houseCache.get(key)
    // `fresh` still takes what this same lookup just read (its house list, then the house)
    if (hit && Date.now() - hit.at < (ctx.fresh ? 15_000 : HOUSES_TTL)) return hit.value
    const res = await lookup<HomeNum>(ctx, {
      method: 'getHomeNum',
      'data[0][name]': 'city',
      'data[0][value]': city,
      'data[1][name]': 'street',
      'data[1][value]': street,
    })
    if (!res.result || !res.data)
      throw new OutageError('not-found', `${o.info.operator}: no houses for ${city}, ${street}`, { region })
    if (houseCache.size > 500) houseCache.clear()
    houseCache.set(key, { at: Date.now(), value: res })
    return res
  }

  const record = async (ctx: ProviderContext, house: House, street: Street, city?: City) => {
    const res = await homeNum(ctx, street.cityId ?? city?.id ?? '', street.id)
    const r = res.data?.[house.id]
    const groups = (r?.sub_type_reason ?? []).map((g) => normalizeGroup(g)).filter((g): g is string => !!g)
    const address = { city: city?.name ?? street.cityId, street: street.name, house: house.number }
    return { res, r, groups, address }
  }

  const provider: Provider = {
    info: { ...o.info, capabilities: { schedule: true, addressSearch: true } },
    sampleAddress: o.sampleAddress,

    getSchedules(ctx) {
      // the site is the only channel; days are dated by their own keys in `fact.data` and
      // published at `fact.update`, so a site that stopped moving shows up as old days
      return mergeSources(ctx, region, [
        {
          id: 'site',
          url: `${base}/ua/shutdowns`,
          read: async () => {
            const s = await reload(ctx)
            return { ...asSource(s.schedule), url: s.via }
          },
        },
      ])
    },

    async searchCities(ctx, query) {
      const streets = await streetsOf(ctx)
      return Object.keys(streets).map((name) => ({ id: name, name }))
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${o.info.name}: pick a city first`, { region })
      const streets = await streetsOf(ctx)
      return (streets[city.id] ?? []).map((name) => ({
        id: name,
        name,
        cityId: city.id,
      }))
    },

    async searchHouses(ctx, street) {
      const { data } = await homeNum(ctx, street.cityId ?? '', street.id)
      return Object.keys(data ?? {}).map((number) => ({ id: number, number, streetId: street.id }))
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      const { groups, address } = await record(ctx, house, street, city)
      if (!groups.length)
        throw new OutageError('not-found', `${house.number}, ${street.name} is not in any outage group`, {
          region,
        })
      return {
        region,
        group: groups[0]!,
        ...(groups.length > 1 ? { otherGroups: groups.slice(1) } : {}),
        address,
      }
    },

    async outageOf(ctx, house, street, city): Promise<HouseOutage | null> {
      const { res, r, groups, address } = await record(ctx, house, street, city)
      if (!r)
        throw new OutageError('not-found', `${house.number}, ${street.name}: no such house on the site`, {
          region,
        })
      if (r.cek)
        throw new OutageError(
          'not-found',
          `${house.number}, ${street.name} is served by ЦЕК, not ${o.info.operator}`,
          {
            region,
          },
        )
      const outage = houseOutage(r)
      if (!outage) return null
      return {
        region,
        address,
        ...outage,
        groups,
        updatedAt: parseUaDateTime(res.updateTimestamp),
        url: `${base}/ua/shutdowns`,
        fetchedAt: toKyivIso(ctx.now()),
      }
    },
  }
  return { provider, load: reload }
}

/**
 * One DTEK site as both the schedule channel of a YASNO region and its `houseOutages` provider:
 * one instance, so the two share the site's session (one CSRF handshake, one street list) instead
 * of each loading its own from a site behind a bot check.
 */
export function dtekSiteParts(
  region: RegionId,
  operator: string,
  code: string,
): { source: SourceSpec; provider: Provider } {
  const page = `https://www.dtek-${code}.com.ua/ua/shutdowns`
  const site = dtekSite({ info: { id: region, name: operator, operator, website: page }, code })
  // `fact.update` is one time for every day the site shows: next to another channel, a day that
  // didn't change keeps the time it came with (see `steadyStamps`)
  const steady = steadyStamps()
  return {
    provider: site.provider,
    source: {
      id: 'site',
      url: page,
      read: async (ctx) => {
        const s = await site.load(ctx)
        return { ...steady(asSource(s.schedule)), url: s.via }
      },
    },
  }
}

/** The outage in a house record, the way the site's own page reads it; null = none */
export function houseOutage(
  r: HomeRecord,
): Pick<HouseOutage, 'kind' | 'reason' | 'scheduleApplies' | 'from' | 'to'> | null {
  const reason = (r.sub_type ?? '').trim()
  const from = parseUaDateTime(r.start_date)
  const to = parseUaDateTime(r.end_date)
  if (!reason && !from && !to) return null
  const kind: HouseOutageKind =
    reason === EMERGENCY_REASON || /^екстрен/i.test(reason)
      ? 'emergency'
      : r.type === '1' || /планов/i.test(reason)
        ? 'planned'
        : /стабілізац|згідно\s+графік/i.test(reason)
          ? 'scheduled'
          : /аварійн/i.test(reason)
            ? 'repair'
            : 'other'
  return {
    kind,
    reason: reason || (r.type === '1' ? 'Планові ремонтні роботи' : ''),
    scheduleApplies: kind === 'emergency' ? false : kind === 'scheduled' ? true : null,
    from,
    to,
  }
}

/**
 * The one city of a site whose street list is flat: dtek-kem (Kyiv city) sends `streets` as an
 * array of 2 500 street names, not a map of settlements (17.11.2026); its `getHomeNum` takes
 * "м. Київ" as the city
 */
const ONE_CITY: Record<string, string> = { kem: 'м. Київ' }

/** The page's street list, or null (ask /ua/ajax for it when needed) when it has none or can't be read */
function pageStreets(streets: unknown, code: string): Record<string, string[]> | null {
  if (streets === undefined || streets === null) return null
  try {
    const all = streetsByCity(streets, code)
    return Object.keys(all).length ? all : null
  } catch (e) {
    if (e instanceof OutageError) return null
    throw e
  }
}

/** `streets` as settlement → street names, whichever form the site sent. Exported for tests. */
export function streetsByCity(streets: unknown, code: string): Record<string, string[]> {
  if (Array.isArray(streets)) {
    const city = ONE_CITY[code]
    if (!city)
      throw new OutageError('parse', `DTEK ${code}: a street list without settlements (site changed?)`, {})
    return { [city]: streets.filter((s): s is string => typeof s === 'string') }
  }
  if (streets && typeof streets === 'object') return streets as Record<string, string[]>
  throw new OutageError('parse', `DTEK ${code}: unexpected street list`, {})
}

/** Asks for everything: any real `fact.update` is newer than this one */
const CHECK_ALL = { method: 'checkDisconUpdate', update: '01.01.2000 00:00' }

const xhrHeaders = (base: string) => ({
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
  Origin: base,
  Referer: `${base}/ua/shutdowns`,
})

/**
 * The CSRF token inside the site's `_csrf-dtek-<code>` cookie (Yii2: a signature followed by
 * the PHP-serialized pair of cookie name and token). Exported for tests.
 */
export function csrfFromCookie(cookie: string, code: string): string | null {
  const raw = new RegExp(`(?:^|;\\s*)_csrf-dtek-${code}=([^;]+)`).exec(cookie)?.[1]
  if (!raw) return null
  let value: string
  try {
    value = decodeURIComponent(raw)
  } catch {
    return null
  }
  return /i:1;s:\d+:"([^"]+)";\}$/.exec(value)?.[1] ?? null
}

/**
 * The form of the token the site accepts in `X-CSRF-Token`, the same one it prints in the
 * page's meta tag: base64url of a random mask followed by mask XOR token. Exported for tests.
 */
export function maskCsrfToken(token: string, mask?: Uint8Array): string {
  const bytes = new TextEncoder().encode(token)
  const m = mask ?? globalThis.crypto.getRandomValues(new Uint8Array(bytes.length))
  let bin = ''
  for (const b of m) bin += String.fromCharCode(b)
  bytes.forEach((b, i) => (bin += String.fromCharCode(b ^ m[i]!)))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_')
}

/** Extracts `DisconSchedule.<name> = <json>` assignments (one per line). Exported for tests. */
export function parseDisconScript(html: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const re = /DisconSchedule\.(\w+)\s*=\s*(.+)/g
  for (const m of html.matchAll(re)) {
    const raw = m[2]!
      .replace(/<\/script>.*$/, '')
      .trim()
      .replace(/;$/, '')
    try {
      out[m[1]!] = JSON.parse(raw)
    } catch {
      // non-JSON assignments (functions, expressions) are not data
    }
  }
  return out
}
