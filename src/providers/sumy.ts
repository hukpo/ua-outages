import { emergencyQueues } from '../emergency/queues.js'
import { OutageError } from '../errors.js'
import { compareGroups, makeDay, normalizeGroup, slotsToIntervals, type MinuteSlot } from '../schedule.js'
import { normalizeSettlement, normalizeStreet } from '../text.js'
import { addDays, kyivDate, kyivInstant, kyivMinuteOfDay, parseClock, toKyivIso } from '../time.js'
import type {
  City,
  DaySchedule,
  GroupId,
  GroupMatch,
  HouseOutage,
  HouseOutageKind,
  ProviderInfo,
  RegionSchedule,
} from '../types.js'
import { mapLimit } from '../util.js'
import { parseUaDateTime } from './gpv.js'
import { STANDARD_GROUPS } from './poweron.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'

/**
 * Sumyoblenergo. Two channels of the operator, merged per day:
 *
 * - `site` (www.soe.com.ua): the JSON API behind the site's shutdowns page: the outage windows
 *   of all groups in one request, with the operator's change time and WITHOUT a date. It serves
 *   one day and switches to the next one at midnight, although the operator has tomorrow's
 *   schedule from the evening. Also the address chain city → street → house → group;
 * - `e-svitlo` (sm.e-svitlo.com.ua, the customer cabinet the site's header links to): a
 *   schedule endpoint that answers without a login, one group per request, with the same
 *   windows and change time, the date they are for (`date_today`) and a slot for tomorrow.
 *
 * So E-Svitlo is what dates the site's grid and what can have tomorrow before midnight; see
 * `getSchedules` for how few requests that takes.
 *
 * Always use `www.`: the bare domain sits behind a Cloudflare challenge. The API answers 403
 * without a `Referer` (any value) or with a runtime-default User-Agent; the SDK's own UA passes.
 */
const INFO: ProviderInfo = {
  id: 'sumy',
  name: 'Сумська область',
  operator: 'Сумиобленерго',
  website: 'https://www.soe.com.ua/consumers/shutdowns',
  capabilities: { schedule: true, addressSearch: true },
}

const API = 'https://www.soe.com.ua/next-api/shutdowns'
const HEADERS = {
  Referer: 'https://www.soe.com.ua/consumers/shutdowns',
  // what the site itself sends; not checked today
  'X-Source': 'soe-website',
}

/**
 * Every response is `{"payload": base64(iv[12] ‖ AES-256-GCM ciphertext+tag)}`. The site's
 * public JS builds the key as
 *
 *   `qasdw-enjenf-twfeft!!d451qwqw!-${year}-${month}-…`.padEnd(32, "x").slice(0, 32)
 *
 * The prefix is already 31 characters, so the slice keeps only the first digit of the year
 * and the key is effectively constant. This is client-side obfuscation, not access control;
 * if the site changes the key, decryption fails with a `parse` error and this needs updating.
 */
const PAYLOAD_KEY = 'qasdw-enjenf-twfeft!!d451qwqw!-2'
const IV_BYTES = 12

const CABINET = 'https://sm.e-svitlo.com.ua'
/** `POST cherga=<group>&mobile_v=true`, no cookies. Without `cherga` it answers `no_data`: there is no all-groups call */
const CABINET_API = `${CABINET}/ip_cabinet/restfull_api/improvise/api_main/get_user_disconnections_image_api.json`
/** The group asked first; the other eleven only when needed */
const PROBE_GROUP = '1.1'
/** Parallel E-Svitlo requests when all groups are needed */
const CABINET_CONCURRENCY = 3

/** Index of the hourly schedule (ГПВ) queue in `queues-by-street` rows: ГАВ, АЧР, СГАВ, ГПВ, САВН, ГОП, ГОЕ */
const GPV_QUEUE_INDEX = 3
/** …and of the emergency ones (the order of the site's own type map) */
const GAV_INDEX = 0
const ACHR_INDEX = 1
const SGAV_INDEX = 2

interface ScheduleEntry {
  cherga_n?: string
  no_data?: boolean
  /** "Оновлено: 05.11.2026 21:21" */
  last_update?: string
  lst_time_disc?: { start_time?: string; end_time?: string }[]
}
/** Address lists: `[[id, name], …]`; `data` is "" when the query is too short. */
interface ListResponse<Row> {
  data?: { result?: number; list?: Row[] } | ''
}
type QueueRow = [city: string, street: string, house: string, queues: (string | null)[]]
/** A row of `by-house` / `by-street`: an outage of one house, now or ahead. The last two were always "" */
export type ShutdownRow = [
  city: string,
  street: string,
  house: string,
  start: string,
  end: string,
  type: number,
  ...rest: unknown[],
]

/** A house's outages are read once per this */
const SHUTDOWNS_TTL_MS = 5 * 60_000
/** `fresh` still takes what the same call has just read */
const FRESH_TTL_MS = 15_000

export function sumyProvider(): Provider {
  const region = INFO.id
  let key: Promise<CryptoKey> | null = null
  const shutdowns = new Map<string, { at: number; rows: Promise<ShutdownRow[]> }>()

  const get = async <T>(ctx: ProviderContext, path: string): Promise<T> => {
    const url = `${API}/${path}`
    const res = await ctx.http.json<{ payload?: unknown; data?: unknown }>(url, { region, headers: HEADERS })
    key ??= importPayloadKey()
    return decryptSumyResponse<T>(res, await key, url)
  }

  const list = async <Row>(ctx: ProviderContext, path: string): Promise<Row[]> => {
    const { data } = await get<ListResponse<Row>>(ctx, path)
    if (data === '' || data === undefined) return []
    if (!Array.isArray(data.list))
      throw new OutageError('parse', `Sumy ${path.split('?')[0]}: expected a list`, { region })
    return data.list
  }

  return {
    info: INFO,
    remoteSearch: { cities: true, streets: true },
    sampleAddress: { city: 'Шостка', street: 'вул. Шевченка', house: '14' },

    /**
     * The site's grid (one request) and E-Svitlo's answer for one group are read together. The
     * other eleven groups are asked from E-Svitlo only when that pays: its tomorrow slot is
     * filled, the site failed, or the two differ (so E-Svitlo's dated days stand on their own).
     * Otherwise E-Svitlo only dates the site's grid and supplies no day itself.
     */
    async getSchedules(ctx) {
      const now = ctx.now()
      const ask = async (group: GroupId) =>
        parseCabinetAnswer(
          await ctx.http.json(CABINET_API, {
            region,
            method: 'POST',
            body: new URLSearchParams({ cherga: group, mobile_v: 'true' }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          }),
          group,
          now,
        )
      const [site, probe] = await Promise.allSettled([
        get<{ data?: ScheduleEntry[] }>(ctx, 'schedules').then(parseSumyGrid),
        ask(PROBE_GROUP),
      ])
      ctx.signal?.throwIfAborted()

      let cabinet: PromiseSettledResult<CabinetGroup[]> =
        probe.status === 'fulfilled' ? { status: 'fulfilled', value: [probe.value] } : probe
      const needAll =
        probe.status === 'fulfilled' &&
        (site.status === 'rejected' ||
          probe.value.tomorrowAnnounced ||
          dateOfGrid(site.value, [probe.value]) === null)
      if (needAll) {
        const rest = STANDARD_GROUPS.filter((g) => g !== PROBE_GROUP)
        const [all] = await Promise.allSettled([mapLimit(rest, CABINET_CONCURRENCY, ask, ctx.signal)])
        ctx.signal?.throwIfAborted()
        cabinet =
          all.status === 'fulfilled'
            ? {
                status: 'fulfilled',
                value: [(probe as PromiseFulfilledResult<CabinetGroup>).value, ...all.value],
              }
            : all
      }
      // when the other groups couldn't be read, the first answer still dates the grid
      const dated =
        cabinet.status === 'fulfilled' ? cabinet.value : probe.status === 'fulfilled' ? [probe.value] : null

      return mergeSources(
        ctx,
        region,
        [
          {
            id: 'site',
            url: INFO.website,
            async read() {
              if (site.status === 'rejected') throw site.reason
              return gridToRead(site.value, dated, now)
            },
          },
          {
            id: 'e-svitlo',
            url: `${CABINET}/`,
            async read() {
              if (cabinet.status === 'rejected') throw cabinet.reason
              // one group alone is not a day of the region: it only dated the site's grid
              return needAll ? cabinetToRead(cabinet.value) : { days: {}, groups: [PROBE_GROUP] }
            },
          },
        ],
        { groups: STANDARD_GROUPS },
      )
    },

    async searchCities(ctx, query) {
      const token = searchToken(normalizeSettlement(query))
      if (!token) return []
      const rows = await list<[number, string]>(ctx, `cities?search=${encodeURIComponent(token)}`)
      return rows.map(([id, label]) => {
        // "м.Шостка (Шосткинський Район/М.Шостка)"
        const m = /^(.*?)\s*\((.*)\)\s*$/.exec(label)
        const city: City = { id: String(id), name: (m?.[1] ?? label).trim() }
        if (m?.[2]) city.district = m[2].trim()
        return city
      })
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
      // the server matches a substring, so "вул. Шевченка" finds nothing: send the main word
      const token = searchToken(normalizeStreet(query))
      if (!token) return []
      const rows = await list<[number, string]>(
        ctx,
        `streets?cityId=${encodeURIComponent(city.id)}&search=${encodeURIComponent(token)}`,
      )
      return rows.map(([id, name]) => ({ id: String(id), name: name.trim(), cityId: city.id }))
    },

    async searchHouses(ctx, street, query) {
      // the server needs a search text; the number part finds "14", "14А", "14/1"
      const token = /\d+/.exec(query ?? '')?.[0] ?? query?.trim()
      if (!token) return []
      const rows = await list<[number, string]>(
        ctx,
        `houses?streetId=${encodeURIComponent(street.id)}&search=${encodeURIComponent(token)}`,
      )
      return rows.map(([id, number]) => ({ id: String(id), number: number.trim(), streetId: street.id }))
    },

    async outageOf(ctx, house, street, city): Promise<HouseOutage | null> {
      const hit = shutdowns.get(house.id)
      let rows: Promise<ShutdownRow[]>
      if (hit && Date.now() - hit.at < (ctx.fresh ? FRESH_TTL_MS : SHUTDOWNS_TTL_MS)) rows = hit.rows
      else {
        // the house's own rows: the street's (`by-street`) would be every house of it, 170 rows
        rows = list<ShutdownRow>(ctx, `by-house?houseId=${encodeURIComponent(house.id)}`)
        if (shutdowns.size > 500) shutdowns.clear()
        const entry = { at: Date.now(), rows }
        shutdowns.set(house.id, entry)
        rows.catch(() => {
          if (shutdowns.get(house.id) === entry) shutdowns.delete(house.id)
        })
      }
      const outage = currentShutdown(await rows, ctx.now())
      if (!outage) return null
      // the groups of the address, as `groupOf` reads them; a house without one (Sumy city) has none
      const groups = await this.groupOf!(ctx, house, street, city).then(
        (m) => [m.group, ...(m.otherGroups ?? [])],
        (e: unknown) => {
          if (!(e instanceof OutageError) || e.code !== 'not-found') throw e
          return []
        },
      )
      return {
        region,
        address: { city: city?.name, street: street.name, house: house.number },
        ...outage,
        groups,
        updatedAt: null,
        url: INFO.website,
        fetchedAt: toKyivIso(ctx.now()),
      }
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      const rows = await list<QueueRow>(
        ctx,
        `queues-by-street?streetId=${encodeURIComponent(street.id)}&houseId=${encodeURIComponent(house.id)}`,
      )
      const row = rows.find((r) => r[2]?.trim() === house.number) ?? rows[0]
      const groups = (row?.[3]?.[GPV_QUEUE_INDEX] ?? '')
        .split(',')
        .map((g) => normalizeGroup(g))
        .filter((g): g is string => !!g)
      if (!groups.length)
        // e.g. every address in Sumy city: the lookup has no hourly-schedule group there
        throw new OutageError(
          'not-found',
          `${house.number}, ${street.name}: the operator has no hourly schedule group for this house`,
          { region },
        )
      const q = row?.[3] ?? []
      const emergency = emergencyQueues({ gav: [q[GAV_INDEX]], sgav: [q[SGAV_INDEX]], achr: [q[ACHR_INDEX]] })
      return {
        region,
        group: groups[0]!,
        ...(groups.length > 1 ? { otherGroups: groups.slice(1) } : {}),
        address: { city: city?.name, street: street.name, house: house.number },
        ...(emergency ? { emergency } : {}),
      }
    },
  }
}

/**
 * The site's labels of `by-house` rows (its JS `eC`, 16.11.2026): 1 Планове, 2 Аварійне, 3 ГАВ,
 * 4/5 ГПВ, 6 СГАВ, 7 Планове (термінове), 8 САВН, 9 Аварійне, 10 ГОП.
 *
 * Seen live (16–17.11.2026): 1 and 2 only. UNVERIFIED: 3 and 6 (ГАВ, СГАВ) were not in force; the
 * operator writes that a house's ГАВ outage shows "в момент відключення" (Telegram, post 3728).
 * They are `emergency` because the site itself labels them so. САВН (automatic load shedding)
 * and ГОП (power limitation) say nothing clear about the hourly schedule: `other`.
 */
const SHUTDOWN_TYPES: Record<number, { kind: HouseOutageKind; reason: string }> = {
  1: { kind: 'planned', reason: 'Планове' },
  2: { kind: 'repair', reason: 'Аварійне' },
  3: { kind: 'emergency', reason: 'ГАВ' },
  4: { kind: 'scheduled', reason: 'ГПВ' },
  5: { kind: 'scheduled', reason: 'ГПВ' },
  6: { kind: 'emergency', reason: 'СГАВ' },
  7: { kind: 'planned', reason: 'Планове (термінове)' },
  8: { kind: 'other', reason: 'САВН' },
  9: { kind: 'repair', reason: 'Аварійне' },
  10: { kind: 'other', reason: 'ГОП' },
}
const KIND_RANK: Record<HouseOutageKind, number> = {
  emergency: 0,
  repair: 1,
  planned: 2,
  other: 3,
  scheduled: 4,
}

/** "2026-11-17T21:03:00", Kyiv wall clock (planned works read 08:00–17:00) → ISO */
function shutdownTime(text: unknown): string | null {
  const m = typeof text === 'string' ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(text) : null
  if (!m) return null
  const at = kyivInstant(m[1]!, Number(m[2]) * 60 + Number(m[3]))
  return Number.isFinite(at.getTime()) ? toKyivIso(at) : null
}

/**
 * The house's outage at `now` from its `by-house` rows (current ones and those planned ahead):
 * started and not ended; ГАВ before an accident, before the rest. Exported for tests.
 */
export function currentShutdown(
  rows: readonly ShutdownRow[],
  now: Date,
): Pick<HouseOutage, 'kind' | 'reason' | 'scheduleApplies' | 'from' | 'to'> | null {
  const t = now.getTime()
  let best: Pick<HouseOutage, 'kind' | 'reason' | 'scheduleApplies' | 'from' | 'to'> | null = null
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const from = shutdownTime(row[3])
    const to = shutdownTime(row[4])
    if (!from || Date.parse(from) > t || (to && Date.parse(to) <= t)) continue
    const label = SHUTDOWN_TYPES[Number(row[5])] ?? {
      kind: 'other' as const,
      reason: `тип ${String(row[5])}`,
    }
    const outage = {
      ...label,
      scheduleApplies: label.kind === 'emergency' ? false : label.kind === 'scheduled' ? true : null,
      from,
      to,
    }
    if (!best || KIND_RANK[outage.kind] < KIND_RANK[best.kind]) best = outage
  }
  return best
}

function importPayloadKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(PAYLOAD_KEY), 'AES-GCM', false, [
    'decrypt',
  ])
}

/**
 * Unwraps `{"payload": …}`. A response that already has `data` is taken as is, in case the
 * site drops the encryption. Exported for tests.
 */
export async function decryptSumyResponse<T>(
  res: { payload?: unknown; data?: unknown },
  key?: CryptoKey,
  url?: string,
): Promise<T> {
  const region = INFO.id
  if (typeof res?.payload !== 'string') {
    if (res && typeof res === 'object' && 'data' in res) return res as T
    throw new OutageError('parse', 'Sumy: response has no encrypted "payload"', { region, url })
  }
  let plain: string
  try {
    const bytes = Uint8Array.from(atob(res.payload), (c) => c.charCodeAt(0))
    const buf = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES) },
      key ?? (await importPayloadKey()),
      bytes.subarray(IV_BYTES),
    )
    plain = new TextDecoder().decode(buf)
  } catch (cause) {
    throw new OutageError(
      'parse',
      'Sumy: cannot decrypt the API response (the site may have changed its key)',
      {
        region,
        url,
        cause,
      },
    )
  }
  try {
    return JSON.parse(plain) as T
  } catch (cause) {
    throw new OutageError('parse', 'Sumy: decrypted response is not JSON', { region, url, cause })
  }
}

/** The site's grid: per group its outage windows (null = "no data"), undated. */
export interface SumyGrid {
  groups: Record<GroupId, MinuteSlot[] | null>
  /** Newest `last_update` of the groups, ISO */
  updatedAt: string | null
}

/** "08:00"–"12:00" windows → slots; "00:00" as an end is midnight. */
function windowSlots(
  list: readonly { start_time?: string; end_time?: string }[],
  what: string,
): MinuteSlot[] {
  return list.map((t) => {
    const start = parseClock(t?.start_time ?? '')
    let end = parseClock(t?.end_time ?? '')
    if (start === null || end === null)
      throw new OutageError('parse', `${what}: bad time "${t?.start_time}–${t?.end_time}"`, {
        region: INFO.id,
      })
    // "00:00" ends at midnight; nothing runs past it since a slot covers one day
    if (end <= start) end = 1440
    return { start, end, kind: 'off' }
  })
}

/** Decrypted `/schedules` → the undated grid. Windows may repeat or overlap. Exported for tests. */
export function parseSumyGrid(res: { data?: ScheduleEntry[] }): SumyGrid {
  const region = INFO.id
  if (!Array.isArray(res?.data)) throw new OutageError('parse', 'Sumy schedules: no "data" list', { region })
  const groups: SumyGrid['groups'] = {}
  let updatedAt: string | null = null
  for (const e of res.data) {
    const group = e.cherga_n ? normalizeGroup(e.cherga_n) : null
    if (!group || !Array.isArray(e.lst_time_disc))
      throw new OutageError('parse', `Sumy schedules: unexpected entry ${JSON.stringify(e).slice(0, 80)}`, {
        region,
      })
    if (e.no_data) {
      groups[group] = null
      continue
    }
    groups[group] = windowSlots(e.lst_time_disc, 'Sumy schedules')
    const at = parseUaDateTime(e.last_update)
    if (at && (!updatedAt || Date.parse(at) > Date.parse(updatedAt))) updatedAt = at
  }
  return { groups, updatedAt }
}

/**
 * Decrypted `/schedules` → schedule for `date`. The response itself has no date: the provider
 * takes it from E-Svitlo (`dateOfGrid`); the default here is the Kyiv day of `now`, which is what
 * the site shows it as. A group marked "no data" stays listed with an `unknown` day, even when
 * every group is: nothing published must not read as "no outages". Exported for tests.
 */
export function parseSumySchedules(
  res: { data?: ScheduleEntry[] },
  now: Date,
  date: string = kyivDate(now),
): RegionSchedule {
  const grid = parseSumyGrid(res)
  const schedules: Record<string, DaySchedule[]> = {}
  for (const [g, slots] of Object.entries(grid.groups))
    schedules[g] = [slots ? makeDay(date, slots) : { date, status: 'unknown', intervals: [] }]
  return {
    region: INFO.id,
    groups: Object.keys(schedules).sort(compareGroups),
    schedules,
    updatedAt: grid.updatedAt,
    fetchedAt: toKyivIso(now),
  }
}

/** One slot (today's or tomorrow's) of an E-Svitlo answer. */
interface CabinetSlot {
  /** "YYYY-MM-DD", from `date_today` */
  date: string
  /** null: "no data" for the group that day */
  slots: MinuteSlot[] | null
  publishedAt: string | null
}

/** What E-Svitlo says about one group. */
export interface CabinetGroup {
  group: GroupId
  today: CabinetSlot
  /** Tomorrow's slot when it has the shape of a published day, else null */
  tomorrow: CabinetSlot | null
  /** The tomorrow slot shows any sign of data, readable or not: worth asking the other groups */
  tomorrowAnnounced: boolean
}

interface CabinetData {
  no_data?: unknown
  /** "17.11.2026" */
  date_today?: unknown
  /** "Оновлено: 16.11.2026 22:49" */
  last_update?: unknown
  cherga_n?: unknown
  lst_time_disc?: unknown
  dict_tom?: unknown
}

const cabinetDate = (text: unknown): string | null => {
  const m = typeof text === 'string' ? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim()) : null
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

/**
 * One E-Svitlo answer for `group`. Today's slot is read strictly: a missing date, a date more
 * than a day from the clock, another group's data or a bad time is a `parse` error. The
 * tomorrow slot (`dict_tom`) has only been seen empty (`no_data: true`), so it is read
 * defensively: it counts when it has exactly the shape of today's slot with outage windows and
 * the date after today's; anything else is "not published", never an error. The half-hour
 * `gpv_schedule` rows are ignored: their `status` describes passed/current/coming, not on/off.
 * Exported for tests.
 */
export function parseCabinetAnswer(res: unknown, group: GroupId, now: Date): CabinetGroup {
  const region = INFO.id
  const data = (res as { data?: CabinetData } | null)?.data
  if (!data || typeof data !== 'object')
    throw new OutageError('parse', 'Sumy E-Svitlo: no "data" object', { region })
  const date = cabinetDate(data.date_today)
  const clock = kyivDate(now)
  if (!date || date < addDays(clock, -1) || date > addDays(clock, 1))
    throw new OutageError(
      'parse',
      `Sumy E-Svitlo: unexpected date_today ${JSON.stringify(data.date_today)}`,
      { region },
    )
  const stamp = (d: CabinetData) => parseUaDateTime(typeof d.last_update === 'string' ? d.last_update : null)
  const mine = (d: CabinetData) => typeof d.cherga_n === 'string' && normalizeGroup(d.cherga_n) === group

  let today: CabinetSlot
  if (data.no_data === true) today = { date, slots: null, publishedAt: null }
  else {
    if (data.no_data !== false || !mine(data) || !Array.isArray(data.lst_time_disc))
      throw new OutageError(
        'parse',
        `Sumy E-Svitlo: asked for group ${group}, got ${JSON.stringify({ cherga_n: data.cherga_n, no_data: data.no_data })}`,
        { region },
      )
    today = { date, slots: windowSlots(data.lst_time_disc, 'Sumy E-Svitlo'), publishedAt: stamp(data) }
  }

  const tom = data.dict_tom && typeof data.dict_tom === 'object' ? (data.dict_tom as CabinetData) : null
  const windows = tom && Array.isArray(tom.lst_time_disc) ? tom.lst_time_disc : []
  let tomorrow: CabinetSlot | null = null
  if (
    tom &&
    tom.no_data === false &&
    mine(tom) &&
    windows.length &&
    cabinetDate(tom.date_today) === addDays(date, 1)
  ) {
    try {
      tomorrow = {
        date: addDays(date, 1),
        slots: windowSlots(windows, 'Sumy E-Svitlo'),
        publishedAt: stamp(tom),
      }
    } catch {
      // an unreadable tomorrow is not published yet as far as this reader can tell
    }
  }
  return {
    group,
    today,
    tomorrow,
    tomorrowAnnounced: !!tom && (tom.no_data === false || windows.length > 0 || !!tom.last_update),
  }
}

/**
 * How long after Kyiv midnight an undated grid that nothing else dates is not taken for today's.
 * The endpoint served 16.11 until midnight and had 17.11 by 00:26; the minute it switches isn't
 * known.
 */
const MIDNIGHT_DOUBT_MIN = 60

const sameWindows = (a: readonly MinuteSlot[], b: readonly MinuteSlot[]) =>
  JSON.stringify(slotsToIntervals('2000-01-01', a)) === JSON.stringify(slotsToIntervals('2000-01-01', b))

/**
 * Which day the site's undated grid is, according to E-Svitlo's dated answers: the date of the
 * slot (today's, else tomorrow's) whose windows equal the grid's in every group both have data
 * for. `undefined` when there is nothing to compare, null when the grid equals neither slot.
 */
function dateOfGrid(grid: SumyGrid, cabinet: readonly CabinetGroup[]): string | null | undefined {
  for (const pick of ['today', 'tomorrow'] as const) {
    let compared = 0
    let date: string | null = null
    for (const c of cabinet) {
      const slot = c[pick]
      const mine = grid.groups[c.group]
      if (!slot?.slots || !mine) continue
      compared++
      if (!sameWindows(mine, slot.slots) || (date && date !== slot.date)) {
        date = null
        break
      }
      date = slot.date
    }
    if (date) return date
    if (!compared && pick === 'today') return undefined
  }
  return null
}

/**
 * The site's grid as a channel. Its day comes from E-Svitlo when that answered. When the grid
 * equals neither of E-Svitlo's days it is not dated at all (an error: E-Svitlo's own days are
 * used). Without E-Svitlo it is the Kyiv day of `now`, as the site shows it, with two limits:
 * - its change time is from before yesterday: a schedule is published the evening before at the
 *   earliest, so such a grid is a leftover and not today's (an error);
 * - it is the first hour of the day and the grid wasn't changed today: it may be the evening's
 *   schedule for today or yesterday's grid the endpoint hasn't dropped yet (it switches around
 *   midnight, the minute isn't known), and the change time is "yesterday" for both. Nothing tells
 *   them apart, so the grid gets no date: the day stays `unknown` until `MIDNIGHT_DOUBT_MIN`.
 */
function gridToRead(grid: SumyGrid, cabinet: readonly CabinetGroup[] | null, now: Date): SourceRead {
  const region = INFO.id
  const today = kyivDate(now)
  let date = cabinet ? dateOfGrid(grid, cabinet) : undefined
  if (date === null)
    throw new OutageError(
      'parse',
      "Sumy: the site's schedule has no date and differs from both days E-Svitlo has; not dating it",
      { region },
    )
  if (date === undefined) {
    if (grid.updatedAt && kyivDate(new Date(grid.updatedAt)) < addDays(today, -1))
      throw new OutageError(
        'parse',
        `Sumy: the site's schedule has no date and was last changed ${grid.updatedAt}; not dating it today`,
        { region },
      )
    const changedToday = !!grid.updatedAt && kyivDate(new Date(grid.updatedAt)) === today
    if (!changedToday && kyivMinuteOfDay(now) < MIDNIGHT_DOUBT_MIN)
      return { days: {}, groups: Object.keys(grid.groups) }
    date = today
  }
  const schedules: Record<GroupId, DaySchedule> = {}
  for (const [g, slots] of Object.entries(grid.groups))
    schedules[g] = slots ? makeDay(date, slots) : { date, status: 'unknown', intervals: [] }
  return { days: { [date]: { schedules, publishedAt: grid.updatedAt } }, groups: Object.keys(grid.groups) }
}

/** E-Svitlo's answers for all groups as a channel: today, and tomorrow for the groups that have it. */
function cabinetToRead(cabinet: readonly CabinetGroup[]): SourceRead {
  const region = INFO.id
  const days: SourceRead['days'] = {}
  const add = (group: GroupId, slot: CabinetSlot) => {
    const day = (days[slot.date] ??= { schedules: {}, publishedAt: null })
    day.schedules[group] = slot.slots
      ? makeDay(slot.date, slot.slots)
      : { date: slot.date, status: 'unknown', intervals: [] }
    if (slot.publishedAt && (!day.publishedAt || Date.parse(slot.publishedAt) > Date.parse(day.publishedAt)))
      day.publishedAt = slot.publishedAt
  }
  const date = cabinet[0]?.today.date
  for (const c of cabinet) {
    // the answers must be about one day: a day read half before and half after midnight isn't one
    if (c.today.date !== date)
      throw new OutageError('parse', 'Sumy E-Svitlo: the day changed while the groups were being read', {
        region,
      })
    add(c.group, c.today)
    if (c.tomorrow) add(c.group, c.tomorrow)
  }
  return { days, groups: cabinet.map((c) => c.group) }
}

/** The longest word, which the server's substring search can match ("вулиця Тараса Шевченка" → "шевченка"). */
function searchToken(normalized: string): string | null {
  const words = normalized.split(/[\s'-]+/).filter((w) => w.length >= 2)
  return words.sort((a, b) => b.length - a.length)[0] ?? null
}
