import { OutageError } from '../errors.js'
import { compareGroups } from '../schedule.js'
import { houseKey, normalizeSettlement, normalizeStreet, streetType } from '../text.js'
import type { City, GroupId, GroupMatch, House, RegionId, Street } from '../types.js'
import { mapLimit, SharedTask } from '../util.js'
import type { ProviderContext } from './provider.js'

/**
 * Zaporizhzhiaoblenergo's address lists. Two pages on zoe.com.ua link one Google Sheet per group:
 * the city of Zaporizhzhia (households, "м. Запоріжжя, Черга 1, підчерга 2") and the rest of
 * the area ("1 черга ІІ підчерга", rows of community, settlement, street, houses, consumer, and
 * the group by schedule and the actual one). Each sheet is read as CSV through the public gviz
 * endpoint and the lot is indexed in memory.
 *
 * Houses come as "1|10А|34-40|1–15 непарні|17 п.1–2|145 (5 пов)". A range runs over one side of
 * the street ("34-40" is 34, 36, 38, 40) unless it says "поспіль"; entrances, floors and notes
 * are dropped. A street with no houses listed is in that group whole. A building in several
 * sheets (one per entrance) has several groups.
 */
const SITE = 'https://www.zoe.com.ua'
export const ZOE_ADDRESS_PAGES = [
  `${SITE}/${encodeURIComponent('перелік-адрес-для-кожної-з-черг-з-підч')}/`,
  `${SITE}/${encodeURIComponent('перелік-адрес-для-кожної-з-черг-з-підче')}/`,
]
const CITY = { community: 'Запорізька ТГ', settlement: 'м. Запоріжжя' }
/** The lists change a few times a month */
const DIRECTORY_TTL_MS = 6 * 3600_000
/** A range longer than this is a typo, not a street side */
const MAX_RANGE = 600

interface HouseEntry {
  house: House
  groups: Set<GroupId>
}
interface StreetEntry {
  street: Street
  houses: Map<string, HouseEntry>
  /** "34-40": the numbers of a range, for "36а" which no list names */
  rangeBase: Map<number, Set<GroupId>>
  /** No houses listed: the whole street */
  whole: Set<GroupId>
}
interface CityEntry {
  city: City
  streets: Map<string, StreetEntry>
  /** Sheet rows, to tell a settlement from a row filed under the wrong community */
  rows: number
}
export interface ZoeDirectory {
  cities: Map<string, CityEntry>
}

/** One linked sheet: its id, tab and the group in its title */
export interface ZoeSheet {
  id: string
  gid: string | null
  group: GroupId | null
  /** The city page: two columns (street, houses) of Zaporizhzhia */
  city: boolean
}

export function zoeAddresses(region: RegionId, operator: string) {
  let task: SharedTask<ZoeDirectory> | null = null
  let taskAt = 0

  const load = async (ctx: ProviderContext): Promise<ZoeDirectory> => {
    const pages = await Promise.all(ZOE_ADDRESS_PAGES.map((u) => ctx.http.text(u, { region })))
    const sheets = pages.flatMap((html, i) => parseSheetLinks(html, i === 0))
    if (sheets.length < 12)
      throw new OutageError('parse', `${operator}: ${sheets.length} address sheets linked, expected ~23`, {
        region,
      })
    const dir: ZoeDirectory = { cities: new Map() }
    await mapLimit(
      sheets,
      4,
      async (s) => {
        const url = `https://docs.google.com/spreadsheets/d/${s.id}/gviz/tq?tqx=out:csv${s.gid ? `&gid=${s.gid}` : ''}`
        addSheet(dir, s, parseCsv(await ctx.http.text(url, { region })))
      },
      ctx.signal,
    )
    mergeStrays(dir)
    return dir
  }

  const directory = (ctx: ProviderContext) => {
    if (!task || task.aborted || Date.now() - taskAt > DIRECTORY_TTL_MS) {
      taskAt = Date.now()
      const t = new SharedTask((signal) => load({ ...ctx, http: ctx.http.withSignal(signal), signal }))
      task = t
      t.promise.catch(() => {
        if (task === t) task = null
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
    async searchCities(ctx: ProviderContext): Promise<City[]> {
      return [...(await directory(ctx)).cities.values()].map((c) => c.city)
    },

    async searchStreets(ctx: ProviderContext, _query: string, city?: City): Promise<Street[]> {
      const dir = await directory(ctx)
      const entry = dir.cities.get(city?.id ?? cityId(CITY.community, CITY.settlement))
      if (!entry) throw new OutageError('not-found', `${operator}: unknown city ${city?.name}`, { region })
      return [...entry.streets.values()].map((s) => s.street)
    },

    async searchHouses(ctx: ProviderContext, street: Street, query?: string): Promise<House[]> {
      const entry = await streetEntry(ctx, street)
      const houses = [...entry.houses.values()].map((h) => h.house)
      // "36а" inside "34-40", any number on a street listed whole: not in the list, but known
      const q = query ? houseKey(query) : ''
      if (q && !entry.houses.has(q) && groupsOf(entry, q).size)
        houses.push({ id: houseId(street.id, q), number: query!.trim(), streetId: street.id })
      return houses
    },

    async groupOf(ctx: ProviderContext, house: House, street: Street, city?: City): Promise<GroupMatch> {
      const entry = await streetEntry(ctx, street)
      const groups = [...groupsOf(entry, house.id.slice(street.id.length + 1))].sort(compareGroups)
      if (!groups.length)
        throw new OutageError('not-found', `${house.number}, ${street.name}: not in the operator's lists`, {
          region,
        })
      const [group, ...other] = groups
      return {
        region,
        group: group!,
        ...(other.length ? { otherGroups: other } : {}),
        address: { city: city?.name, street: street.name, house: house.number },
      }
    },
  }
}

const cityId = (community: string, settlement: string) =>
  `${normalizeSettlement(community)}|${normalizeSettlement(settlement)}`
const streetId = (city: string, name: string) => `${city}|${streetType(name) ?? ''}|${normalizeStreet(name)}`
const houseId = (street: string, norm: string) => `${street}#${norm}`

function groupsOf(entry: StreetEntry, norm: string): Set<GroupId> {
  const out = new Set(entry.whole)
  const exact = entry.houses.get(norm)
  if (exact) for (const g of exact.groups) out.add(g)
  else {
    const base = /^\d+/.exec(norm)
    for (const g of (base && entry.rangeBase.get(Number(base[0]))) || []) out.add(g)
  }
  return out
}

/**
 * "м. Вільнянськ" has 433 rows under Вільнянська ТГ and one each under Павлівська and Матвіївська:
 * those are filing slips, not other towns. A settlement's one or two rows go to the community
 * with ten times as many of the same name; two real villages of one name (Широке, 36 and 15)
 * stay apart. Exported for tests.
 */
export function mergeStrays(dir: ZoeDirectory) {
  const byName = new Map<string, CityEntry[]>()
  for (const c of dir.cities.values()) {
    const k = normalizeSettlement(c.city.name)
    byName.set(k, [...(byName.get(k) ?? []), c])
  }
  for (const list of byName.values()) {
    if (list.length < 2) continue
    const main = list.reduce((a, b) => (b.rows > a.rows ? b : a))
    for (const c of list) {
      if (c === main || c.rows > 2 || main.rows < 10 * c.rows) continue
      for (const st of c.streets.values()) {
        const sid = streetId(main.city.id, st.street.name)
        const into = main.streets.get(sid)
        if (!into) {
          main.streets.set(sid, rekey(st, sid, main.city.id))
          continue
        }
        for (const g of st.whole) into.whole.add(g)
        for (const [n, gs] of st.rangeBase) {
          const set = into.rangeBase.get(n) ?? new Set()
          for (const g of gs) set.add(g)
          into.rangeBase.set(n, set)
        }
        for (const [norm, h] of st.houses) {
          const to = into.houses.get(norm)
          if (to) for (const g of h.groups) to.groups.add(g)
          else
            into.houses.set(norm, {
              house: { ...h.house, id: houseId(sid, norm), streetId: sid },
              groups: h.groups,
            })
        }
      }
      main.rows += c.rows
      dir.cities.delete(c.city.id)
    }
  }
}

function rekey(st: StreetEntry, sid: string, cityId: string): StreetEntry {
  const houses = new Map<string, HouseEntry>()
  for (const [norm, h] of st.houses)
    houses.set(norm, { house: { ...h.house, id: houseId(sid, norm), streetId: sid }, groups: h.groups })
  return { ...st, street: { ...st.street, id: sid, cityId }, houses }
}

// --- pages ---

/** Sheet links on one of the two pages. Exported for tests. */
export function parseSheetLinks(html: string, city: boolean): ZoeSheet[] {
  const out: ZoeSheet[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(
    /<a\b[^>]*href="(https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
  )) {
    const id = m[2]!
    if (seen.has(id)) continue
    seen.add(id)
    const label = m[3]!.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
    out.push({ id, gid: /[?#&]gid=(\d+)/.exec(m[1]!)?.[1] ?? null, group: groupLabel(label), city })
  }
  return out
}

/** "Черга 1, підчерга 2", "1 черга ІІ підчерга", "1 черга 1 підчерга" → "1.2" */
export function groupLabel(s: string): GroupId | null {
  const q = /(\d)\s*черг|черг\S*\s*(\d)/iu.exec(s)
  const sub = /(ІІ|II|І|I|\d)\s*підчерг|підчерг\S*\s*(\d)/iu.exec(s)
  if (!q || !sub) return null
  const part = (sub[1] ?? sub[2])!
  const n = /^\d$/.test(part) ? Number(part) : part.length
  return n === 1 || n === 2 ? `${q[1] ?? q[2]}.${n}` : null
}

// --- sheets ---

/** RFC 4180 CSV as Google writes it. Exported for tests. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((cell += '"'), i++)
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') (row.push(cell), (cell = ''))
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      ;(row.push(cell), rows.push(row), (row = []), (cell = ''))
    } else cell += c
  }
  if (cell || row.length) (row.push(cell), rows.push(row))
  return rows
}

/** One sheet's rows into the directory. Exported for tests. */
export function addSheet(dir: ZoeDirectory, sheet: ZoeSheet, rows: string[][]) {
  const header = rows.findIndex((r) => r.some((c) => /^вулиця$/iu.test(c.trim())))
  if (header === -1) {
    // "Відключення відсутні": a group with no addresses
    if (rows.some((r) => r.some((c) => /відключення\s+відсутні/iu.test(c)))) return
    throw new OutageError('parse', `Zaporizhzhia: sheet ${sheet.id} has no "Вулиця" column`, {
      region: 'zaporizhzhia',
    })
  }
  const cols = rows[header]!.map((c) => c.trim().toLowerCase())
  const col = (re: RegExp) => cols.findIndex((c) => re.test(c))
  const street = col(/^вулиця$/)
  const houses = col(/^будин/)
  const community = col(/^громада$/)
  const settlement = col(/^населений пункт$/)
  const actual = col(/^черга.*фактична/)
  const actualSub = col(/^підчерга.*фактична/)
  for (const r of rows.slice(header + 1)) {
    const name = r[street]?.trim()
    if (!name || !/\p{L}{2}/u.test(name)) continue
    const group =
      (actual >= 0 && r[actual]?.trim() && groupLabel(`${r[actual]} черга ${r[actualSub] ?? ''}`)) ||
      sheet.group
    if (!group) continue
    const town = sheet.city
      ? CITY
      : { community: r[community]?.trim() ?? '', settlement: r[settlement]?.trim() ?? '' }
    if (!town.settlement) continue
    addRow(dir, town, name, r[houses] ?? '', group)
  }
}

function addRow(
  dir: ZoeDirectory,
  town: { community: string; settlement: string },
  name: string,
  housesCell: string,
  group: GroupId,
) {
  const cid = cityId(town.community, town.settlement)
  let city = dir.cities.get(cid)
  if (!city) {
    city = { city: { id: cid, name: town.settlement, district: town.community }, streets: new Map(), rows: 0 }
    dir.cities.set(cid, city)
  }
  city.rows++
  const sid = streetId(cid, name)
  let st = city.streets.get(sid)
  if (!st) {
    st = { street: { id: sid, name, cityId: cid }, houses: new Map(), rangeBase: new Map(), whole: new Set() }
    city.streets.set(sid, st)
  }
  const parsed = parseHouses(housesCell)
  if (parsed.whole) st.whole.add(group)
  const add = (number: string, fromRange: boolean) => {
    // "1/1" and "11" are two houses: the key keeps what separates two numbers
    const norm = houseKey(number)
    if (!norm) return
    let h = st.houses.get(norm)
    if (!h) {
      h = { house: { id: houseId(sid, norm), number, streetId: sid }, groups: new Set() }
      st.houses.set(norm, h)
    }
    h.groups.add(group)
    if (fromRange) {
      const n = Number(number)
      let set = st.rangeBase.get(n)
      if (!set) st.rangeBase.set(n, (set = new Set()))
      set.add(group)
    }
  }
  for (const n of parsed.numbers) add(n, false)
  for (const r of parsed.ranges) for (let n = r.from; n <= r.to; n += r.step) add(String(n), true)
}

export interface ParsedHouses {
  numbers: string[]
  ranges: { from: number; to: number; step: 1 | 2 }[]
  /** Nothing listed: the whole street */
  whole: boolean
}

/** "1|10А|34-40|1–9 поспіль|17 п.1–2|145 (5 пов)|4,6 (9 пов)" → numbers and ranges. Exported for tests. */
export function parseHouses(cell: string): ParsedHouses {
  const out: ParsedHouses = { numbers: [], ranges: [], whole: false }
  if (!cell.trim()) {
    out.whole = true
    return out
  }
  for (const raw of cell.split('|')) {
    if (/без\s+номер/iu.test(raw)) continue
    const t = raw
      .replace(/\([^)]*\)?/g, ' ')
      // entrances "п.1–2", "п. №1-3"; floors "5 пов", "9эт"
      .replace(/п\.\s*№?\s*\d[\d\s,–—-]*/gu, ' ')
      .replace(/\d+\s*(?:пов|эт)\S*/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const range = /^(\d+)\s*[-–—]\s*(\d+)(?:\s*(парні|непарні|поспіль))?$/iu.exec(t)
    if (range) {
      const a = Number(range[1])
      const b = Number(range[2])
      const [from, to] = a <= b ? [a, b] : [b, a]
      if (to - from > MAX_RANGE) continue
      const word = range[3]?.toLowerCase()
      if (word === 'поспіль' || (!word && from % 2 !== to % 2)) out.ranges.push({ from, to, step: 1 })
      else {
        // "1-9 парні": from the first even one
        const start =
          word === 'парні' && from % 2 ? from + 1 : word === 'непарні' && !(from % 2) ? from + 1 : from
        out.ranges.push({ from: start, to, step: 2 })
      }
      continue
    }
    for (const piece of t.split(',')) {
      const m =
        /^(\d+)\s*-?\s*([а-яіїєґa-z](?![а-яіїєґa-z]))?\s*(?:\/\s*(\d+\s*[а-яіїєґa-z]?)(?![а-яіїєґa-z]))?(?:\s*корп(?:ус)?\.?\s*(\d+))?/iu.exec(
          piece.trim(),
        )
      if (!m) continue
      let n = m[1]! + (m[2] ? cyrillic(m[2]).toUpperCase() : '')
      if (m[3]) n += `/${cyrillic(m[3].replace(/\s+/g, '')).toUpperCase()}`
      if (m[4]) n += ` корп. ${m[4]}`
      out.numbers.push(n)
    }
  }
  return out
}

/** "14a" typed with a Latin a: shown as the Cyrillic "14А" */
const cyrillic = (s: string) => s.replace(/[abcehiopx]/giu, (c) => LATIN[c.toLowerCase()] ?? c)
const LATIN: Record<string, string> = {
  a: 'а',
  b: 'б',
  c: 'с',
  e: 'е',
  h: 'н',
  i: 'і',
  o: 'о',
  p: 'р',
  x: 'х',
}
