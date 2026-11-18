import { OutageError } from '../errors.js'
import { cellsToIntervals, normalizeGroup } from '../schedule.js'
import { normalizeHouse } from '../text.js'
import { addDays, kyivDate, kyivMinuteOfDay } from '../time.js'
import type {
  City,
  DaySchedule,
  GroupId,
  GroupMatch,
  House,
  IntervalKind,
  ProviderInfo,
  Street,
} from '../types.js'
import {
  KIROVOHRAD_CHANNEL,
  KIROVOHRAD_GROUPS,
  gpvVersionsToSource,
  type GpvChannel,
  readGpvChannel,
  standingVersions,
  type GpvVersion,
} from './kirovohrad-telegram.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'
import { SharedTask, cookieHeader, mapLimit } from '../util.js'

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
 *
 * The grid is today only, and carries neither a date nor a change time. Tomorrow, and the time
 * of every change, come from the operator's Telegram channel (`kirovohrad-telegram.ts`), which
 * posts each day's list the evening before. The two are merged per day by publication time; the
 * grid gets the date and time of the channel's list it shows (`dateGrid`).
 */
const BASE = 'https://kiroe.com.ua/electricity-blackout'
/** Кропивницька ОТГ: always has settlements, so an empty list there means a rejected session. */
const CANARY = '/city/86'
/** The token lifetime isn't documented; renew well before PHP's usual 24 min session timeout. */
const SESSION_TTL_MS = 10 * 60_000
/**
 * After midnight the grid may still be yesterday's (it had flipped by 00:25 on 17.11.2026; the
 * exact minute isn't known). Until this long past midnight a grid the channel can't confirm
 * isn't given a date.
 */
const MIDNIGHT_DOUBT_MIN = 60

const INFO: ProviderInfo = {
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
  let current: SharedTask<Session> | null = null
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
    if (renew || !current || current.aborted || Date.now() - currentAt > SESSION_TTL_MS) {
      currentAt = Date.now()
      // shared by concurrent calls: one caller cancelling doesn't fail the others, and it is
      // cancelled only when every caller waiting for it has given up
      const task = new SharedTask((signal) =>
        bootstrap({ ...ctx, http: ctx.http.withSignal(signal), signal }),
      )
      current = task
      task.promise.catch(() => {
        if (current === task) current = null
      })
    }
    return current.join(ctx.signal)
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
      // read once, used twice: as a source of its own, and to date the site's grid
      let channel: Promise<GpvChannel> | undefined
      const versions = () => (channel ??= readGpvChannel(ctx))
      let sameList = false
      const s = await mergeSources(
        ctx,
        region,
        [
          {
            id: 'site',
            url: BASE,
            read: async () => {
              const grid = parseGrid(await api(ctx, '/actual-gpv-graphs'))
              // the channel being down is its own failure; the grid then stands undated by it
              const known = await versions().catch(() => null)
              const now = ctx.now()
              sameList = !!grid && !!known && showsStandingList(grid, known.versions, now)
              const read = gridToSource(grid, known?.versions ?? null, now)
              // a newer post the channel couldn't read: its versions don't vouch for the grid's time
              for (const [date, day] of Object.entries(read.days))
                if (known?.unread.has(date)) day.publishedAt = null
              return read
            },
          },
          {
            id: `telegram:@${KIROVOHRAD_CHANNEL}`,
            url: `https://t.me/s/${KIROVOHRAD_CHANNEL}`,
            read: async () => gpvVersionsToSource(await versions(), ctx.now()),
          },
        ],
        { groups: KIROVOHRAD_GROUPS },
      )
      // `mergeSources` compares "possible" half hours too, which only the grid has: the same
      // list on both isn't a disagreement
      if (sameList) for (const source of s.sources ?? []) delete source.disagrees
      return s
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
      return cities
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
      return (await list<ApiStreet>(ctx, `/street/${city.id}`)).map((s): Street => ({
        id: String(s.StreetId),
        name: streetName(s),
        cityId: city.id,
      }))
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

/** A group's 48 half-hour cells of the day; `null` = power on */
export type Grid = Record<GroupId, (IntervalKind | null)[]>

/**
 * `{ "1.1": { "times": { "00:00": "0", …, "23:30": "1" } }, … }` → cells per group; null when
 * the answer is empty. The answer carries no date. Exported for tests.
 */
export function parseGrid(data: unknown): Grid | null {
  const region = INFO.id
  if (isEmpty(data)) return null
  if (typeof data !== 'object' || Array.isArray(data))
    throw new OutageError('parse', `${INFO.operator}: schedule is not an object of groups`, { region })
  const grid: Grid = {}
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
        throw new OutageError('parse', `${INFO.operator}: unexpected cell ${clock}="${state}" for ${group}`, {
          region,
        })
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
    grid[group] = cells as (IntervalKind | null)[]
  }
  return grid
}

/** Which half hours are `off`, group by group: what a grid and a channel list can be compared by */
const gridOff = (grid: Grid) =>
  KIROVOHRAD_GROUPS.map((g) => (grid[g] ?? []).map((c) => (c === 'off' ? '1' : '0')).join('')).join('|')

/** The same for a channel list; null when it has times a half-hour grid can't show */
function versionOff(v: GpvVersion): string | null {
  const rows: string[] = []
  for (const g of KIROVOHRAD_GROUPS) {
    const cells = new Array<string>(48).fill('0')
    for (const s of v.slots[g] ?? []) {
      if (s.start % 30 || s.end % 30) return null
      cells.fill('1', s.start / 30, s.end / 30)
    }
    rows.push(cells.join(''))
  }
  return rows.join('|')
}

/**
 * Which day the grid shows and when the operator published it, told from the channel's lists:
 * the grid's `off` half hours equal those of the list it was drawn from (checked on 17.11.2026:
 * grid = post 1828 plus a "possible" half hour on each side of a block).
 *
 * - It equals a list for today: today, published when that list was. The newest such list is
 *   taken, so a grid showing the current list ties with the channel and, being the first
 *   source, wins the day (it has the "possible" half hours the text lacks). A grid still showing
 *   a list the channel has since replaced or cancelled is older than the channel's day and loses.
 * - Else it is blank and the channel's last word up to today is "скасовано до окремого
 *   розпорядження": that order covers today, and a blank grid is what it looks like. Today,
 *   published when the cancellation was.
 * - Else it equals a list for yesterday: the site hasn't moved to the new day yet. Yesterday.
 *   Never by a cancellation: that has no hours, and a blank grid equals every blank day, so
 *   yesterday's cancellation says nothing about which day a blank grid is.
 * - Else nothing confirms it. In the first hour after midnight it gets no date at all (null);
 *   later it is today's with no publication time, so any dated list of the channel wins the day
 *   and the grid is reported as disagreeing.
 *
 * `versions` is null when the channel couldn't be read. Exported for tests.
 */
export function dateGrid(
  grid: Grid,
  versions: readonly GpvVersion[] | null,
  now: Date,
): { date: string; publishedAt: string | null } | null {
  const today = kyivDate(now)
  const off = gridOff(grid)
  const yesterday = addDays(today, -1)
  // newest first
  const newest = [...(versions ?? [])].reverse()
  /** The newest statement about `date` the grid equals; a cancellation counts when `blank` */
  const shown = (date: string, blank: boolean) =>
    newest.find((v) => v.date === date && (blank || !v.cancelled) && versionOff(v) === off)
  const current = shown(today, true)
  if (current) return { date: today, publishedAt: current.at }
  const last = newest.find((v) => v.date <= today)
  if (last?.untilFurtherOrder && !off.includes('1')) return { date: today, publishedAt: last.at }
  const old = shown(yesterday, false)
  if (old) return { date: yesterday, publishedAt: old.at }
  return kyivMinuteOfDay(now) < MIDNIGHT_DOUBT_MIN ? null : { date: today, publishedAt: null }
}

/** The grid shows the list that stands in the channel for the day it is dated: one publication, seen twice */
function showsStandingList(grid: Grid, versions: readonly GpvVersion[], now: Date): boolean {
  const date = dateGrid(grid, versions, now)?.date
  const standing = date === undefined ? undefined : standingVersions(versions).get(date)
  return !!standing && versionOff(standing) === gridOff(grid)
}

/** The site as a schedule source: its one day, dated by `dateGrid`. Exported for tests. */
export function gridToSource(
  grid: Grid | null,
  versions: readonly GpvVersion[] | null,
  now: Date,
): SourceRead {
  const groups = [...KIROVOHRAD_GROUPS]
  const dated = grid && dateGrid(grid, versions, now)
  if (!grid || !dated) return { days: {}, groups }
  const schedules: Record<GroupId, DaySchedule> = {}
  for (const [group, cells] of Object.entries(grid))
    schedules[group] = {
      date: dated.date,
      status: 'scheduled',
      intervals: cellsToIntervals(dated.date, cells),
    }
  return { days: { [dated.date]: { schedules, publishedAt: dated.publishedAt } }, groups }
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
