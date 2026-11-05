import { OutageError } from '../errors.js'
import { normalizeGroup } from '../schedule.js'
import { matchScore } from '../text.js'
import type { AddressQuery, GroupMatch, RegionInfo, RegionSchedule } from '../types.js'
import { gpvRegionSchedule, type GpvDays } from './gpv.js'
import type { Provider, ProviderContext } from './provider.js'

/**
 * DTEK grid-operator sites (www.dtek-<code>.com.ua). The /ua/shutdowns page embeds the
 * schedule and the region's whole street list as JS assignments; house → group needs a
 * POST to /ua/ajax with the session cookie and CSRF token from that page.
 *
 * The sites sit behind Imperva. Some of them challenge non-browser clients; that surfaces
 * as an `OutageError` with code `blocked`. This SDK does not try to get around it.
 */

interface Session {
  at: number
  cookie: string
  csrf: string | null
  streets: Record<string, string[]>
  schedule: RegionSchedule
}

interface HomeNum {
  result: boolean
  data?: Record<string, { sub_type_reason?: string[] }>
}

const SESSION_TTL = 10 * 60_000

export interface DtekOptions {
  info: Omit<RegionInfo, 'capabilities'>
  /** Site code: kem, krem, dnem, dem, oem */
  code: string
  sampleAddress?: AddressQuery
}

export function dtekProvider(o: DtekOptions): Provider {
  const region = o.info.id
  const base = `https://www.dtek-${o.code}.com.ua`
  let session: Session | null = null
  let pending: Promise<Session> | null = null
  const houseCache = new Map<string, HomeNum['data']>()

  const load = async (ctx: ProviderContext): Promise<Session> => {
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
      schedule: gpvRegionSchedule(region, fact.data, fact.update, ctx.now()),
    }
    session = s
    houseCache.clear()
    return s
  }

  const ensure = async (ctx: ProviderContext) => {
    if (session && Date.now() - session.at < SESSION_TTL) return session
    pending ??= load(ctx).finally(() => (pending = null))
    return pending
  }

  const homeNum = async (ctx: ProviderContext, city: string, street: string) => {
    const key = `${city}\u0000${street}`
    const hit = houseCache.get(key)
    if (hit) return hit
    const s = await ensure(ctx)
    if (!s.csrf) throw new OutageError('parse', `${o.info.operator}: no CSRF token on the page`, { region })
    const form = new URLSearchParams({
      method: 'getHomeNum',
      'data[0][name]': 'city',
      'data[0][value]': city,
      'data[1][name]': 'street',
      'data[1][value]': street,
    })
    const res = await ctx.http.json<HomeNum>(`${base}/ua/ajax`, {
      region,
      method: 'POST',
      body: form,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-CSRF-Token': s.csrf,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${base}/ua/shutdowns`,
        Cookie: s.cookie,
      },
    })
    if (!res.result || !res.data)
      throw new OutageError('not-found', `${o.info.operator}: no houses for ${city}, ${street}`, { region })
    houseCache.set(key, res.data)
    return res.data
  }

  return {
    info: { ...o.info, capabilities: { schedule: true, addressSearch: true } },
    sampleAddress: o.sampleAddress,

    async getSchedules(ctx) {
      return (await load(ctx)).schedule
    },

    async searchCities(ctx, query) {
      const s = await ensure(ctx)
      return filterByName(Object.keys(s.streets), query, 'settlement').map((name) => ({ id: name, name }))
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${o.info.name}: pick a city first`, { region })
      const s = await ensure(ctx)
      return filterByName(s.streets[city.id] ?? [], query, 'street').map((name) => ({
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
        throw new OutageError('not-found', `${house.number}, ${street.name} is not in any outage group`, { region })
      return {
        region,
        group: groups[0]!,
        ...(groups.length > 1 ? { otherGroups: groups.slice(1) } : {}),
        address: { city: city?.name ?? street.cityId, street: street.name, house: house.number },
      }
    },
  }
}

/** Extracts `DisconSchedule.<name> = <json>` assignments (one per line). Exported for tests. */
export function parseDisconScript(html: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const re = /DisconSchedule\.(\w+)\s*=\s*(.+)/g
  for (const m of html.matchAll(re)) {
    const raw = m[2]!.replace(/<\/script>.*$/, '').trim().replace(/;$/, '')
    try {
      out[m[1]!] = JSON.parse(raw)
    } catch {
      // non-JSON assignments (functions, expressions) are not data
    }
  }
  return out
}

function cookieHeader(headers: Headers): string {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  return list.map((c) => c.split(';')[0]).join('; ')
}

function filterByName(names: string[], query: string, kind: 'street' | 'settlement'): string[] {
  return names
    .map((n) => ({ n, s: matchScore(query, n, kind) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 50)
    .map((x) => x.n)
}

