import { OutageError } from '../errors.js'
import { cellsToIntervals, compareGroups, normalizeGroup } from '../schedule.js'
import { matchScore, normalizeHouse } from '../text.js'
import { kyivDate, toKyivIso } from '../time.js'
import type {
  City,
  DaySchedule,
  GroupId,
  GroupMatch,
  House,
  IntervalKind,
  RegionInfo,
  RegionSchedule,
  Street,
} from '../types.js'
import type { Provider, ProviderContext } from './provider.js'
import { cookieHeader, mapLimit } from '../util.js'

/**
 * Kirovohradoblenergo (kiroe.com.ua). The /electricity-blackout page hands out a PHP session
 * cookie and an `ajaxToken`; JSON endpoints under it then give today's 48 half-hour cells per
 * group and the address chain ОТГ → settlement → street → house (houses carry their group).
 *
 * Cloudflare in front of the site wants a `Referer` on the POSTs and refuses curl's default
 * User-Agent; the SDK's own User-Agent is accepted, so nothing browser-like is sent.
 *
 * A missing or expired session is not an error on the server side: it answers
 * `200 {"success":true,"data":[]}`, which looks exactly like "no outages". So an empty answer is
 * retried with a new session and then checked against an ОТГ that always has settlements.
 */
const BASE = 'https://kiroe.com.ua/electricity-blackout'
/** Кропивницька ОТГ: always has settlements, so an empty list there means a rejected session. */
const CANARY = '/city/86'
/** The token lifetime isn't documented; renew well before PHP's usual 24 min session timeout. */
const SESSION_TTL_MS = 10 * 60_000

const INFO: RegionInfo = {
  id: 'kirovohrad',
  name: 'Кіровоградська область',
  operator: 'Кіровоградобленерго',
  website: BASE,
  capabilities: { schedule: true, addressSearch: true },
}

// "10" is "можливе відключення", the half hour on each side of an outage block
const CELL: Record<string, IntervalKind | null> = { '0': null, '1': 'off', '10': 'maybe' }

interface Session {
  at: number
  cookie: string
  token: string
  offices: { id: string; name: string }[]
}

interface ApiCity {
  CityId: string
  CityName: string
  CityType?: string
}
interface ApiStreet {
  StreetId: string
  StreetName: string
  StreetType?: string
}
export interface ApiHouse {
  id: string
  HouseName: string
  /** "5.1", or text such as "Не входи" for houses outside the schedule */
  chergGpv: string | null
}

export function kirovohradProvider(): Provider {
  const region = INFO.id
  let current: Promise<Session> | null = null
  let currentAt = 0
  let cities: Promise<City[]> | null = null
  // house id → its number and groups, filled by searchHouses so groupOf needs no extra request
  const houseGroups = new Map<string, { number: string; groups: GroupId[] }>()

  const bootstrap = async (ctx: ProviderContext): Promise<Session> => {
    const { body, headers } = await ctx.http.raw(BASE, {
      region,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    })
    const token = /ajaxToken:\s*"([a-f0-9]+)"/.exec(body)?.[1]
    if (!token)
      throw new OutageError(
        body.length < 20_000 ? 'blocked' : 'parse',
        body.length < 20_000
          ? `${INFO.operator}: the site served something else instead of the schedule page`
          : `${INFO.operator}: no ajaxToken on the schedule page (site changed?)`,
        { region, url: BASE },
      )
    return { at: Date.now(), cookie: cookieHeader(headers), token, offices: parseOffices(body) }
  }

  const session = (ctx: ProviderContext, renew = false): Promise<Session> => {
    if (renew || !current || Date.now() - currentAt > SESSION_TTL_MS) {
      currentAt = Date.now()
      const p = bootstrap(ctx)
      current = p
      p.catch(() => {
        if (current === p) current = null
      })
    }
    return current
  }

  const post = async (ctx: ProviderContext, s: Session, path: string): Promise<unknown> => {
    const res = await ctx.http.json<{ success?: boolean; data?: unknown }>(`${BASE}${path}`, {
      region,
      method: 'POST',
      body: new URLSearchParams({ ajax: '1', token: s.token }),
      headers: {
        Referer: BASE,
        Cookie: s.cookie,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
    })
    if (!res || typeof res !== 'object' || res.success !== true)
      throw new OutageError('parse', `${INFO.operator} ${path}: unexpected answer`, {
        region,
        url: `${BASE}${path}`,
      })
    return res.data
  }

  /** POST with the session; an empty answer is double-checked so a dead session never reads as "nothing". */
  const api = async (ctx: ProviderContext, path: string): Promise<unknown> => {
    const started = Date.now()
    let s = await session(ctx)
    let data = await post(ctx, s, path)
    if (!isEmpty(data)) return data
    if (s.at < started) {
      // the session predates this call and may have expired: try once with a new one
      s = await session(ctx, true)
      data = await post(ctx, s, path)
      if (!isEmpty(data)) return data
    }
    if (path === CANARY || isEmpty(await post(ctx, s, CANARY))) {
      current = null
      throw new OutageError(
        'blocked',
        `${INFO.operator}: the site ignores our session (empty answers even for a known ОТГ), so its data can't be trusted`,
        { region, url: `${BASE}${path}` },
      )
    }
    return data
  }

  const list = async <T>(ctx: ProviderContext, path: string): Promise<T[]> => {
    const data = await api(ctx, path)
    if (isEmpty(data)) return []
    if (!Array.isArray(data))
      throw new OutageError('parse', `${INFO.operator} ${path}: expected a list`, { region })
    return data as T[]
  }

  return {
    info: INFO,
    sampleAddress: { city: 'Кропивницький', street: 'вул. Велика Перспективна', house: '2' },

    async getSchedules(ctx) {
      return parseGraphs(await api(ctx, '/actual-gpv-graphs'), ctx.now())
    },

    async searchCities(ctx, query) {
      // settlements are only listed per ОТГ: fetch all ОТГ once and keep them
      cities ??= (async () => {
        const { offices } = await session(ctx)
        if (!offices.length)
          throw new OutageError('parse', `${INFO.operator}: no ОТГ list on the page`, { region })
        const lists = await mapLimit(offices, 6, async (o) =>
          (await list<ApiCity>(ctx, `/city/${o.id}`))
            .filter((c) => c.CityName?.trim())
            .map((c): City => ({
              id: String(c.CityId),
              name: [c.CityType?.trim(), c.CityName.trim()].filter(Boolean).join(' '),
              district: `${o.name} громада`,
            })),
        )
        return lists.flat()
      })().catch((e) => {
        cities = null
        throw e
      })
      return (await cities).filter((c) => matchScore(query, c.name, 'settlement') > 0)
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
      return (await list<ApiStreet>(ctx, `/street/${city.id}`))
        .map((s): Street => ({ id: String(s.StreetId), name: streetName(s), cityId: city.id }))
        .filter((s) => matchScore(query, s.name) > 0)
    },

    async searchHouses(ctx, street) {
      const houses = mergeHouses(await list<ApiHouse>(ctx, `/house/${street.id}`))
      if (houseGroups.size > 5000) houseGroups.clear()
      return houses.map((h): House => {
        houseGroups.set(h.id, h)
        return { id: h.id, number: h.number, streetId: street.id }
      })
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      let groups = houseGroups.get(house.id)?.groups
      if (!groups) {
        const info = await api(ctx, `/get-house-info/${house.id}`)
        if (isEmpty(info) || typeof info !== 'object')
          throw new OutageError('not-found', `House "${house.number}" not found on ${street.name}`, {
            region,
          })
        groups = mergeHouses([info as ApiHouse])[0]?.groups ?? []
      }
      if (!groups.length)
        throw new OutageError(
          'not-found',
          `${house.number}, ${street.name}: not in the outage schedule ("не входить")`,
          {
            region,
          },
        )
      return {
        region,
        group: groups[0]!,
        ...(groups.length > 1 ? { otherGroups: groups.slice(1) } : {}),
        address: { city: city?.name, street: street.name, house: house.number },
      }
    },
  }
}

/**
 * `{ "1.1": { "times": { "00:00": "0", …, "23:30": "1" } }, … }` → today's schedule.
 * The answer carries no date: it is always the current Kyiv day. Exported for tests.
 */
export function parseGraphs(data: unknown, now: Date): RegionSchedule {
  const region = INFO.id
  const date = kyivDate(now)
  const schedules: Record<string, DaySchedule[]> = {}
  if (!isEmpty(data)) {
    if (typeof data !== 'object' || Array.isArray(data))
      throw new OutageError('parse', `${INFO.operator}: schedule is not an object of groups`, { region })
    for (const [rawGroup, value] of Object.entries(
      data as Record<string, { times?: Record<string, string> }>,
    )) {
      const group = normalizeGroup(rawGroup)
      const times = value?.times
      if (!group || !times || typeof times !== 'object')
        throw new OutageError('parse', `${INFO.operator}: unexpected schedule entry "${rawGroup}"`, {
          region,
        })
      const cells: (IntervalKind | null | undefined)[] = new Array(48).fill(undefined)
      for (const [clock, state] of Object.entries(times)) {
        const m = /^(\d{2}):(00|30)$/.exec(clock)
        const kind = CELL[String(state)]
        if (!m || kind === undefined || Number(m[1]) > 23)
          throw new OutageError(
            'parse',
            `${INFO.operator}: unexpected cell ${clock}="${state}" for ${group}`,
            { region },
          )
        cells[Number(m[1]) * 2 + (m[2] === '30' ? 1 : 0)] = kind
      }
      if (cells.includes(undefined))
        throw new OutageError(
          'parse',
          `${INFO.operator}: group ${group} has ${Object.keys(times).length} cells, expected 48`,
          {
            region,
          },
        )
      schedules[group] = [
        { date, status: 'scheduled', intervals: cellsToIntervals(date, cells as (IntervalKind | null)[]) },
      ]
    }
  }
  return {
    region,
    groups: Object.keys(schedules).sort(compareGroups),
    schedules,
    // the operator publishes no change time for the schedule
    updatedAt: null,
    fetchedAt: toKyivIso(now),
  }
}

/** `<select id="fn_office">` on the page. Exported for tests. */
export function parseOffices(html: string): { id: string; name: string }[] {
  const select = /<select[^>]*id="fn_office"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? ''
  return [...select.matchAll(/<option[^>]*value="(\d+)"[^>]*>([^<]*)/g)].map((m) => ({
    id: m[1]!,
    name: m[2]!
      .replace(/&#0?39;/g, "'")
      .replace(/&amp;/g, '&')
      .trim(),
  }))
}

/**
 * The house list spells one building several ways ("10а", "10-А", "10А"), sometimes with
 * different groups: merge them by normalized number, real groups first.
 */
function mergeHouses(rows: ApiHouse[]): { id: string; number: string; groups: GroupId[] }[] {
  const byKey = new Map<string, { id: string; number: string; groups: GroupId[] }>()
  for (const r of rows) {
    const number = String(r.HouseName ?? '').trim()
    if (!number) continue
    const key = normalizeHouse(number)
    const h = byKey.get(key) ?? { id: String(r.id), number, groups: [] }
    byKey.set(key, h)
    const group = /^\s*\d+\s*\.\s*\d+\s*$/.test(r.chergGpv ?? '') ? normalizeGroup(r.chergGpv!) : null
    if (group && !h.groups.includes(group)) h.groups.push(group)
  }
  return [...byKey.values()]
}

/** `StreetName` usually has the type already ("вул. …"); `StreetType` is mostly empty. */
function streetName(s: ApiStreet): string {
  const name = s.StreetName.trim()
  const type = s.StreetType?.trim()
  return type && !name.toLowerCase().startsWith(type.toLowerCase()) ? `${type} ${name}` : name
}

function isEmpty(data: unknown): boolean {
  if (data == null || data === '' || data === false) return true
  if (Array.isArray(data)) return data.length === 0
  return typeof data === 'object' && Object.keys(data).length === 0
}
