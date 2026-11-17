import { htmlToText } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { compareGroups } from '../schedule.js'
import { normalizeHouse, normalizeSettlement, normalizeStreet, streetType } from '../text.js'
import type { City, GroupId, GroupMatch, House, RegionId, Street } from '../types.js'
import type { ProviderContext } from './provider.js'

/**
 * The "Перелік адрес, що знеструмлюються по чергах та підчергах ГПВ" section of a uz.gov.ua
 * schedule page: a table (one per railway branch on two-branch pages) of settlement, street
 * and houses, cut into groups by header rows ("І черга/ ІI підчерга", "1 черга 1 півчерга", or a
 * row "1 черга" followed by rows "2 підчерга").
 *
 * Only that table is read. The tables under it list addresses that follow somebody else's
 * schedule (the oblenergo's, another oblast's) and are left out, as is the page footer.
 */
export interface UzAddressRow {
  /** Name in the «в межах обслуговування РФ "… залізниця"» heading above the table, if any */
  branch: string | null
  group: GroupId
  settlement: string
  street: string
  /** The houses cell as written: "1,10а,12", "б/н", "" */
  houses: string
}

export interface UzAddressSection {
  rows: UzAddressRow[]
  /** One-cell rows that are neither a group header nor part of an address (captions) */
  skipped: string[]
  /** Rows left out because their settlement can't be told (an empty cell with nothing to continue) */
  unplaced: number
}

interface Cell {
  text: string
  colspan: number
  rowspan: number
  yellow: boolean
}

const cellText = (s: string) => htmlToText(s).replace(/\s+/g, ' ').trim()

function cells(tr: string): Cell[] {
  return [...tr.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map((m) => ({
    text: cellText(m[2]!),
    colspan: Number(/colspan\s*=\s*["']?(\d+)/i.exec(m[1]!)?.[1] ?? 1),
    rowspan: Number(/rowspan\s*=\s*["']?(\d+)/i.exec(m[1]!)?.[1] ?? 1),
    yellow: /ffff00|yellow/i.test(m[1]!),
  }))
}

/** "ІІІ", "I V", "4" → number; Cyrillic "І" and Latin "I" are mixed inside one numeral */
function numeral(s: string): number | null {
  const t = s.replace(/\s+/g, '')
  if (/^\d+$/.test(t)) return Number(t)
  const n = ['I', 'II', 'III', 'IV', 'V', 'VI'].indexOf(t.replace(/[Ііi]/g, 'I').replace(/v/g, 'V')) + 1
  return n || null
}

const N = String.raw`(\d+|[IІіiVv]+(?:\s[IІіiVv]+)?)`
const FULL = new RegExp(`${N}\\s*[- ]?\\s*черг[а-яіїє]*\\s*/?\\s*${N}\\s*[- ]?\\s*(?:підчерг|півчерг)`, 'iu')
const QUEUE = new RegExp(`^${N}\\s*[- ]?\\s*черг[а-яіїє]*$`, 'iu')
const SUB = new RegExp(`^${N}\\s*[- ]?\\s*(?:підчерг|півчерг)[а-яіїє]*$`, 'iu')

/**
 * A group header: "І черга/ ІI підчерга" names both, "1 черга" the queue (the sub-queue comes
 * in a later row), "2 півчерга" the sub-queue. null = not a header. Exported for tests.
 */
export function uzGroupHeader(text: string): { queue?: number; sub?: number } | null {
  const t = text.trim()
  const ok = (n: number | null, max: number): n is number => n !== null && n >= 1 && n <= max
  const full = FULL.exec(t)
  if (full) {
    const queue = numeral(full[1]!)
    const sub = numeral(full[2]!)
    return ok(queue, 6) && ok(sub, 2) ? { queue, sub } : null
  }
  const q = QUEUE.exec(t)
  if (q) {
    const queue = numeral(q[1]!)
    return ok(queue, 6) ? { queue } : null
  }
  const s = SUB.exec(t)
  if (s) {
    const sub = numeral(s[1]!)
    return ok(sub, 2) ? { sub } : null
  }
  return null
}

const COLUMN_HEADER = /Найменування\s+населен/i
/** A stop or a km post written where a street belongs: "з.п.Удянська", "ст Лоза", "316 км" */
const PLACE = /^(?:з\.?\s*[\/.]?\s*п\.?|ст\.?|станція|роз['’ʼ]?їзд|рзд\.?)(?=\s|[.А-ЯІЇЄҐ])|^\d+\s*км\b/u
const blank = (s: string) => !s || /^[-–—]+$/.test(s)

/**
 * The address section of a page → its rows; null when the page has no such section (Kherson).
 * Rows above the first complete group header belong to no group and are left out.
 *
 * An empty settlement cell continues the settlement above it (the operator leaves merged cells
 * blank), but only inside one group and not after a row that names a stop or a km post instead
 * of a street: what follows that is somewhere else, and where isn't said.
 */
export function parseUzAddresses(html: string): UzAddressSection | null {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  const at = clean.indexOf('Перелік адрес')
  if (at === -1) return null
  const seg = clean.slice(at)
  const out: UzAddressSection = { rows: [], skipped: [], unplaced: 0 }
  let branch: string | null = null
  let queue: number | null = null
  let sub: number | null = null
  /** Settlement an empty cell continues; null when it can't be told */
  let above: string | null = null
  let last = 0
  let inList = false
  for (const m of seg.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const before = cellText(seg.slice(last, m.index))
    last = m.index + m[0].length
    const trs = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) => cells(r[0]))
    const header = trs.find((r) => r.some((c) => COLUMN_HEADER.test(c.text)))
    if (!header) {
      // the list cut in two tables (Lviv): the second starts right away with a group header.
      // Anything else under the list (other operators' addresses, notes, the footer) isn't it
      const firstRow = trs.find((r) => r.some((c) => c.text))?.filter((c) => c.text)
      const continues =
        inList && !before && firstRow?.length === 1 && uzGroupHeader(firstRow[0]!.text) !== null
      if (!continues) {
        inList = false
        continue
      }
    } else {
      const heading = /обслуговування\s+РФ\s*["«“]?\s*([^"»”]+)/i.exec(before)?.[1]?.trim()
      if (heading) {
        branch = heading
        queue = sub = null
      }
    }
    inList = true
    above = null
    // the Rivne table has an empty column before the settlement
    let first = 0
    let col = 0
    for (const c of header ?? []) {
      if (COLUMN_HEADER.test(c.text)) first = col
      col += c.colspan
    }
    /** column → text carried down by a rowspan, and for how many more rows */
    const carry = new Map<number, { text: string; left: number }>()
    for (const tr of trs) {
      if (!tr.length || tr === header) continue
      const filled = tr.filter((c) => c.text)
      if (!filled.length && !carry.size) continue
      // a row whose only text names a group is a header however it is laid out: one cell
      // across the table, a yellow one, or a plain first cell beside empty ones
      const alone = filled.length === 1 && !carry.size ? filled[0]! : null
      const h = alone ? uzGroupHeader(alone.text) : null
      if (alone && (h || alone.colspan >= 3 || alone.yellow)) {
        if (!h) {
          out.skipped.push(alone.text)
          continue
        }
        if (h.queue) {
          queue = h.queue
          sub = h.sub ?? null
        } else sub = h.sub!
        above = null
        continue
      }
      // the column numbers under the header: "1 | 2 | 3"
      if (filled.length === 3 && filled.every((c, i) => c.text === String(i + 1))) continue
      // a lone cell outside any rowspan continues the previous row's houses (",149,153,…")
      if (tr.length === 1 && !carry.size) {
        const prev = out.rows[out.rows.length - 1]
        if (/^[,;\d]/.test(filled[0]!.text) && prev && queue && sub)
          prev.houses = `${prev.houses},${filled[0]!.text}`
        else out.skipped.push(filled[0]!.text)
        continue
      }
      const row: string[] = []
      let i = 0
      for (let c = 0; c < first + 3; c++) {
        const held = carry.get(c)
        if (held) {
          row[c] = held.text
          if (--held.left === 0) carry.delete(c)
          continue
        }
        const cell = tr[i++]
        row[c] = cell?.text ?? ''
        if (!cell) continue
        if (cell.rowspan > 1) carry.set(c, { text: cell.text, left: cell.rowspan - 1 })
        // a cell spanning columns fills the first; the rest stay empty
        for (let k = 1; k < cell.colspan && c + 1 < first + 3; k++) row[++c] = ''
      }
      const [place, street, houses] = row.slice(first).map((s) => (blank(s) ? '' : s)) as [
        string,
        string,
        string,
      ]
      if (!queue || !sub || (!place && !street && !houses)) continue
      const settlement = place || above
      if (place) above = place
      if (PLACE.test(street) && !place) above = null
      if (!settlement) {
        out.unplaced++
        continue
      }
      // a settlement with nothing after it names no address
      if (!street && !houses) continue
      out.rows.push({ branch, group: `${queue}.${sub}`, settlement, street, houses })
    }
  }
  return out
}

// --- houses ---

export interface UzHouseRange {
  from: number
  to: number
  /** `same`: the ends have one parity and nothing says whether the other side is meant */
  parity: 'all' | 'odd' | 'even' | 'same'
  /** As written: "1-31", "9-85 (непарні)" */
  text: string
}

export interface UzHouses {
  /** Houses named one by one, as written (notes in brackets and trailing dots dropped) */
  numbers: string[]
  ranges: UzHouseRange[]
  /** "всі": the whole street */
  whole: boolean
  /** Buildings without a number: "б/н", "без номера", an empty cell */
  unnumbered: boolean
  /** Items that aren't a house number or can be read two ways, as written: "5 1", "123 км", "ФОП …" */
  unclear: string[]
}

const LETTER = 'а-яіїєґa-z'
const NUMBER = new RegExp(`^\\d+(?:\\s*-?\\s*[${LETTER}])?(?:\\s*/\\s*\\d*[${LETTER}]?\\d*)?$`, 'iu')
const RANGE = /^№?\s*(\d+)\s*[-–—]\s*(\d+)\s*(непарні|неп\.?|парні|пар\.?)?$/iu
/** Longer than this is a typo, not a run of houses */
const MAX_RANGE = 600

/**
 * A houses cell → what it names. The pages write lists ("1, 2А, 13/1"), runs ("1-31",
 * "9-85 (непарні)", "1 – 33неп."), "б/н" / "без номера" / nothing for a building without a
 * number, "всі", letters that continue a number ("1а,б,в"), dots for commas ("2.3"), notes in
 * brackets ("29(8 квартир)"), and things that aren't house numbers at all (km posts, company
 * names). Nothing is guessed: what can't be read as a number is kept apart in `unclear`.
 * Exported for tests.
 */
export function parseUzHouses(cell: string): UzHouses {
  const out: UzHouses = { numbers: [], ranges: [], whole: false, unnumbered: false, unclear: [] }
  const items = splitOutside(cell, /[,;]/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (!items.length) out.unnumbered = true
  /** The number a lone letter continues: "13а, б" → 13 */
  let base: string | null = null
  for (const raw of items) {
    const note = /\(([^)]*)\)?/.exec(raw)?.[1]?.toLowerCase() ?? ''
    // "17." ends a sentence, not a number
    const t = raw
      .replace(/\([^)]*\)?/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[.\s]+$/, '')
      .trim()
    if (/^(?:всі|всі будинки|вся вулиця)$/iu.test(t)) {
      out.whole = true
      continue
    }
    if (/^(?:б\s*\/\s*н|без\s+номера|без\s+адреси|[-–—])?$/iu.test(t)) {
      // only brackets, or nothing left: "(3 точки)"
      out.unnumbered = true
      continue
    }
    // "буд. 7, кв. 2": the flat belongs to the house before it
    if (/^кв\.?\s*\d/iu.test(t)) continue
    const range = RANGE.exec(t)
    if (range && Number(range[1]) < Number(range[2])) {
      const from = Number(range[1])
      const to = Number(range[2])
      const word = (range[3] ?? note).toLowerCase()
      if (to - from > MAX_RANGE) out.unclear.push(raw)
      else
        out.ranges.push({
          from,
          to,
          parity: /^неп/.test(word)
            ? 'odd'
            : /^пар/.test(word)
              ? 'even'
              : from % 2 !== to % 2
                ? 'all'
                : 'same',
          text: raw,
        })
      base = null
      continue
    }
    const house = /^буд\.?\s*(.+)$/iu.exec(t)?.[1] ?? t
    if (NUMBER.test(house) || (range && /^\d+-\d+$/.test(house))) {
      // "335-0", "2-0": not a run, a number written with a dash
      out.numbers.push(house)
      base = /^\d+/.exec(house)![0]
      continue
    }
    if (base && new RegExp(`^[${LETTER}]$`, 'iu').test(house)) {
      out.numbers.push(`${base}${house}`)
      continue
    }
    // "2.3", "12а.28", "9. 10. 28": a dot typed for a comma
    const dotted = house.split(/\s*\.\s*/)
    if (dotted.length > 1 && dotted.every((p) => new RegExp(`^\\d+[${LETTER}]?$`, 'iu').test(p))) {
      out.numbers.push(...dotted)
      base = /^\d+/.exec(dotted[dotted.length - 1]!)![0]
      continue
    }
    out.unclear.push(raw)
    base = null
  }
  return out
}

/** Splits on `sep` except inside brackets: "313 (Л-9, 27), 5" → ["313 (Л-9, 27)", " 5"] */
function splitOutside(s: string, sep: RegExp): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && sep.test(ch)) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * A house number for comparing: case, "№", Latin look-alikes, the dash before a letter and
 * spaces go, but "/" and a dash or space between digits stay: "1/5" is not "15", and "5 1"
 * is neither "51" nor "5".
 */
export function uzHouseKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[№.]/g, '')
    .replace(/[abcehikmoptx]/g, (c) => LATIN[c] ?? c)
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\d)\s*-\s*(?=\p{L})/gu, '$1')
    .replace(/\s*\/\s*/g, '/')
    .replace(/(?<!\d) | (?!\d)/g, '')
}
const LATIN: Record<string, string> = {
  a: 'а',
  b: 'в',
  c: 'с',
  e: 'е',
  h: 'н',
  i: 'і',
  k: 'к',
  m: 'м',
  o: 'о',
  p: 'р',
  t: 'т',
  x: 'х',
}

// --- directory ---

const NO_NUMBER = 'б/н'
const NO_STREET = 'без назви вулиці'

interface StreetEntry {
  street: Street
  /** key → how the operator writes it, and its groups */
  houses: Map<string, { number: string; groups: Set<GroupId> }>
  ranges: (UzHouseRange & { group: GroupId })[]
  whole: Set<GroupId>
  unnumbered: Set<GroupId>
  unclear: { text: string; group: GroupId }[]
}
interface CityEntry {
  city: City
  streets: Map<string, StreetEntry>
}
export interface UzDirectory {
  cities: Map<string, CityEntry>
}

/** Rows of one branch (all of them without `branch`) → the lookup directory. Exported for tests. */
export function uzDirectory(rows: readonly UzAddressRow[], branch?: string): UzDirectory {
  const mine = branch ? rows.filter((r) => r.branch?.includes(branch)) : rows
  // "Привокзальна" and "площа Привокзальна" are one street when the settlement has the name
  // under one type only; with "вул. X" and "пров. X" both, a bare "X" stays a street of its own
  const types = new Map<string, Set<string>>()
  const nameKey = (r: UzAddressRow) => `${normalizeSettlement(r.settlement)}|${normalizeStreet(r.street)}`
  for (const r of mine) {
    const type = streetType(r.street)
    if (!type) continue
    const set = types.get(nameKey(r)) ?? new Set()
    set.add(type)
    types.set(nameKey(r), set)
  }
  const dir: UzDirectory = { cities: new Map() }
  for (const r of mine) {
    const cid = normalizeSettlement(r.settlement)
    if (!cid) continue
    let city = dir.cities.get(cid)
    if (!city) dir.cities.set(cid, (city = { city: { id: cid, name: r.settlement }, streets: new Map() }))
    const known = types.get(nameKey(r))
    const type = streetType(r.street) ?? (known?.size === 1 ? [...known][0]! : '')
    const sid = `${cid}|${type}|${normalizeStreet(r.street)}`
    let st = city.streets.get(sid)
    if (!st) {
      st = {
        street: { id: sid, name: r.street || NO_STREET, cityId: cid },
        houses: new Map(),
        ranges: [],
        whole: new Set(),
        unnumbered: new Set(),
        unclear: [],
      }
      city.streets.set(sid, st)
    }
    // the spelling with the type is the one to show
    else if (streetType(r.street) && !streetType(st.street.name)) st.street.name = r.street
    const parsed = parseUzHouses(r.houses)
    if (parsed.whole) st.whole.add(r.group)
    if (parsed.unnumbered) st.unnumbered.add(r.group)
    for (const range of parsed.ranges) st.ranges.push({ ...range, group: r.group })
    for (const text of parsed.unclear) st.unclear.push({ text, group: r.group })
    for (const number of parsed.numbers) {
      const key = uzHouseKey(number)
      const h = st.houses.get(key) ?? { number, groups: new Set() }
      h.groups.add(r.group)
      st.houses.set(key, h)
    }
  }
  return dir
}

interface HouseAnswer {
  groups: Set<GroupId>
  /** The operator's own words for this house when they don't settle it */
  doubt: string[]
}

/** Groups of one house on a street, and what leaves it open. Exported for tests. */
export function uzHouseGroups(st: StreetEntry, house: string): HouseAnswer {
  const key = uzHouseKey(house)
  const groups = new Set(st.whole)
  const doubt: string[] = []
  if (/^(?:б\/н|безномера|без номера)?$/.test(key)) {
    for (const g of st.unnumbered) groups.add(g)
    return { groups, doubt }
  }
  for (const g of st.houses.get(key)?.groups ?? []) groups.add(g)
  // a run covers the lettered houses of its numbers too: "36а" in "34-40"
  const m = new RegExp(`^(\\d+)[${LETTER}]?$`, 'iu').exec(key)
  const n = m ? Number(m[1]) : null
  if (n !== null)
    for (const r of st.ranges) {
      if (n < r.from || n > r.to) continue
      const odd = n % 2 === 1
      if (
        r.parity === 'all' ||
        (r.parity === 'odd' ? odd : r.parity === 'even' ? !odd : n % 2 === r.from % 2)
      )
        groups.add(r.group)
      else if (r.parity === 'same') doubt.push(r.text)
    }
  // "5 1": 5 and 1, or 5/1? Either way the number asked for is in it
  for (const u of st.unclear) {
    const parts = uzHouseKey(u.text).split(/[\s/-]+/)
    if (
      parts.length > 1 &&
      parts.every((p) => /^\d/.test(p)) &&
      (parts.includes(key) || parts.join('') === key)
    )
      doubt.push(u.text)
  }
  return { groups, doubt }
}

/** The address search chain over a page's directory; `load` returns it (null: no section). */
export function uzAddressSearch(
  region: RegionId,
  operator: string,
  load: (ctx: ProviderContext) => Promise<UzDirectory | null>,
) {
  type Ctx = ProviderContext
  const directory = async (ctx: Ctx) => {
    const dir = await load(ctx)
    if (!dir?.cities.size)
      throw new OutageError('unsupported', `${operator}: the page lists no addresses for this region`, {
        region,
      })
    return dir
  }
  const streetEntry = async (ctx: Ctx, street: Street) => {
    const entry = (await directory(ctx)).cities.get(street.cityId ?? '')?.streets.get(street.id)
    if (!entry) throw new OutageError('not-found', `${operator}: unknown street ${street.name}`, { region })
    return entry
  }
  const house = (street: Street, number: string): House => ({
    id: `${street.id}#${uzHouseKey(number)}`,
    number,
    streetId: street.id,
  })
  const undecided = (st: StreetEntry, number: string, doubt: string[]) =>
    new OutageError(
      'not-found',
      doubt.length
        ? `${operator} lists ${st.street.name} as "${doubt.join('", "')}", which doesn't say whether ${number} is included`
        : `${number}, ${st.street.name}: not in the operator's list`,
      { region },
    )

  return {
    async searchCities(ctx: Ctx): Promise<City[]> {
      return [...(await directory(ctx)).cities.values()].map((c) => c.city)
    },

    async searchStreets(ctx: Ctx, _query: string, city?: City): Promise<Street[]> {
      if (!city) throw new OutageError('not-found', `${operator}: pick a city first`, { region })
      const entry = (await directory(ctx)).cities.get(city.id)
      if (!entry) throw new OutageError('not-found', `${operator}: unknown city ${city.name}`, { region })
      return [...entry.streets.values()].map((s) => s.street)
    },

    async searchHouses(ctx: Ctx, street: Street, query?: string): Promise<House[]> {
      const st = await streetEntry(ctx, street)
      const out = [...st.houses.values()].map((h) => house(street, h.number))
      if (st.unnumbered.size) out.push(house(street, NO_NUMBER))
      // listed as written, for a picker: "123 км", "ФОП …"
      for (const u of new Set(st.unclear.map((u) => u.text))) out.push(house(street, u))
      if (!query?.trim()) return out
      const key = uzHouseKey(query)
      const { groups, doubt } = uzHouseGroups(st, query)
      if (!groups.size && doubt.length) throw undecided(st, query.trim(), doubt)
      // the client compares numbers with every separator dropped, where "1/5" is "15" and
      // "5 1" is "51": only the entry that really is this house may answer for it
      const want = normalizeHouse(query)
      const safe = out.filter((h) => normalizeHouse(h.number) !== want || uzHouseKey(h.number) === key)
      // inside a run or on a street listed whole: not in the list, but known
      if (groups.size && !safe.some((h) => uzHouseKey(h.number) === key))
        safe.unshift(house(street, query.trim()))
      return safe
    },

    async groupOf(ctx: Ctx, h: House, street: Street, city?: City): Promise<GroupMatch> {
      const st = await streetEntry(ctx, street)
      const { groups, doubt } = uzHouseGroups(st, h.number)
      if (!groups.size) throw undecided(st, h.number, doubt)
      const [group, ...other] = [...groups].sort(compareGroups)
      return {
        region,
        group: group!,
        ...(other.length ? { otherGroups: other } : {}),
        address: { city: city?.name, street: st.street.name, house: h.number },
      }
    },
  }
}
