import { OutageError } from '../errors.js'
import { cellsToIntervals, compareGroups } from '../schedule.js'
import { matchScore, normalizeHouse, normalizeSettlement, normalizeStreet, streetType } from '../text.js'
import { kyivInstant, toKyivIso } from '../time.js'
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
import { mapLimit } from '../util.js'

/**
 * Chernivtsioblenergo (oblenergo.cv.ua). The schedule is server-rendered HTML with 48
 * half-hour cells per group; `/shutdowns/` shows today and `/shutdowns/?next` tomorrow.
 *
 * Groups are numbered 1–12 (not 1.1–6.2) and kept as the operator names them.
 *
 * Address search has no API: `/shutdowns-search/<district>/` renders a district's whole
 * directory (~21k rows) and the page filters it in the browser. We do the same — each
 * district is fetched once per provider instance and indexed in memory.
 */
const SITE = 'https://oblenergo.cv.ua'

const INFO: RegionInfo = {
  id: 'chernivtsi',
  name: 'Чернівецька область',
  operator: 'Чернівціобленерго',
  website: `${SITE}/shutdowns/`,
  capabilities: { schedule: true, addressSearch: true },
}

/** `<u>з</u>` заживлені (on) · `<o>в</o>` відключені · `<s>мз</s>` можливо заживлені */
const CELL: Record<string, IntervalKind | null> = { u: null, o: 'off', s: 'maybe' }

/** Districts ("дільниці") of `/shutdowns-search/<id>/`; 1 is the city of Chernivtsi. */
const DISTRICTS: readonly { id: number; name: string }[] = [
  { id: 1, name: 'Чернівці' },
  { id: 2, name: 'Вижницька' },
  { id: 3, name: 'Герцаївська' },
  { id: 4, name: 'Глибоцька' },
  { id: 5, name: 'Заставнівська' },
  { id: 6, name: 'Кіцманська' },
  { id: 7, name: 'Кельменецька' },
  { id: 8, name: 'Новоселицька' },
  { id: 9, name: 'Путильська' },
  { id: 10, name: 'Сокирянська' },
  { id: 11, name: 'Сторожинецька' },
  { id: 12, name: 'Хотинська' },
]

/** District directories are ~2 MB of HTML each; don't download all twelve at once. */
const DIRECTORY_CONCURRENCY = 3

/** One district, indexed: city → street → house → groups. */
interface Directory {
  cities: Map<string, CityEntry>
}
interface CityEntry {
  city: City
  streets: Map<string, StreetEntry>
  /** Directory rows, to tell a real settlement from a few stray rows elsewhere */
  rows: number
}
interface StreetEntry {
  street: Street
  houses: Map<string, { house: House; groups: Set<GroupId> }>
}

export function chernivtsiProvider(): Provider {
  const region = INFO.id
  const directories = new Map<number, Promise<Directory>>()
  let allCities: Promise<City[]> | null = null

  const directory = (ctx: ProviderContext, district: number) => {
    let dir = directories.get(district)
    if (!dir) {
      const name = DISTRICTS.find((d) => d.id === district)?.name ?? String(district)
      dir = ctx.http
        .text(`${SITE}/shutdowns-search/${district}/`, { region })
        .then((html) => parseDirectory(html, district, name))
      // a failed download shouldn't be cached
      dir.catch(() => directories.delete(district))
      directories.set(district, dir)
    }
    return dir
  }

  const cityEntry = async (ctx: ProviderContext, city: City | undefined) => {
    if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
    const entry = (await directory(ctx, districtOf(city.id))).cities.get(city.id)
    if (!entry) throw new OutageError('not-found', `${INFO.name}: unknown city ${city.name}`, { region })
    return entry
  }

  return {
    info: INFO,
    sampleAddress: { city: 'Чернівці', street: 'бульвар Героїв Крут', house: '10' },

    async getSchedules(ctx) {
      const today = await ctx.http.text(`${SITE}/shutdowns/`, { region })
      const pages = [today]
      // the link to tomorrow appears only once it is published
      if (today.includes('href="/shutdowns/?next"'))
        pages.push(await ctx.http.text(`${SITE}/shutdowns/?next`, { region }))
      return mergeDays(
        pages.map((p) => parseSchedulePage(p, ctx.now())),
        ctx.now(),
      )
    },

    async searchCities(ctx, query) {
      // fast path: the city of Chernivtsi is district 1 alone, no need to download the other 11
      if (matchScore(query, CITY_NAME, 'settlement') === 1)
        return [...(await directory(ctx, 1)).cities.values()].map((c) => c.city)
      allCities ??= mapLimit(DISTRICTS, DIRECTORY_CONCURRENCY, (d) => directory(ctx, d.id)).then(
        nameDuplicates,
      )
      allCities.catch(() => (allCities = null))
      return allCities
    },

    async searchStreets(ctx, query, city) {
      const entry = await cityEntry(ctx, city)
      return [...entry.streets.values()].map((s) => s.street)
    },

    async searchHouses(ctx, street) {
      const city = { id: street.cityId ?? '', name: '' }
      const entry = (await cityEntry(ctx, city)).streets.get(street.id)
      return entry ? [...entry.houses.values()].map((h) => h.house) : []
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      const entry = await cityEntry(ctx, city ?? { id: street.cityId ?? '', name: '' })
      const hit = entry.streets.get(street.id)?.houses.get(house.id)
      if (!hit)
        throw new OutageError(
          'not-found',
          `${house.number}, ${street.name}: not in the operator's directory`,
          { region },
        )
      const [group, ...other] = [...hit.groups].sort(compareGroups)
      return {
        region,
        group: group!,
        ...(other.length ? { otherGroups: other } : {}),
        address: { city: entry.city.name, street: street.name, house: house.number },
      }
    },
  }
}

// --- schedule ---

/** One `/shutdowns/` page → its day for every group. Exported for tests. */
export function parseSchedulePage(
  html: string,
  now: Date,
): { date: string; days: Record<GroupId, DaySchedule>; updatedAt: string | null } {
  const region = INFO.id
  const gsv = html.indexOf('<div id="gsv"')
  if (gsv === -1)
    throw new OutageError('parse', 'Chernivtsi: no schedule block (#gsv) on the page', { region })
  const block = html.slice(gsv)

  const dateText = /<ul>\s*<p>\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(block)
  if (!dateText) throw new OutageError('parse', 'Chernivtsi: no date in the schedule block', { region })
  const date = `${dateText[3]}-${dateText[2]}-${dateText[1]}`

  const days: Record<GroupId, DaySchedule> = {}
  const rows = [...block.matchAll(/<div id="inf(\d+)"[^>]*>([\s\S]*?)<\/div>/g)]
  if (!rows.length)
    throw new OutageError('parse', 'Chernivtsi: no group rows in the schedule block', { region })
  let anyOutage = false
  for (const [, group, inner] of rows) {
    const cells = [...inner!.matchAll(/<(u|o|s)>[^<]*<\/\1>/g)].map((m) => CELL[m[1]!]!)
    if (cells.length !== 48)
      throw new OutageError('parse', `Chernivtsi: group ${group} has ${cells.length} cells, expected 48`, {
        region,
      })
    if (cells.some((c) => c)) anyOutage = true
    days[String(Number(group))] = { date, status: 'scheduled', intervals: cellsToIntervals(date, cells) }
  }
  // a page that is all "з" means no outages for anyone that day
  if (!anyOutage) for (const d of Object.values(days)) d.status = 'no-outages'

  return { date, days, updatedAt: parseUpdatedAt(html, now) }
}

/**
 * "Графік актуальний станом на <b>23:30</b>" carries only a time. It's combined with the
 * server's render date ("Сторінку відкрито 05.11.2026 о 23:46"); a time later than the render
 * time belongs to the day before.
 */
function parseUpdatedAt(html: string, now: Date): string | null {
  const time = /актуальний станом на\s*<b>\s*(\d{1,2}):(\d{2})\s*<\/b>/.exec(html)
  if (!time) return null
  const minutes = Number(time[1]) * 60 + Number(time[2])
  const opened = /Сторінку відкрито\s*(\d{2})\.(\d{2})\.(\d{4})\s*о\s*(\d{1,2}):(\d{2})/.exec(html)
  let day: string
  let openedAt: number
  if (opened) {
    day = `${opened[3]}-${opened[2]}-${opened[1]}`
    openedAt = Number(opened[4]) * 60 + Number(opened[5])
  } else {
    const iso = toKyivIso(now)
    day = iso.slice(0, 10)
    openedAt = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16))
  }
  let at = kyivInstant(day, minutes)
  if (minutes > openedAt) at = new Date(at.getTime() - 86_400_000)
  return toKyivIso(at)
}

function mergeDays(pages: ReturnType<typeof parseSchedulePage>[], now: Date): RegionSchedule {
  const schedules: Record<GroupId, DaySchedule[]> = {}
  let updatedAt: string | null = null
  for (const page of [...pages].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const [g, day] of Object.entries(page.days)) (schedules[g] ??= []).push(day)
    if (page.updatedAt && (!updatedAt || Date.parse(page.updatedAt) > Date.parse(updatedAt)))
      updatedAt = page.updatedAt
  }
  return {
    region: INFO.id,
    groups: Object.keys(schedules).sort(compareGroups),
    schedules,
    updatedAt,
    fetchedAt: toKyivIso(now),
  }
}

// --- address directory ---

/** District 1's table has no settlement column: it is the city itself. */
const CITY_NAME = 'м. Чернівці'

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A `/shutdowns-search/<district>/` page → index. The city table (district 1) has rows
 * `<p>street</p><b>буд. N</b><u>group</u>`; the others add `<s>settlement</s>` first.
 * The same street or settlement is spelled in several cases ("м. ВИЖНИЦЯ" / "м. Вижниця"),
 * so entries are keyed by their normalized names. Exported for tests.
 */
export function parseDirectory(html: string, district: number, districtName: string): Directory {
  const region = INFO.id
  const table = /<div id="(city|obl)_tbl"[^>]*>([\s\S]*)/.exec(html)
  if (!table)
    throw new OutageError('parse', `Chernivtsi: no address table for district ${district}`, { region })
  const isCity = table[1] === 'city'
  const cities = new Map<string, CityEntry>()

  const rowRe = isCity
    ? /<div><p>([^<]*)<\/p><b>([^<]*)<\/b><u>([^<]*)<\/u><\/div>/g
    : /<div><s>([^<]*)<\/s><p>([^<]*)<\/p><b>([^<]*)<\/b><u>([^<]*)<\/u><\/div>/g
  for (const m of table[2]!.matchAll(rowRe)) {
    const [cityName, streetName, houseText, groupText] = isCity
      ? [CITY_NAME, m[1]!, m[2]!, m[3]!]
      : [m[1]!, m[2]!, m[3]!, m[4]!]
    const street = decode(streetName).trim()
    const number = decode(houseText)
      .replace(/^\s*буд\.?\s*/i, '')
      .trim()
    const group = /^\s*(\d{1,2})\s*$/.exec(groupText)?.[1]
    // the directory has leftover rows with GUIDs instead of names
    if (!street || !number || !group || GUID.test(street) || GUID.test(number)) continue

    const settlement = decode(cityName).trim()
    const cityId = `${district}:${normalizeSettlement(settlement)}`
    let c = cities.get(cityId)
    if (!c) {
      c = {
        city: { id: cityId, name: titleCase(settlement), district: districtName },
        streets: new Map(),
        rows: 0,
      }
      cities.set(cityId, c)
    }
    // "вул. X" and "пров. X" are different streets; "бульвар X" and "бульвар X БУЛЬВ." are not
    const streetId = `${cityId}|${streetType(street) ?? ''}|${normalizeStreet(street)}`
    let s = c.streets.get(streetId)
    if (!s) {
      s = { street: { id: streetId, name: street, cityId }, houses: new Map() }
      c.streets.set(streetId, s)
    }
    const houseId = normalizeHouse(number)
    let h = s.houses.get(houseId)
    if (!h) {
      h = { house: { id: houseId, number, streetId }, groups: new Set() }
      s.houses.set(houseId, h)
    }
    h.groups.add(String(Number(group)))
    c.rows++
  }
  if (!cities.size)
    throw new OutageError('parse', `Chernivtsi: address table for district ${district} has no rows`, {
      region,
    })
  return { cities }
}

/**
 * A settlement name can occur in several districts: namesakes, or a few stray rows (district
 * directories list some addresses of the city of Chernivtsi). The one with the most rows keeps
 * the plain name; the others get their district appended, so a plain query picks the main one
 * and "Чернівці (Глибоцька)" still reaches the rest.
 */
function nameDuplicates(dirs: Directory[]): City[] {
  const byName = new Map<string, CityEntry[]>()
  for (const d of dirs)
    for (const c of d.cities.values()) {
      const key = normalizeSettlement(c.city.name)
      byName.set(key, [...(byName.get(key) ?? []), c])
    }
  for (const list of byName.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => b.rows - a.rows)
    for (const c of list.slice(1)) c.city.name = `${c.city.name} (${c.city.district})`
  }
  return dirs.flatMap((d) => [...d.cities.values()].map((c) => c.city))
}

/** City id is "<district>:<name>". */
const districtOf = (cityId: string) => Number(cityId.split(':')[0])

/** "м. ВИЖНИЦЯ" → "м. Вижниця", "с. СЛОБОДА-БАНИЛІВ" → "с. Слобода-Банилів"; mixed case is kept. */
function titleCase(name: string): string {
  return name.replace(/[А-ЯІЇЄҐ][А-ЯІЇЄҐ'’]+/g, (w) => w[0] + w.slice(1).toLowerCase())
}

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
}
