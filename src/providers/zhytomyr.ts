import { OutageError } from '../errors.js'
import { cellsToIntervals, compareGroups } from '../schedule.js'
import { matchScore, normalizeHouse } from '../text.js'
import { toKyivIso } from '../time.js'
import type { City, DaySchedule, GroupId, GroupMatch, House, IntervalKind, RegionInfo, RegionSchedule, Street } from '../types.js'
import { parseUaDateTime } from './gpv.js'
import type { Provider, ProviderContext } from './provider.js'
import { mapLimit } from '../util.js'

/**
 * Zhytomyroblenergo (ztoe.com.ua). One server-rendered PHP page in windows-1251 serves both:
 *
 * - GET: a 12-row × 48-cell table per day, where a slot's state is only its background colour;
 * - POST form steps: РЕМ → settlement → street → rows of (house numbers, черга, підчерга).
 */
const PAGE = 'https://www.ztoe.com.ua/unhooking-search.php'
const ENCODING = 'windows-1251'

const INFO: RegionInfo = {
  id: 'zhytomyr',
  name: 'Житомирська область',
  operator: 'Житомиробленерго',
  website: PAGE,
  capabilities: { schedule: true, addressSearch: true },
}

/** Slot colours. The legend has only these two; its red swatch (#ff0000) is not a slot. */
const COLOUR: Record<string, IntervalKind | null> = {
  '#ff3333': 'off',
  '#ffffff': null,
  white: null,
}

/** Черга/підчерга text for critical infrastructure that is not in the schedule. */
const EXEMPT = /не вимикається/i

/** One result row of the address search. */
export interface AddressRow {
  houses: string[]
  /** null when the row is exempt from the schedule */
  group: GroupId | null
  /** "побутові споживачі" (households) vs "непобутові (юридичні) споживачі" (businesses) */
  household: boolean
}

/** What one house number resolves to, merged over all rows that list it. */
interface HouseGroups {
  number: string
  household: GroupId[]
  business: GroupId[]
  exempt: boolean
}

export function zhytomyrProvider(): Provider {
  const region = INFO.id
  let settlements: Promise<City[]> | null = null
  // house id → groups, filled by searchHouses so groupOf needs no extra request
  const houseGroups = new Map<string, HouseGroups>()

  const page = (ctx: ProviderContext, fields?: Record<string, string>) =>
    ctx.http.text(PAGE, {
      region,
      encoding: ENCODING,
      headers: { Accept: 'text/html,application/xhtml+xml' },
      ...(fields ? { method: 'POST' as const, body: new URLSearchParams(fields) } : {}),
    })

  const loadHouses = async (ctx: ProviderContext, street: Street) => {
    const [rem, settlement] = splitCityId(street.cityId)
    const html = await page(ctx, { rem_id: rem, naspunkt_id: settlement, vulica_id: street.id, all: '1' })
    const merged = mergeHouses(parseAddressRows(html))
    // keep the map from growing without bound in long-running processes
    if (houseGroups.size > 5000) houseGroups.clear()
    return merged.map((h): House => {
      const id = `${street.id}:${normalizeHouse(h.number)}`
      houseGroups.set(id, h)
      return { id, number: h.number, streetId: street.id }
    })
  }

  return {
    info: INFO,
    sampleAddress: { city: 'Житомир', street: 'вул. Київська', house: '5' },

    async getSchedules(ctx) {
      return parseSchedulePage(await page(ctx), ctx.now())
    },

    async searchCities(ctx, query) {
      // The form has no settlement search: list every РЕМ's settlements once and keep them.
      settlements ??= (async () => {
        const rems = parseOptions(await page(ctx), 'rem_id')
        if (!rems.length) throw new OutageError('parse', 'Zhytomyr: no РЕМ list on the search page', { region })
        const lists = await mapLimit(rems, 4, async (rem) =>
          parseOptions(await page(ctx, { rem_id: rem.id }), 'naspunkt_id').map(
            (s): City => ({ id: `${rem.id}:${s.id}`, name: s.name, district: `${rem.name} РЕМ` }),
          ),
        )
        return lists.flat()
      })().catch((e) => {
        settlements = null
        throw e
      })
      return (await settlements).filter((c) => matchScore(query, c.name, 'settlement') > 0)
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
      const [rem, settlement] = splitCityId(city.id)
      const streets = parseOptions(await page(ctx, { rem_id: rem, naspunkt_id: settlement }), 'vulica_id')
      return streets
        .map((s): Street => ({ id: s.id, name: s.name, cityId: city.id }))
        .filter((s) => matchScore(query, s.name) > 0)
    },

    async searchHouses(ctx, street) {
      return loadHouses(ctx, street)
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      let h = houseGroups.get(house.id)
      if (!h) {
        await loadHouses(ctx, street)
        h = houseGroups.get(house.id)
      }
      if (!h) throw new OutageError('not-found', `House "${house.number}" not found on ${street.name}`, { region })
      // a house is often listed both for households and for businesses inside it; people
      // asking by address are almost always households
      const groups = h.household.length ? h.household : h.business
      if (!groups.length)
        throw new OutageError(
          'not-found',
          `${house.number}, ${street.name}: ${h.exempt ? 'not in the outage schedule (critical infrastructure line)' : 'the operator gives no group'}`,
          { region },
        )
      return {
        region,
        group: groups[0]!,
        ...(groups.length > 1 ? { otherGroups: groups.slice(1) } : {}),
        address: { city: city?.name, street: street.name, house: h.number },
      }
    },
  }
}

/** Exported for tests. */
export function parseSchedulePage(html: string, now: Date): RegionSchedule {
  const region = INFO.id
  const updated = /Дата оновлення інформації\s*-\s*([^<]+)/.exec(html)?.[1]
  const tables = html.split(/<table\b/i).filter((t) => /colspan="48"/.test(t))
  if (!tables.length && !updated && !/id="mainform"/.test(html))
    throw new OutageError('parse', 'Zhytomyr: not the schedule page (format changed?)', { region })

  const schedules: Record<string, DaySchedule[]> = {}
  for (const table of tables) {
    const d = /<b[^>]*>\s*(\d{2})\.(\d{2})\.(\d{4})\s*<\/b>/.exec(table)
    if (!d) throw new OutageError('parse', 'Zhytomyr: schedule table without a date', { region })
    const date = `${d[3]}-${d[2]}-${d[1]}`
    let rows = 0
    for (const row of table.split(/<tr\b/i)) {
      // x.2 rows lack the rowspan-merged "Черга" cell and the 2.2 header misses its </a>,
      // so find the group by its link and the slots by what follows the 3pt spacer cell
      const group = /pidcherga_id=\d+[^>]*>\s*<b[^>]*>\s*(\d+\.\d+)\s*</.exec(row)?.[1]
      if (!group) continue
      const spacer = row.search(/<td[^>]*width:\s*3pt/i)
      const slots = spacer < 0 ? '' : row.slice(row.indexOf('>', spacer) + 1)
      const cells = [...slots.matchAll(/<td\b([^>]*)>/gi)].map((m) => {
        const colour = /background:\s*([#\w]+)/i.exec(m[1]!)?.[1]?.toLowerCase() ?? ''
        if (!(colour in COLOUR))
          throw new OutageError('parse', `Zhytomyr: unknown slot colour "${colour}" for ${group} on ${date}`, { region })
        return COLOUR[colour]!
      })
      if (cells.length !== 48)
        throw new OutageError('parse', `Zhytomyr: group ${group} has ${cells.length} slots on ${date}`, { region })
      ;(schedules[group] ??= []).push({ date, status: 'scheduled', intervals: cellsToIntervals(date, cells) })
      rows++
    }
    if (!rows) throw new OutageError('parse', `Zhytomyr: no group rows in the ${date} table`, { region })
  }

  return {
    region,
    groups: Object.keys(schedules).sort(compareGroups),
    schedules,
    updatedAt: parseUaDateTime(updated),
    fetchedAt: toKyivIso(now),
  }
}

/** Options of `<select name="…">`, without the "Оберіть …" placeholder. Exported for tests. */
export function parseOptions(html: string, name: string): { id: string; name: string }[] {
  const select = new RegExp(`<select name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? ''
  return [...select.matchAll(/<option value="(\d+)"[^>]*>([^<]*)/g)]
    .filter((m) => m[1] !== '0')
    .map((m) => ({ id: m[1]!, name: decodeEntities(m[2]!).trim() }))
}

/** The result table of the last form step (sent with `all=1`). Exported for tests. */
export function parseAddressRows(html: string): AddressRow[] {
  const region = INFO.id
  const found = /знайдено записів:\s*(\d+)/.exec(html)
  if (!found) {
    if (/id="mainform"/.test(html)) return []
    throw new OutageError('parse', 'Zhytomyr: not the address search page (format changed?)', { region })
  }
  const rows: AddressRow[] = []
  for (const tr of html.slice(found.index).matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      decodeEntities(m[1]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
    )
    // РЕМ | Населений пункт | Вулиця | Будинки | Черга | Підчерга | Примітка
    if (cells.length !== 7 || cells[4] === 'Черга') continue
    const [, , , houses, queue, sub, note] = cells as [string, string, string, string, string, string, string]
    const group = /^\d+$/.test(queue) && /^\d+$/.test(sub) ? `${Number(queue)}.${Number(sub)}` : null
    if (!group && !EXEMPT.test(queue))
      throw new OutageError('parse', `Zhytomyr: unexpected queue "${queue}" / "${sub}"`, { region })
    rows.push({
      houses: houses.split(',').map((h) => h.trim()).filter(Boolean),
      group,
      household: /^побутові/i.test(note),
    })
  }
  if (!rows.length && Number(found[1]) > 0)
    throw new OutageError('parse', `Zhytomyr: ${found[1]} records announced but no rows parsed`, { region })
  return rows
}

/** One entry per house number (normalized), in first-seen order. */
function mergeHouses(rows: AddressRow[]): HouseGroups[] {
  const byKey = new Map<string, HouseGroups>()
  for (const row of rows)
    for (const number of row.houses) {
      const key = normalizeHouse(number)
      const h = byKey.get(key) ?? { number, household: [], business: [], exempt: false }
      byKey.set(key, h)
      if (!row.group) h.exempt = true
      else {
        const list = row.household ? h.household : h.business
        if (!list.includes(row.group)) list.push(row.group)
      }
    }
  return [...byKey.values()]
}

/** City ids are "<rem_id>:<naspunkt_id>": every form step needs both. */
function splitCityId(id: string | undefined): [string, string] {
  const m = /^(\d+):(\d+)$/.exec(id ?? '')
  if (!m) throw new OutageError('not-found', `Zhytomyr: bad settlement id "${id}"`, { region: INFO.id })
  return [m[1]!, m[2]!]
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

