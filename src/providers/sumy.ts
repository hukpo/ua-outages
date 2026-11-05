import { OutageError } from '../errors.js'
import { compareGroups, makeDay, normalizeGroup, type MinuteSlot } from '../schedule.js'
import { normalizeSettlement, normalizeStreet, matchScore } from '../text.js'
import { kyivDate, parseClock, toKyivIso } from '../time.js'
import type { City, DaySchedule, GroupMatch, RegionInfo, RegionSchedule } from '../types.js'
import { parseUaDateTime } from './gpv.js'
import type { Provider, ProviderContext } from './provider.js'

/**
 * Sumyoblenergo (www.soe.com.ua): a JSON API behind the site's shutdowns page with today's
 * outage windows per group and a full address chain city → street → house → group.
 *
 * Always use `www.`: the bare domain sits behind a Cloudflare challenge. The API answers 403
 * without a `Referer` (any value) or with a runtime-default User-Agent; the SDK's own UA passes.
 */
const INFO: RegionInfo = {
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

/** Index of the hourly schedule (ГПВ) queue in `queues-by-street` rows: ГАВ, АЧР, СГАВ, ГПВ, … */
const GPV_QUEUE_INDEX = 3

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

export function sumyProvider(): Provider {
  const region = INFO.id
  let key: Promise<CryptoKey> | null = null

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
    sampleAddress: { city: 'Шостка', street: 'вул. Шевченка', house: '14' },

    async getSchedules(ctx) {
      return parseSumySchedules(await get(ctx, 'schedules'), ctx.now())
    },

    async searchCities(ctx, query) {
      const token = searchToken(normalizeSettlement(query))
      if (!token) return []
      const rows = await list<[number, string]>(ctx, `cities?search=${encodeURIComponent(token)}`)
      return rows
        .map(([id, label]) => {
          // "м.Шостка (Шосткинський Район/М.Шостка)"
          const m = /^(.*?)\s*\((.*)\)\s*$/.exec(label)
          const city: City = { id: String(id), name: (m?.[1] ?? label).trim() }
          if (m?.[2]) city.district = m[2].trim()
          return city
        })
        .filter((c) => matchScore(query, c.name, 'settlement') > 0)
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
      return rows
        .map(([id, name]) => ({ id: String(id), name: name.trim(), cityId: city.id }))
        .filter((s) => matchScore(query, s.name) > 0)
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
      return {
        region,
        group: groups[0]!,
        ...(groups.length > 1 ? { otherGroups: groups.slice(1) } : {}),
        address: { city: city?.name, street: street.name, house: house.number },
      }
    },
  }
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

/**
 * Decrypted `/schedules` → schedule. The response has no date: the site shows it as today,
 * so it is dated today in Kyiv. Windows may repeat or overlap; they're merged. Exported for tests.
 */
export function parseSumySchedules(res: { data?: ScheduleEntry[] }, now: Date): RegionSchedule {
  const region = INFO.id
  if (!Array.isArray(res?.data)) throw new OutageError('parse', 'Sumy schedules: no "data" list', { region })
  const today = kyivDate(now)
  const schedules: Record<string, DaySchedule[]> = {}
  let updated: string | null = null

  for (const e of res.data) {
    const group = e.cherga_n ? normalizeGroup(e.cherga_n) : null
    if (!group || !Array.isArray(e.lst_time_disc))
      throw new OutageError('parse', `Sumy schedules: unexpected entry ${JSON.stringify(e).slice(0, 80)}`, {
        region,
      })
    if (e.no_data) {
      schedules[group] = [{ date: today, status: 'unknown', intervals: [] }]
      continue
    }
    const slots: MinuteSlot[] = e.lst_time_disc.map((t) => {
      const start = parseClock(t.start_time ?? '')
      let end = parseClock(t.end_time ?? '')
      if (start === null || end === null)
        throw new OutageError('parse', `Sumy schedules: bad time "${t.start_time}–${t.end_time}"`, { region })
      // "00:00" ends at midnight; nothing runs past it since the feed covers one day
      if (end <= start) end = 1440
      return { start, end, kind: 'off' }
    })
    schedules[group] = [makeDay(today, slots)]
    const at = parseUaDateTime(e.last_update)
    if (at && (!updated || Date.parse(at) > Date.parse(updated))) updated = at
  }

  // every group "no data": nothing is published
  const known = Object.keys(schedules).filter((g) => schedules[g]![0]!.status !== 'unknown')
  const groups = known.length ? Object.keys(schedules).sort(compareGroups) : []
  return {
    region,
    groups,
    schedules: groups.length ? schedules : {},
    updatedAt: updated,
    fetchedAt: toKyivIso(now),
  }
}

/** The longest word, which the server's substring search can match ("вулиця Тараса Шевченка" → "шевченка"). */
function searchToken(normalized: string): string | null {
  const words = normalized.split(/[\s'-]+/).filter((w) => w.length >= 2)
  return words.sort((a, b) => b.length - a.length)[0] ?? null
}
