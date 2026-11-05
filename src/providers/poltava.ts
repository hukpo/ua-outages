import { OutageError } from '../errors.js'
import { cellsToIntervals, compareGroups, normalizeGroup } from '../schedule.js'
import { toKyivIso } from '../time.js'
import type { City, DaySchedule, GroupMatch, IntervalKind, RegionInfo, RegionSchedule } from '../types.js'
import type { Provider, ProviderContext } from './provider.js'
import { findUaDate } from './ua-text.js'

/**
 * Poltavaoblenergo (poe.pl.ua). The schedule is an HTML fragment with a 48-cell table per
 * group and day; address search is a chain of form POSTs with a JSON payload.
 */
const SITE = 'https://www.poe.pl.ua'
const CUSTOMS = `${SITE}/customs`

const INFO: RegionInfo = {
  id: 'poltava',
  name: 'Полтавська область',
  operator: 'Полтаваобленерго',
  website: `${SITE}/disconnection/power-outages/`,
  capabilities: { schedule: true, addressSearch: true },
}

// gpv-s1 on, gpv-s2 off, gpv-s3 switching time ("електроенергії може не бути")
const CELL: Record<string, IntervalKind | null> = { s1: null, s2: 'off', s3: 'maybe' }

interface Instance {
  instance_id: number
  instance_name: string
}

export function poltavaProvider(): Provider {
  const region = INFO.id
  let cities: Promise<City[]> | null = null

  const search = async (ctx: ProviderContext, payload: Record<string, string | number>) => {
    // JSON arrives labelled text/html, so parse it ourselves
    const body = await ctx.http.text(`${CUSTOMS}/search-disconnection-cabinet.php`, {
      region,
      method: 'POST',
      body: new URLSearchParams({ disconn: JSON.stringify(payload) }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
    })
    return parseJsonList<Instance>(body, region)
  }

  return {
    info: INFO,
    sampleAddress: { city: 'Полтава', street: 'вул. Європейська', house: '10' },

    async getSchedules(ctx) {
      const html = await ctx.http.text(`${CUSTOMS}/dynamicgpv-info.php`, { region })
      return parseGpvFragment(html, ctx.now())
    },

    async searchCities(ctx, query) {
      cities ??= (async () => {
        const home = await ctx.http.text(`${SITE}/`, { region })
        const filials = parseFilials(home)
        if (!filials.length)
          throw new OutageError('parse', 'Poltava: no districts on the home page', { region })
        const lists = await Promise.all(
          filials.map(async (f) =>
            (await search(ctx, { operation_type: 'city', filial_id: f.id, city_id: '', street_id: '' })).map(
              (c) => ({
                id: String(c.instance_id),
                name: c.instance_name.trim(),
                district: f.name,
              }),
            ),
          ),
        )
        // a settlement can be listed under several districts
        const seen = new Map<string, City>()
        for (const c of lists.flat()) if (!seen.has(c.id)) seen.set(c.id, c)
        return [...seen.values()]
      })().catch((e) => {
        cities = null
        throw e
      })
      return cities
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
      const list = await search(ctx, {
        operation_type: 'street',
        filial_id: '',
        city_id: Number(city.id),
        street_id: '',
      })
      return list.map((s) => ({ id: String(s.instance_id), name: s.instance_name.trim(), cityId: city.id }))
    },

    async searchHouses(ctx, street) {
      const list = await search(ctx, {
        operation_type: 'building',
        filial_id: '',
        city_id: Number(street.cityId),
        street_id: Number(street.id),
      })
      // instance_id is just a row number here; the name is the key
      return list.map((h) => ({
        id: h.instance_name.trim(),
        number: h.instance_name.trim(),
        streetId: street.id,
      }))
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      const body = await ctx.http.text(`${CUSTOMS}/disconnectinforesult-cabinet.php`, {
        region,
        method: 'POST',
        // "streerid" is the operator's spelling
        body: new URLSearchParams({
          disconn: JSON.stringify({ cityid: street.cityId, streerid: street.id, house: house.number }),
        }),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
      })
      const [row] = parseJsonList<{
        gp_qnum_1?: string | null
        gp_qnum_2?: string | null
        fn_accident_message?: string
      }>(body, region)
      if (!row?.gp_qnum_1)
        throw new OutageError(
          'not-found',
          `${house.number}, ${street.name}: the operator gives no single group (a building with several connections needs a lookup by personal account)`,
          { region },
        )
      return {
        region,
        group: row.gp_qnum_2 ? `${row.gp_qnum_1}.${row.gp_qnum_2}` : row.gp_qnum_1,
        address: { city: city?.name, street: street.name, house: house.number },
      }
    },
  }
}

/** Exported for tests. */
export function parseGpvFragment(html: string, now: Date): RegionSchedule {
  const region = INFO.id
  const schedules: Record<string, DaySchedule[]> = {}
  const blocks = html.split(/<div class="gpvinfodetail"/).slice(1)
  if (!blocks.length && /gpv-table|turnoff-scheduleui-table/.test(html))
    throw new OutageError('parse', 'Poltava: schedule table without day blocks (format changed?)', { region })

  for (const block of blocks) {
    const header = block.slice(0, 2000).replace(/<[^>]+>/g, ' ')
    const date = findUaDate(header, now)
    if (!date) throw new OutageError('parse', 'Poltava: no date in a schedule block', { region })
    const table = /<table[^>]*class="gpv-table"[^>]*>([\s\S]*?)<\/table>/.exec(block)?.[1]
    if (!table) continue
    for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const name = /<td class="gpv-q"[^>]*>([^<]+)<\/td>/.exec(row[1]!)?.[1]
      const group = name ? normalizeGroup(name) : null
      if (!group) continue
      const cells = [...row[1]!.matchAll(/<td class="gpv-c ([^"]*)"/g)].map((c) => {
        const s = /\bgpv-(s\d)\b/.exec(c[1]!)?.[1] ?? 's1'
        return CELL[s] ?? null
      })
      if (cells.length !== 48 && cells.length !== 24)
        throw new OutageError('parse', `Poltava: group ${group} has ${cells.length} cells`, { region })
      ;(schedules[group] ??= []).push({ date, status: 'scheduled', intervals: cellsToIntervals(date, cells) })
    }
  }
  return {
    region,
    groups: Object.keys(schedules).sort(compareGroups),
    schedules,
    updatedAt: null,
    fetchedAt: toKyivIso(now),
  }
}

/** `<select id="input-filial-main">` options on the home page. Exported for tests. */
export function parseFilials(html: string): { id: string; name: string }[] {
  const select = /<select[^>]*id="input-filial-main"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? ''
  return [...select.matchAll(/<option[^>]*value="(\d+)"[^>]*>([^<]*)/g)]
    .filter((m) => m[1] !== '0')
    .map((m) => ({ id: m[1]!, name: m[2]!.trim() }))
}

function parseJsonList<T>(body: string, region: RegionInfo['id']): T[] {
  let data: unknown
  try {
    data = JSON.parse(body.trim() || '[]')
  } catch (cause) {
    throw new OutageError('parse', 'Poltava: expected JSON', { region, cause })
  }
  if (!Array.isArray(data)) throw new OutageError('parse', 'Poltava: expected a list', { region })
  return data as T[]
}
