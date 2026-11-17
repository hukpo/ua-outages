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
import { cookieHeader } from '../util.js'

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
 */

interface Session {
  at: number
  cookie: string
  csrf: string | null
  /** null until asked for on the ajax route, where the list is a request of its own */
  streets: Record<string, string[]> | null
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

const SESSION_TTL = 10 * 60_000
/** Per-street house records: groups barely change, but the outage in them does */
const HOUSES_TTL = 5 * 60_000

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
  let session: Session | null = null
  let pending: Promise<Session> | null = null
  const houseCache = new Map<string, { at: number; value: HomeNum }>()

  const post = <T>(
    ctx: ProviderContext,
    auth: { cookie: string; csrf: string },
    form: Record<string, string>,
  ) =>
    ctx.http.json<T>(`${base}/ua/ajax`, {
      region,
      method: 'POST',
      body: new URLSearchParams(form),
      headers: { ...xhrHeaders(base), 'X-CSRF-Token': auth.csrf, Cookie: auth.cookie },
    })

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
    const url = `${base}/ua/ajax`
    // refused for the missing token (400), but the refusal carries the CSRF cookie
    const first = await ctx.http.raw(url, {
      region,
      method: 'POST',
      body: new URLSearchParams(CHECK_ALL),
      headers: xhrHeaders(base),
      acceptStatus: [400],
    })
    const cookie = cookieHeader(first.headers)
    const token = csrfFromCookie(cookie, o.code)
    if (!token)
      throw new OutageError('parse', `${o.info.operator}: no CSRF cookie from /ua/ajax (site changed?)`, {
        region,
        url,
        status: first.status,
      })
    const auth = { cookie, csrf: maskCsrfToken(token) }
    const res = await post<DisconUpdate>(ctx, auth, CHECK_ALL)
    if (!res.result || !res.fact)
      throw new OutageError('parse', `${o.info.operator}: /ua/ajax returned no schedule (site changed?)`, {
        region,
        url,
      })
    const s: Session = {
      at: Date.now(),
      ...auth,
      streets: null,
      schedule: read(res.fact, ctx.now()),
      via: url,
    }
    session = s
    return s
  }

  const loadPage = async (ctx: ProviderContext): Promise<Session> => {
    const { body, headers } = await ctx.http.raw(`${base}/ua/shutdowns`, {
      region,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    })
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
    const s: Session = {
      at: Date.now(),
      cookie: cookieHeader(headers),
      csrf: /<meta name="csrf-token" content="([^"]+)"/.exec(body)?.[1] ?? null,
      // a list the page doesn't carry or that can't be read is asked for on /ua/ajax when needed;
      // the schedule doesn't depend on it
      streets: pageStreets(vars.streets, o.code),
      schedule: read(fact, ctx.now()),
      via: `${base}/ua/shutdowns`,
    }
    session = s
    return s
  }

  /** /ua/ajax, then the page. When both fail the error is the first one's: the route that is tried first */
  const load = async (ctx: ProviderContext): Promise<Session> => {
    try {
      return await loadAjax(ctx)
    } catch (first) {
      // a cancelled call, or a bug: nothing a second route would mend
      if (!(first instanceof OutageError)) throw first
      try {
        return await loadPage(ctx)
      } catch (second) {
        if (!(second instanceof OutageError)) throw second
        throw first
      }
    }
  }

  /** A new session, or the one being loaded: the schedule and an address lookup at the same time share it */
  const reload = (ctx: ProviderContext) => (pending ??= load(ctx).finally(() => (pending = null)))

  const ensure = async (ctx: ProviderContext) => {
    if (session && Date.now() - session.at < SESSION_TTL) return session
    return reload(ctx)
  }

  const streetsOf = async (ctx: ProviderContext): Promise<Record<string, string[]>> => {
    const s = await ensure(ctx)
    if (s.streets) return s.streets
    if (!s.csrf) throw new OutageError('parse', `${o.info.operator}: no CSRF token`, { region })
    const res = await post<{ result: boolean; streets?: unknown }>(
      ctx,
      { cookie: s.cookie, csrf: s.csrf },
      { method: 'getStreets' },
    )
    if (!res.result || !res.streets)
      throw new OutageError('parse', `${o.info.operator}: /ua/ajax returned no street list`, { region })
    return (s.streets = streetsByCity(res.streets, o.code))
  }

  const homeNum = async (ctx: ProviderContext, city: string, street: string): Promise<HomeNum> => {
    const key = `${city}\u0000${street}`
    const hit = houseCache.get(key)
    // `fresh` still takes what this same lookup just read (its house list, then the house)
    if (hit && Date.now() - hit.at < (ctx.fresh ? 15_000 : HOUSES_TTL)) return hit.value
    const s = await ensure(ctx)
    if (!s.csrf) throw new OutageError('parse', `${o.info.operator}: no CSRF token on the page`, { region })
    const res = await post<HomeNum>(
      ctx,
      { cookie: s.cookie, csrf: s.csrf },
      {
        method: 'getHomeNum',
        'data[0][name]': 'city',
        'data[0][value]': city,
        'data[1][name]': 'street',
        'data[1][value]': street,
      },
    )
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
