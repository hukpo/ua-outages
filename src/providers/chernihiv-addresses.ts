import { SECTIGO_DV_R36 } from '../certs.js'
import { OutageError } from '../errors.js'
import { openPdf, type PdfPage } from '../pdf/text.js'
import { compareGroups } from '../schedule.js'
import { normalizeHouse, normalizeSettlement, normalizeStreet, normalizeText } from '../text.js'
import type { AddressQuery, City, GroupId, GroupMatch, House, RegionId, Street } from '../types.js'
import { SharedTask } from '../util.js'
import type { ProviderContext } from './provider.js'

/**
 * Chernihivoblenergo's address list: one PDF, "Графік погодинного відключення … з 25.12.2025",
 * a table of group ("3/2"), service district ("Чернігівські МЕМ"), settlement ("ЧЕРНІГІВ") and
 * "Street: houses" ("Магістратська: 1, 3, 5, 7, 9, 11"), one row per street and feeder.
 *
 * It is the operator's file as of that date: the site no longer links it (the button is
 * commented out) though it is still served, and it wasn't replaced when checked in November 2026.
 * Its groups matched the outage windows of 96% of 400 houses sampled then; rows for houses since
 * moved to another group are to be expected. `addressSource` gives the date the file states.
 *
 * What the list doesn't say:
 * - the street type. "Миру" is both вулиця Миру and проспект Миру, so a number listed under one
 *   bare name in several groups comes back with all of them (`otherGroups`);
 * - which same-named village is meant, beyond the service district (`City.district`);
 * - anything about a house that isn't listed: that is `not-found`, never a neighbour's group.
 *
 * The file is 6.6 MB: downloaded once, kept as a compact index (not the PDF) for `DIRECTORY_TTL_MS`,
 * then revalidated with `If-Modified-Since`.
 */
export const CHERNIHIV_ADDRESS_PDF = 'https://chernihivoblenergo.com.ua/files/other/Grafik_obmezhen.pdf'
/** The file hasn't changed since January 2026; revalidating costs one conditional request */
const DIRECTORY_TTL_MS = 12 * 3600_000
/** After a failed refresh the previous index is served, and the operator isn't asked again for this long */
const RETRY_AFTER_FAILURE_MS = 15 * 60_000
/** With no index yet, a failed download is the answer for this long: the server bans bursts */
const RETRY_AFTER_FIRST_FAILURE_MS = 60_000
/** Pages parsed before letting other work run: about 15 ms */
const PAGES_PER_SLICE = 8

/** A stray filing is a building or two, not a street */
const STRAY_HOUSES = 3
/** A district name the operator files its own buildings and odd feeders under, in any town */
const NO_DISTRICT = 'ат чернігівобленерго'
/** The city network and the network around the city: one area, with the suburbs split between them */
const CITY_PAIR = ['чернігівські мем', 'чернігівський рем']

/** One table row. `houses` is the list as written: "2, 2А, 4А, 87\1, 30Б/\15" */
export interface ChernihivRow {
  group: GroupId
  district: string
  settlement: string
  street: string
  houses: string
}

interface StreetEntry {
  street: Street
  /** Kept as text and split on demand: 312 000 house objects would cost far more than 3 MB of lists */
  rows: { group: GroupId; houses: string }[]
}
interface CityEntry {
  city: City
  streets: Map<string, StreetEntry>
  rows: number
}
export interface ChernihivDirectory {
  cities: Map<string, CityEntry>
  /** "2025-12-25": the date in the file's own heading, null when it has none */
  asOf: string | null
  /** The file's Last-Modified, ISO; null when the server didn't send one */
  modified: string | null
}

export interface ChernihivAddressSource {
  url: string
  /** The day the list is in force from, as its heading says ("з 25.12.2025"), "YYYY-MM-DD" */
  asOf: string | null
  /** When the operator last replaced the file (Last-Modified), ISO */
  modified: string | null
}

/**
 * The address part of the Chernihiv provider: spread it into the provider object.
 * `addressSource` isn't part of `Provider`; it tells how old the operator's list is.
 */
export function chernihivAddresses(region: RegionId, operator: string) {
  let task: SharedTask<ChernihivDirectory> | null = null
  let taskAt = 0
  let last: { dir: ChernihivDirectory; lastModified: string | null } | null = null
  let failed: { task: SharedTask<ChernihivDirectory>; at: number } | null = null

  const load = async (ctx: ProviderContext): Promise<ChernihivDirectory> => {
    let file
    try {
      file = await ctx.http.file(CHERNIHIV_ADDRESS_PDF, {
        region,
        // the server omits its intermediate certificate
        ca: [SECTIGO_DV_R36],
        // 6.6 MB
        timeoutMs: 60_000,
        ...(last?.lastModified
          ? { headers: { 'If-Modified-Since': last.lastModified }, acceptStatus: [304] }
          : {}),
      })
    } catch (e) {
      // the list is a year old: an unreachable server is no reason to stop answering from it
      if (!last || ctx.signal?.aborted) throw e
      taskAt = Date.now() - DIRECTORY_TTL_MS + RETRY_AFTER_FAILURE_MS
      return last.dir
    }
    if (last && !file.bytes.length) return last.dir
    const lastModified = file.headers.get('last-modified')
    let parsed
    try {
      parsed = await parseChernihivPdf(file.bytes, ctx.signal)
    } catch (cause) {
      if (!(cause instanceof OutageError) || cause.code !== 'parse') throw cause
      throw new OutageError('parse', `${operator} address list: ${cause.message}`, {
        region,
        url: CHERNIHIV_ADDRESS_PDF,
        cause,
      })
    }
    const stamp = Date.parse(lastModified ?? '')
    const dir = buildChernihivDirectory(parsed.rows, {
      asOf: parsed.asOf,
      modified: Number.isNaN(stamp) ? null : new Date(stamp).toISOString(),
    })
    last = { dir, lastModified }
    return dir
  }

  const directory = (ctx: ProviderContext) => {
    const now = Date.now()
    const failedLongAgo = failed?.task === task && now - failed.at >= RETRY_AFTER_FIRST_FAILURE_MS
    if (!task || task.aborted || failedLongAgo || now - taskAt > DIRECTORY_TTL_MS) {
      taskAt = now
      const t = new SharedTask((signal) => load({ ...ctx, http: ctx.http.withSignal(signal), signal }))
      task = t
      // kept for a minute, so that a burst of lookups isn't a burst of requests to a server
      // that answers bursts by refusing connections
      t.promise.catch(() => {
        if (task === t) failed = { task: t, at: Date.now() }
      })
    }
    return task.join(ctx.signal)
  }

  const streetEntry = async (ctx: ProviderContext, street: Street) => {
    const entry = (await directory(ctx)).cities.get(street.cityId ?? '')?.streets.get(street.id)
    if (!entry) throw new OutageError('not-found', `${operator}: unknown street ${street.name}`, { region })
    return entry
  }

  return {
    /** In the list since it was published; its windows matched group 3.2's on 17.11.2026 */
    sampleAddress: { city: 'Чернігів', street: 'Магістратська', house: '19' } satisfies AddressQuery,

    async searchCities(ctx: ProviderContext): Promise<City[]> {
      return [...(await directory(ctx)).cities.values()].map((c) => c.city)
    },

    async searchStreets(ctx: ProviderContext, _query: string, city?: City): Promise<Street[]> {
      const entry = (await directory(ctx)).cities.get(city?.id ?? '')
      if (!entry) throw new OutageError('not-found', `${operator}: unknown city ${city?.name}`, { region })
      return [...entry.streets.values()].map((s) => s.street)
    },

    async searchHouses(ctx: ProviderContext, street: Street, query?: string): Promise<House[]> {
      const entry = await streetEntry(ctx, street)
      let list = [...housesOf(entry)].map(([key, h]) => ({ key, number: h.number }))
      if (query?.trim()) {
        const want = houseKey(query)
        const loose = normalizeHouse(query)
        const base = /^\d+/.exec(want)?.[0]
        // "871" must not pick "87/1", which only looks the same once the separators are dropped
        list = list.filter((h) => h.key === want || normalizeHouse(h.number) !== loose)
        const rank = (h: { key: string }) =>
          h.key === want ? 0 : base && /^\d+/.exec(h.key)?.[0] === base ? 1 : 2
        list = list
          .map((h, i) => ({ h, i }))
          .sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i)
          .map((x) => x.h)
      }
      return list.map((h) => ({ id: `${street.id}#${h.key}`, number: h.number, streetId: street.id }))
    },

    async groupOf(ctx: ProviderContext, house: House, street: Street, city?: City): Promise<GroupMatch> {
      const entry = await streetEntry(ctx, street)
      const found = housesOf(entry).get(house.id.slice(street.id.length + 1))
      if (!found)
        throw new OutageError('not-found', `${house.number}, ${street.name}: not in the operator's list`, {
          region,
        })
      const [group, ...other] = [...found.groups].sort(compareGroups)
      return {
        region,
        group: group!,
        ...(other.length ? { otherGroups: other } : {}),
        address: { city: city?.name, street: street.name, house: found.number },
      }
    },

    /** Which file the answers come from and the date it states. Not a `Provider` method. */
    async addressSource(ctx: ProviderContext): Promise<ChernihivAddressSource> {
      const dir = await directory(ctx)
      return { url: CHERNIHIV_ADDRESS_PDF, asOf: dir.asOf, modified: dir.modified }
    },
  }
}

// --- the PDF ---

const HEADERS = ['Черга/Підчерга', 'Дільниця', 'Населений пункт', 'Адреси']

/**
 * The whole file → rows, a few pages at a time so that a 190-page parse doesn't hold the event
 * loop. Exported for tests.
 */
export async function parseChernihivPdf(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ rows: ChernihivRow[]; asOf: string | null }> {
  const doc = openPdf(bytes)
  if (!doc.pageCount) throw new OutageError('parse', 'no pages')
  const first = doc.page(0)
  const columns = HEADERS.map((h) => first.runs.find((r) => r.text.trim() === h)?.x)
  if (columns.some((x) => x === undefined) || columns.some((x, i) => i > 0 && x! <= columns[i - 1]!))
    throw new OutageError('parse', `no "${HEADERS.join(' | ')}" header on page 1`)
  const headerY = first.runs.find((r) => r.text.trim() === HEADERS[0])!.y
  const heading = first.runs.find((r) => r.y > headerY && /\d{2}\.\d{2}\.\d{4}/.test(r.text))?.text
  const date = /(\d{2})\.(\d{2})\.(\d{4})/.exec(heading ?? '')

  const rows: ChernihivRow[] = []
  for (let i = 0; i < doc.pageCount; i++) {
    if (i && i % PAGES_PER_SLICE === 0) {
      await new Promise((resolve) => setImmediate(resolve))
      signal?.throwIfAborted()
    }
    for (const row of pageRows(doc.page(i), columns as number[], i === 0 ? headerY : Infinity, i + 1))
      rows.push(row)
  }
  if (!rows.length) throw new OutageError('parse', 'no rows')
  return { rows, asOf: date ? `${date[3]}-${date[2]}-${date[1]}` : null }
}

/**
 * Rows of one page. The group, district and settlement cells are one run each, in row order; an
 * address cell is one run per printed line. Excel clips a wrapped cell to its own box, so the
 * lines of one cell share a clip rectangle, and a one-line cell has none of its own.
 *
 * The three counts must agree, every address must read "Street: …" and every group must sit
 * beside its address cell; a page where they don't is a `parse` error, not a best guess.
 */
function pageRows(page: PdfPage, columns: number[], below: number, pageNo: number): ChernihivRow[] {
  const bad = (why: string): never => {
    throw new OutageError('parse', `page ${pageNo}: ${why}`)
  }
  const cells: { y: number; text: string; clip: PdfPage['runs'][number]['clip'] }[][] = [[], [], [], []]
  for (const r of page.runs) {
    if (r.y >= below - 1) continue
    if (r.text.includes('�')) bad('unreadable characters')
    let col = -1
    for (let i = 0; i < columns.length; i++) if (r.x >= columns[i]! - 2) col = i
    if (col === -1) bad(`text left of the table: "${r.text.slice(0, 40)}"`)
    cells[col]!.push({ y: r.y, text: r.text, clip: r.clip })
  }
  const [groups, districts, settlements, lines] = cells as [
    (typeof cells)[number],
    (typeof cells)[number],
    (typeof cells)[number],
    (typeof cells)[number],
  ]
  // a cell's own box is a few lines high; the table's clip is most of the page
  const boxed = (c: PdfPage['runs'][number]['clip']) => (c && c.h < page.height / 2 ? c : null)
  const entries: { text: string; top: number; bottom: number }[] = []
  let open: PdfPage['runs'][number]['clip'] = null
  for (const l of lines) {
    const box = boxed(l.clip)
    const prev = entries.at(-1)
    if (box && prev && open && box.y === open.y && box.h === open.h) prev.text += l.text
    else
      entries.push({
        text: l.text,
        top: box ? box.y + box.h + 1 : l.y + 1.5,
        bottom: box ? box.y - 1 : l.y - 1.5,
      })
    open = box
  }
  if (
    groups.length !== entries.length ||
    districts.length !== entries.length ||
    settlements.length !== entries.length
  )
    bad(
      `${groups.length} groups, ${districts.length} districts, ${settlements.length} settlements, ${entries.length} address cells`,
    )
  return entries.map((e, i) => {
    const g = groups[i]!
    const group = /^\s*([1-9])\/([1-9])\s*$/.exec(g.text)
    if (!group) bad(`"${g.text}" is not a group`)
    if (g.y > e.top || g.y < e.bottom) bad(`group ${g.text} is not beside "${e.text.slice(0, 30)}"`)
    const colon = e.text.indexOf(':')
    if (colon < 1 || colon > 80) bad(`"${e.text.slice(0, 40)}" is not "Street: houses"`)
    const district = districts[i]!.text.replace(/\s+/g, ' ').trim()
    const settlement = settlements[i]!.text.replace(/\s+/g, ' ').trim()
    if (!district || !settlement) bad('empty district or settlement')
    return {
      group: `${group![1]}.${group![2]}`,
      district,
      settlement,
      street: e.text.slice(0, colon).replace(/\s+/g, ' ').trim(),
      houses: e.text.slice(colon + 1).trim(),
    }
  })
}

// --- the index ---

const cityId = (district: string, settlement: string) =>
  `${normalizeText(district)}|${normalizeSettlement(settlement)}`

/** "ВЕЛИКА ВІСЬ" → "Велика Вісь", "КАМ`ЯНКА" → "Кам'янка", "НОВГОРОД-СІВЕРСЬКИЙ" → "Новгород-Сіверський" */
const titleCase = (s: string) =>
  s === s.toUpperCase()
    ? s
        .toLowerCase()
        .replace(/[`’ʼ]/g, "'")
        .replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase())
    : s

/** Rows → cities, streets and their house lists. Exported for tests. */
export function buildChernihivDirectory(
  rows: readonly ChernihivRow[],
  meta: { asOf: string | null; modified: string | null } = { asOf: null, modified: null },
): ChernihivDirectory {
  const dir: ChernihivDirectory = { cities: new Map(), ...meta }
  for (const r of rows) {
    const cid = cityId(r.district, r.settlement)
    let city = dir.cities.get(cid)
    if (!city) {
      city = {
        city: { id: cid, name: titleCase(r.settlement), district: r.district },
        streets: new Map(),
        rows: 0,
      }
      dir.cities.set(cid, city)
    }
    city.rows++
    addStreetRow(city, r.street, { group: r.group, houses: r.houses })
  }
  mergeStrays(dir)
  return dir
}

function addStreetRow(city: CityEntry, name: string, row: StreetEntry['rows'][number]) {
  // a name that is only a type word ("Набережна" isn't one, "Проїзд" is) keeps its text
  const sid = `${city.city.id}|${normalizeStreet(name) || normalizeText(name)}`
  let st = city.streets.get(sid)
  if (!st) city.streets.set(sid, (st = { street: { id: sid, name, cityId: city.city.id }, rows: [] }))
  st.rows.push(row)
}

/**
 * The same town under several districts. "ЧЕРНІГІВ" has 764 rows under Чернігівські МЕМ, 20
 * under Чернігівський РЕМ and one under АТ ЧЕРНІГІВОБЛЕНЕРГО; "БАХМАЧ" has 216 under Бахмацька
 * дільниця and one under Борзнянська: buildings fed from the neighbouring district, not other
 * towns. Three cases are merged into the entry with the most rows:
 * - the operator's own pseudo-district, when one real entry remains to take it;
 * - the city network and the network around it (Chernihiv and its suburbs);
 * - one or two rows naming at most three houses, beside ten times as many rows. A one-row
 *   village lists its whole street (Довжик of Семенівська дільниця: 46 houses) and stays apart.
 * Real namesakes (Городище: 21, 19 and 18 rows in three districts) stay apart and are told
 * apart by `City.district`.
 */
function mergeStrays(dir: ChernihivDirectory) {
  const byName = new Map<string, CityEntry[]>()
  for (const c of dir.cities.values()) {
    const k = normalizeSettlement(c.city.name)
    byName.set(k, [...(byName.get(k) ?? []), c])
  }
  const districtOf = (c: CityEntry) => normalizeText(c.city.district ?? '')
  for (const list of byName.values()) {
    if (list.length < 2) continue
    const real = list.filter((c) => districtOf(c) !== NO_DISTRICT)
    const main = (real.length ? real : list).reduce((a, b) => (b.rows > a.rows ? b : a))
    const gone = new Set<CityEntry>()
    const merge = (c: CityEntry) => {
      for (const st of c.streets.values()) for (const row of st.rows) addStreetRow(main, st.street.name, row)
      main.rows += c.rows
      dir.cities.delete(c.city.id)
      gone.add(c)
    }
    for (const c of list) {
      if (c === main || districtOf(c) === NO_DISTRICT) continue
      const pair = CITY_PAIR.includes(districtOf(c)) && CITY_PAIR.includes(districtOf(main))
      if (pair || (c.rows <= 2 && main.rows >= 10 * c.rows && houseCount(c) <= STRAY_HOUSES)) merge(c)
    }
    const left = list.filter((c) => !gone.has(c) && districtOf(c) !== NO_DISTRICT)
    for (const c of list)
      if (c !== main && districtOf(c) === NO_DISTRICT && (left.length === 1 || main.rows >= 10 * c.rows))
        merge(c)
  }
}

const houseCount = (c: CityEntry) => {
  let n = 0
  for (const st of c.streets.values()) for (const row of st.rows) n += parseChernihivHouses(row.houses).length
  return n
}

// --- houses ---

/**
 * "2, 2А, 87\1, 30Б/\15, 68Б-\1, 30Б к.30" → houses by key. The backslash is the operator's
 * fraction sign, written "\", "/\" or "-\": shown as "/". A token that doesn't start with a
 * number ("В", "\22") names no house and is left out. Exported for tests.
 */
export function parseChernihivHouses(list: string): { key: string; number: string }[] {
  const out: { key: string; number: string }[] = []
  for (const raw of list.split(',')) {
    const number = raw
      .replace(/\s*[/-]*\\+\s*/g, '/')
      .replace(/\s+/g, ' ')
      .trim()
    if (!/^\d/.test(number)) continue
    out.push({ key: houseKey(number), number })
  }
  return out
}

/**
 * What makes two spellings one house: case, Latin look-alikes, spaces, dots and the dash before
 * a letter ("4-Г" = "4Г"). The fraction stays ("87/1" ≠ "871"), typed as "/", "\" or "87-1".
 */
export function houseKey(s: string): string {
  return s
    .toUpperCase()
    .replace(/[ABCEHIKMOPTX]/g, (c) => LATIN[c]!)
    .replace(/№/g, '')
    .replace(/\\+/g, '/')
    .replace(/[\s.]/g, '')
    .replace(/(\d)-(?=\d)/g, '$1/')
    .replace(/(\d)-(?=\p{L})/gu, '$1')
}
const LATIN: Record<string, string> = {
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  I: 'І',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
}

/** Split anew on each call: a street is a few rows, and nothing then grows with use */
function housesOf(entry: StreetEntry) {
  const houses = new Map<string, { number: string; groups: Set<GroupId> }>()
  for (const row of entry.rows)
    for (const h of parseChernihivHouses(row.houses)) {
      let known = houses.get(h.key)
      if (!known) houses.set(h.key, (known = { number: h.number, groups: new Set() }))
      known.groups.add(row.group)
    }
  return houses
}
