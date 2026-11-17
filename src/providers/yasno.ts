import { OutageError } from '../errors.js'
import { compareGroups, makeDay, type MinuteSlot } from '../schedule.js'
import { normalizeStreet } from '../text.js'
import { kyivDate, toKyivIso } from '../time.js'
import type {
  AddressQuery,
  City,
  DaySchedule,
  DayStatus,
  GroupMatch,
  House,
  RegionId,
  ProviderInfo,
  RegionSchedule,
  Street,
} from '../types.js'
import { asSource } from './as-source.js'
import { cekTelegramSource } from './cek-telegram.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceSpec } from './sources.js'

/**
 * YASNO public "blackout-service" API (app.yasno.ua). It publishes the schedules of DTEK's
 * Kyiv and Dnipro grid operators, with a full address lookup. Plain JSON, no auth.
 *
 * The API sits behind a CDN that keeps an answer for 5 minutes (`cache-control: max-age=300`);
 * any extra query parameter reaches the origin, so schedule requests carry `_=<unix seconds>`.
 */
const BASE = 'https://app.yasno.ua/api/blackout-service/public/shutdowns'

/**
 * Operators whose own channel publishes earlier than YASNO does for them, by `dsoId`: it is
 * merged with the API, each day from whichever published it last. 303 is ЦЕК.
 */
const OPERATOR_CHANNELS: Record<number, (() => SourceSpec) | undefined> = { 303: cekTelegramSource }

interface YasnoDay {
  slots?: { start: number; end: number; type: string }[]
  date?: string
  status?: string
}
type YasnoPlanned = Record<string, { today?: YasnoDay; tomorrow?: YasnoDay; updatedOn?: string }>
type YasnoItem = { id: number; value: string }

const STATUS: Record<string, DayStatus> = {
  ScheduleApplies: 'scheduled',
  WaitingForSchedule: 'unknown',
  NoOutages: 'no-outages',
  EmergencyShutdowns: 'emergency',
}

export interface YasnoOptions {
  info: Omit<ProviderInfo, 'capabilities'>
  regionId: number
  dsoId: number
  /** The region spans many settlements, so lookups need a city first */
  hasCities: boolean
  sampleAddress?: AddressQuery
}

export function yasnoProvider(o: YasnoOptions): Provider {
  const region = o.info.id
  const q = (params: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams({ regionId: String(o.regionId), dsoId: String(o.dsoId) })
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v))
    return sp.toString()
  }
  const list = async (
    ctx: ProviderContext,
    path: string,
    params: Record<string, string | number | undefined>,
  ) => {
    const data = await ctx.http.json<unknown>(`${BASE}/addresses/v2/${path}?${q(params)}`, { region })
    if (!Array.isArray(data)) throw new OutageError('parse', `YASNO ${path}: expected a list`, { region })
    return data as YasnoItem[]
  }

  const provider: Provider = {
    info: { ...o.info, capabilities: { schedule: true, addressSearch: true } },
    // cities: the whole list (~1100 for Dnipro region) comes in one request; streets: server search
    remoteSearch: { streets: true },
    sampleAddress: o.sampleAddress,

    getSchedules(ctx) {
      const url = `${BASE}/regions/${o.regionId}/dsos/${o.dsoId}/planned-outages`
      const api: SourceSpec = {
        id: 'api',
        url: o.info.website,
        read: async () => {
          const now = ctx.now()
          const bust = Math.floor(now.getTime() / 1000)
          return asSource(
            parsePlanned(region, await ctx.http.json<YasnoPlanned>(`${url}?_=${bust}`, { region }), now),
          )
        },
      }
      const channel = OPERATOR_CHANNELS[o.dsoId]
      return mergeSources(ctx, region, channel ? [api, channel()] : [api])
    },

    async searchStreets(ctx, query, city) {
      if (o.hasCities && !city)
        throw new OutageError('not-found', `${o.info.name}: pick a city first`, { region })
      const term = searchTerm(query)
      // the API ignores queries shorter than 3 characters
      if (term.length < 3) return []
      const items = await list(ctx, 'streets', { query: term, cityId: city?.id })
      return items.map((s) => ({ id: String(s.id), name: s.value, cityId: city?.id }))
    },

    async searchHouses(ctx, street, query) {
      const items = await list(ctx, 'houses', {
        streetId: street.id,
        cityId: street.cityId,
        // the API matches substrings; the leading digits find "12", "12А", "12/2", …
        query: query ? (/^\d+/.exec(query.trim())?.[0] ?? query.trim()) : undefined,
      })
      return items.map((h) => ({ id: String(h.id), number: h.value, streetId: street.id }))
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      const data = await ctx.http.json<{ group?: number; subgroup?: number }>(
        `${BASE}/addresses/v2/group?${q({ streetId: street.id, houseId: house.id, cityId: street.cityId ?? city?.id })}`,
        { region },
      )
      if (typeof data.group !== 'number')
        throw new OutageError('parse', 'YASNO group: missing "group"', { region })
      return {
        region,
        group: data.subgroup == null ? String(data.group) : `${data.group}.${data.subgroup}`,
        address: { city: city?.name, street: street.name, house: house.number },
      }
    },
  }

  if (o.hasCities)
    provider.searchCities = async (ctx, query): Promise<City[]> => {
      // without a query the API returns every settlement; the client ranks them
      const items = await list(ctx, 'cities', {})
      return items.map((c) => ({ id: String(c.id), name: c.value }))
    }

  return provider
}

/**
 * Days are dated by their own `date`, never by the slot they sit in: a copy from before
 * midnight read after it gives yesterday and today, not "today" and "tomorrow".
 *
 * Slots count only under `ScheduleApplies`. `WaitingForSchedule` is "not published": the day is
 * `unknown` and whatever slots come with it are dropped (none seen in any sample; a preliminary
 * list isn't the operator's schedule). `EmergencyShutdowns` has no slots; YASNO copies it to
 * tomorrow as well, where it says nothing: an emergency isn't scheduled a day ahead, so a later
 * day under it is `unknown` too. Exported for tests.
 */
export function parsePlanned(region: RegionId, data: YasnoPlanned, now: Date): RegionSchedule {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new OutageError('parse', 'YASNO planned-outages: expected an object', { region })

  const today = kyivDate(now)
  const schedules: Record<string, DaySchedule[]> = {}
  let updated = 0
  for (const [key, g] of Object.entries(data)) {
    if (!/^\d+(\.\d+)?$/.test(key) || !g || typeof g !== 'object') continue
    const days: DaySchedule[] = []
    for (const d of [g.today, g.tomorrow]) {
      if (!d?.date) continue
      const date = d.date.slice(0, 10)
      if (days.some((x) => x.date === date)) continue
      let status = STATUS[d.status ?? ''] ?? 'unknown'
      if (status === 'emergency' && date > today) status = 'unknown'
      const slots: MinuteSlot[] =
        d.status === 'ScheduleApplies'
          ? (d.slots ?? [])
              .filter((s) => s.type !== 'NotPlanned')
              .map((s) => ({ start: s.start, end: s.end, kind: s.type === 'Definite' ? 'off' : 'maybe' }))
          : []
      days.push(makeDay(date, slots, status))
    }
    schedules[key] = days
    const u = g.updatedOn ? Date.parse(g.updatedOn) : NaN
    if (Number.isFinite(u) && u > updated) updated = u
  }
  const groups = Object.keys(schedules).sort(compareGroups)
  if (!groups.length && Object.keys(data).length)
    throw new OutageError('parse', 'YASNO planned-outages: no groups in the response', { region })

  return {
    region,
    groups,
    schedules,
    updatedAt: updated ? toKyivIso(new Date(updated)) : null,
    fetchedAt: toKyivIso(now),
  }
}

/** The most distinctive word of a street query: "вул. Тараса Шевченка" → "Шевченка". */
function searchTerm(query: string): string {
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/^[«"'(]+|[»"'),.]+$/g, ''))
    .filter((w) => normalizeStreet(w) !== '')
  return words.sort((a, b) => b.length - a.length)[0] ?? query.trim()
}
