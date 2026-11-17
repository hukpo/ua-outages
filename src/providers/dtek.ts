import { OutageError } from '../errors.js'
import { STANDARD_GROUPS } from '../image/table.js'
import { normalizeGroup, unpublished } from '../schedule.js'
import type { AddressQuery, GroupMatch, ProviderInfo, RegionSchedule } from '../types.js'
import { asSource } from './as-source.js'
import { gpvRegionSchedule, type GpvDays } from './gpv.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources } from './sources.js'
import { cookieHeader } from '../util.js'

/**
 * DTEK grid-operator sites (www.dtek-<code>.com.ua). The /ua/shutdowns page embeds the
 * schedule and the region's whole street list as JS assignments; house → group needs a
 * POST to /ua/ajax with the session cookie and CSRF token from that page.
 *
 * The sites sit behind Imperva. Some of them challenge non-browser clients on the page; that
 * surfaces as an `OutageError` with code `blocked`.
 *
 * `route: 'ajax'` skips the page: /ua/ajax alone gives the same three things (`checkDisconUpdate`
 * the schedule, `getStreets` the street list, `getHomeNum` the houses). A first POST without a
 * token is refused with 400 and sets the CSRF cookie; the token for the next ones is derived
 * from that cookie the way the page's own meta tag is. Kyiv region is read this way, because its
 * page is challenged and its /ua/ajax is not. Where /ua/ajax is challenged too (Donetsk), the
 * result is still `blocked`.
 */

interface Session {
  at: number
  cookie: string
  csrf: string | null
  /** null until asked for on the ajax route, where the list is a request of its own */
  streets: Record<string, string[]> | null
  schedule: RegionSchedule
}

interface DisconUpdate {
  result: boolean
  fact?: { data?: GpvDays; update?: string }
}

interface HomeNum {
  result: boolean
  data?: Record<string, { sub_type_reason?: string[] }>
}

const SESSION_TTL = 10 * 60_000

export interface DtekOptions {
  info: Omit<ProviderInfo, 'capabilities'>
  /** Site code: kem, krem, dnem, dem, oem */
  code: string
  /** Where the schedule and the street list come from; default `page` */
  route?: 'page' | 'ajax'
  sampleAddress?: AddressQuery
}

export function dtekProvider(o: DtekOptions): Provider {
  const region = o.info.id
  const base = `https://www.dtek-${o.code}.com.ua`
  let session: Session | null = null
  let pending: Promise<Session> | null = null
  const houseCache = new Map<string, HomeNum['data']>()

  const sourceUrl = o.route === 'ajax' ? `${base}/ua/ajax` : `${base}/ua/shutdowns`

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
    }
    session = s
    houseCache.clear()
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
      streets: (vars.streets as Record<string, string[]>) ?? {},
      schedule: read(fact, ctx.now()),
    }
    session = s
    houseCache.clear()
    return s
  }

  const load = o.route === 'ajax' ? loadAjax : loadPage

  const ensure = async (ctx: ProviderContext) => {
    if (session && Date.now() - session.at < SESSION_TTL) return session
    pending ??= load(ctx).finally(() => (pending = null))
    return pending
  }

  const streetsOf = async (ctx: ProviderContext): Promise<Record<string, string[]>> => {
    const s = await ensure(ctx)
    if (s.streets) return s.streets
    if (!s.csrf) throw new OutageError('parse', `${o.info.operator}: no CSRF token`, { region })
    const res = await post<{ result: boolean; streets?: Record<string, string[]> }>(
      ctx,
      { cookie: s.cookie, csrf: s.csrf },
      { method: 'getStreets' },
    )
    if (!res.result || !res.streets)
      throw new OutageError('parse', `${o.info.operator}: /ua/ajax returned no street list`, { region })
    return (s.streets = res.streets)
  }

  const homeNum = async (ctx: ProviderContext, city: string, street: string) => {
    const key = `${city}\u0000${street}`
    const hit = houseCache.get(key)
    if (hit) return hit
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
    houseCache.set(key, res.data)
    return res.data
  }

  return {
    info: { ...o.info, capabilities: { schedule: true, addressSearch: true } },
    sampleAddress: o.sampleAddress,

    getSchedules(ctx) {
      // the site is the only channel; days are dated by their own keys in `fact.data` and
      // published at `fact.update`, so a site that stopped moving shows up as old days
      return mergeSources(ctx, region, [
        { id: 'site', url: sourceUrl, read: async () => asSource((await load(ctx)).schedule) },
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
      const data = await homeNum(ctx, street.cityId ?? '', street.id)
      return Object.keys(data ?? {}).map((number) => ({ id: number, number, streetId: street.id }))
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      const data = await homeNum(ctx, street.cityId ?? city?.id ?? '', street.id)
      const groups = (data?.[house.id]?.sub_type_reason ?? [])
        .map((g) => normalizeGroup(g))
        .filter((g): g is string => !!g)
      if (!groups.length)
        throw new OutageError('not-found', `${house.number}, ${street.name} is not in any outage group`, {
          region,
        })
      return {
        region,
        group: groups[0]!,
        ...(groups.length > 1 ? { otherGroups: groups.slice(1) } : {}),
        address: { city: city?.name ?? street.cityId, street: street.name, house: house.number },
      }
    },
  }
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
