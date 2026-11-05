import { OutageError } from '../errors.js'
import { compareGroups, makeDay, type MinuteSlot } from '../schedule.js'
import { normalizeStreet } from '../text.js'
import { toKyivIso } from '../time.js'
import type {
  AddressQuery,
  City,
  DaySchedule,
  DayStatus,
  GroupMatch,
  House,
  RegionId,
  RegionInfo,
  RegionSchedule,
  Street,
} from '../types.js'
import type { Provider, ProviderContext } from './provider.js'

/**
 * YASNO public "blackout-service" API (app.yasno.ua). It publishes the schedules of DTEK's
 * Kyiv and Dnipro grid operators, with a full address lookup. Plain JSON, no auth.
 */
const BASE = 'https://app.yasno.ua/api/blackout-service/public/shutdowns'

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
  info: Omit<RegionInfo, 'capabilities'>
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
  const list = async (ctx: ProviderContext, path: string, params: Record<string, string | number | undefined>) => {
    const data = await ctx.http.json<unknown>(`${BASE}/addresses/v2/${path}?${q(params)}`, { region })
    if (!Array.isArray(data)) throw new OutageError('parse', `YASNO ${path}: expected a list`, { region })
    return data as YasnoItem[]
  }

  const provider: Provider = {
    info: { ...o.info, capabilities: { schedule: true, addressSearch: true } },
    sampleAddress: o.sampleAddress,

    async getSchedules(ctx) {
      const data = await ctx.http.json<YasnoPlanned>(
        `${BASE}/regions/${o.regionId}/dsos/${o.dsoId}/planned-outages`,
        { region },
      )
      return parsePlanned(region, data, ctx.now())
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
      const items = await list(ctx, 'cities', { query: query.trim() })
      return items.map((c) => ({ id: String(c.id), name: c.value }))
    }

  return provider
}

/** Exported for tests. */
export function parsePlanned(region: RegionId, data: YasnoPlanned, now: Date): RegionSchedule {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new OutageError('parse', 'YASNO planned-outages: expected an object', { region })

  const schedules: Record<string, DaySchedule[]> = {}
  let updated = 0
  for (const [key, g] of Object.entries(data)) {
    if (!/^\d+(\.\d+)?$/.test(key) || !g || typeof g !== 'object') continue
    const days: DaySchedule[] = []
    for (const d of [g.today, g.tomorrow]) {
      if (!d?.date) continue
      const date = d.date.slice(0, 10)
      const slots: MinuteSlot[] = (d.slots ?? [])
        .filter((s) => s.type !== 'NotPlanned')
        .map((s) => ({ start: s.start, end: s.end, kind: s.type === 'Definite' ? 'off' : 'maybe' }))
      days.push(makeDay(date, slots, STATUS[d.status ?? ''] ?? 'unknown'))
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
