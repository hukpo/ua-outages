import { OutageError } from '../errors.js'
import { fuzzyScore, rankByName, sameStreet } from '../fuzzy.js'
import { openPdf, type PdfDocument, type PdfRect } from '../pdf/text.js'
import { compareGroups } from '../schedule.js'
import { normalizeSettlement, normalizeText } from '../text.js'
import type { AddressQuery, City, GroupId, GroupMatch, House, RegionId, Street } from '../types.js'
import { SharedTask } from '../util.js'
import type { ProviderContext } from './provider.js'

/**
 * Rivneoblenergo's address lists: two PDFs linked from the outage page, exported from Excel.
 * "Дізнатися чергу відключень у м. Рівне" is a table of row number, streets and houses, group
 * ("2,1"); "… у Рівненській області" is community, settlements, streets and houses, group.
 *
 * The cells are prose, written by many hands: "вул.Соборна 5а", "Пересопницька 167-195
 * (непарні)", "вул.Замкова (частково)", "Київська від поліції до виїзду на Звягель", shops and
 * factories by name, "с.Яполоть школа,тракторна бригада". So this is a reading of a free-text
 * list, and it answers only what the text settles:
 * - a house the list names, or one inside a range whose side is clear ("167-195 (непарні)",
 *   "1-34"; in "42-64" only the even numbers);
 * - a street, or a whole settlement ("повністю"), listed without houses in one group, when no
 *   row of another group mentions that street in a way that wasn't understood.
 * Everything else is `not-found` naming the groups it could be and the operator's own words:
 * never the likeliest one. A row whose settlements and streets can't be paired with certainty
 * (several villages, one unmarked list) is kept only as such a candidate.
 *
 * Settlement names repeat across communities, so a settlement is keyed by its community
 * (`City.district`).
 */
export const RIVNE_ADDRESS_PAGE = 'https://www.roe.vsei.ua/disconnections'
/** The files were last replaced in October 2026; a refresh costs the page and two conditional requests */
const DIRECTORY_TTL_MS = 6 * 3600_000
const RETRY_AFTER_FAILURE_MS = 15 * 60_000
/** A range longer than this is a typo, not a street */
const MAX_RANGE = 400
const CITY_NAME = 'Рівне'
/** Same thresholds as the client's own picking of a name */
const CONFIDENT = 0.7
const TIE = 0.025

// --- model ---

interface Range {
  from: number
  to: number
  /** "(парні)" / "(непарні)"; null when the list doesn't say */
  parity: 0 | 1 | null
  /** "17-43 (частково)", "2-66 (приватний сектор)": something inside it, not all of it */
  loose: boolean
}

/** A street (or a shop, a factory: the list doesn't tell them apart) as one row names it */
export interface RivneMention {
  /** "вул. Соборна", "пров. Робітничий", "Ліцей №3" */
  name: string
  key: string
  /** house key → as written */
  houses: Map<string, string>
  ranges: Range[]
  /** "частково", a note in brackets, or words after the name that aren't house numbers */
  partial: boolean
}

export interface RivneRow {
  group: GroupId
  /**
   * - `whole`: the settlement is in this group whole ("повністю");
   * - `streets`: `mentions` are what the row lists for the settlement;
   * - `unknown`: the row names the settlement, but its text can't be assigned with certainty.
   */
  kind: 'whole' | 'streets' | 'unknown'
  /** The operator's words for this settlement in this row */
  text: string
  mentions: RivneMention[]
  /** The cell's text runs past its box in the PDF: lines are missing */
  cut: boolean
}

interface Place {
  city: City
  rows: RivneRow[]
  /** key → display name (the longest spelling seen) */
  streets: Map<string, string>
}

export interface RivneDirectory {
  places: Map<string, Place>
  stats: RivneStats
}

/** How much of the two files was read with certainty */
export interface RivneStats {
  /** Table rows, both files */
  rows: number
  /** "повністю": every settlement of the row is in the group whole */
  whole: number
  /** One settlement, or each settlement's list marked in the text */
  streets: number
  /** Kept only as candidates */
  unknown: number
  /** No settlement named (an enterprise): nothing to look up */
  skipped: number
  /** Street mentions, and how many of them are partial */
  mentions: number
  partial: number
}

export interface RivneAddressSource {
  /** The two files: the city of Rivne and the rest of the oblast */
  files: { url: string; modified: string | null }[]
}

// --- provider part ---

/**
 * The address part of the Rivne provider: spread it into the provider object. `lookupAddress`
 * makes `findGroup` explain itself with the operator's words; the search chain is for
 * autocomplete. `addressSource` isn't part of `Provider`.
 */
export function rivneAddresses(region: RegionId, operator: string) {
  type Loaded = {
    dir: RivneDirectory
    files: { url: string; lastModified: string | null; rows: TableRow[] }[]
  }
  let task: SharedTask<Loaded> | null = null
  let taskAt = 0
  let last: Loaded | null = null

  const load = async (ctx: ProviderContext): Promise<Loaded> => {
    try {
      const html = await ctx.http.text(RIVNE_ADDRESS_PAGE, { region })
      const links = parseRivneLinks(html)
      if (!links)
        throw new OutageError('parse', `${operator}: the address list links are not on the page`, {
          region,
          url: RIVNE_ADDRESS_PAGE,
        })
      const files: Loaded['files'] = []
      // one after the other: two files a few times a day don't need to race
      for (const [i, url] of [links.city, links.oblast].entries()) {
        const known = last?.files[i]?.url === url ? last.files[i] : undefined
        const file = await ctx.http.file(url, {
          region,
          ...(known?.lastModified
            ? { headers: { 'If-Modified-Since': known.lastModified }, acceptStatus: [304] }
            : {}),
        })
        if (known && !file.bytes.length) {
          files.push(known)
          continue
        }
        try {
          const rows = tableRows(openPdf(file.bytes), i === 0 ? CITY_HEADER : OBLAST_HEADER)
          files.push({ url, lastModified: file.headers.get('last-modified'), rows })
        } catch (cause) {
          if (!(cause instanceof OutageError) || cause.code !== 'parse') throw cause
          throw new OutageError('parse', `${operator} address list: ${cause.message}`, { region, url, cause })
        }
      }
      return (last = { dir: buildRivneDirectory(files[0]!.rows, files[1]!.rows), files })
    } catch (e) {
      // the lists change a few times a year: an unreachable site is no reason to stop answering
      if (!last || ctx.signal?.aborted) throw e
      taskAt = Date.now() - DIRECTORY_TTL_MS + RETRY_AFTER_FAILURE_MS
      return last
    }
  }

  const loaded = (ctx: ProviderContext) => {
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
  const directory = async (ctx: ProviderContext) => (await loaded(ctx)).dir

  const notFound = (message: string) => new OutageError('not-found', message, { region })

  const placeOf = async (ctx: ProviderContext, cityId: string | undefined) => {
    const place = (await directory(ctx)).places.get(cityId ?? '')
    if (!place) throw notFound(`${operator}: unknown settlement`)
    return place
  }

  /** The answer for a street and house of a settlement, or `not-found` with what the list does say */
  const answer = (place: Place, street: { key: string; name: string }, house: string): GroupMatch => {
    const d = decideRivne(place.rows, street.key, houseKey(house))
    const where = `${house.trim()}, ${street.name}, ${place.city.name}`
    if (!d.groups) {
      if (!d.candidates.length) throw notFound(`${where}: not in ${operator}'s lists`)
      throw notFound(
        `${where}: ${operator}'s list doesn't settle it. Could be ${d.candidates
          .map((c) => `${c.group} (${c.why}: "${clip(c.text)}")`)
          .join('; ')}`,
      )
    }
    const [group, ...other] = d.groups
    return {
      region,
      group: group!,
      ...(other.length ? { otherGroups: other } : {}),
      address: { city: place.city.name, street: street.name, house: d.house ?? house.trim() },
    }
  }

  return {
    /** Row 15 of the city list is exactly "вул.Соборна 5а | 2,1" */
    sampleAddress: { city: 'Рівне', street: 'Соборна', house: '5а' } satisfies AddressQuery,

    async searchCities(ctx: ProviderContext): Promise<City[]> {
      return [...(await directory(ctx)).places.values()].map((p) => p.city)
    },

    async searchStreets(ctx: ProviderContext, query: string, city?: City): Promise<Street[]> {
      const place = await placeOf(ctx, city?.id)
      const streets = [...place.streets].map(([key, name]) => ({
        id: `${place.city.id}|${key}`,
        name,
        cityId: place.city.id,
      }))
      // a settlement listed whole has no streets to pick from: what was typed stands for itself
      const typed = query.trim() && mentionKey(query)
      if (typed && !streets.length)
        streets.push({ id: `${place.city.id}|${typed}`, name: query.trim(), cityId: place.city.id })
      return streets
    },

    async searchHouses(ctx: ProviderContext, street: Street, query?: string): Promise<House[]> {
      const place = await placeOf(ctx, street.cityId)
      const key = street.id.slice(place.city.id.length + 1)
      const houses = new Map<string, string>()
      for (const row of place.rows)
        for (const m of row.mentions) if (m.key === key) for (const [k, n] of m.houses) houses.set(k, n)
      // a number inside a range or on a street listed whole isn't in any list: `groupOf` decides
      const typed = query?.trim() ? houseKey(query) : ''
      if (typed && !houses.has(typed)) houses.set(typed, query!.trim())
      return [...houses].map(([k, number]) => ({ id: `${street.id}#${k}`, number, streetId: street.id }))
    },

    async groupOf(ctx: ProviderContext, house: House, street: Street, city?: City): Promise<GroupMatch> {
      const place = await placeOf(ctx, street.cityId ?? city?.id)
      return answer(
        place,
        { key: street.id.slice(place.city.id.length + 1), name: street.name },
        house.number,
      )
    },

    async lookupAddress(ctx: ProviderContext, address: AddressQuery): Promise<GroupMatch> {
      const dir = await directory(ctx)
      if (!address.city) throw notFound(`${operator}: specify a city or village`)
      if (!address.house.trim()) throw notFound(`${operator}: specify a house number`)
      const district = address.district
      const cities = rankByName(
        address.city,
        [...dir.places.values()],
        (p) => p.city.name,
        'settlement',
      ).filter(
        (r) =>
          !district ||
          !r.item.city.district ||
          fuzzyScore(district, r.item.city.district, 'settlement') >= 0.6,
      )
      const place = pick(cities, address.city, 'settlement', (p) =>
        p.city.district ? `${p.city.name} (${p.city.district})` : p.city.name,
      )
      const typed = { key: mentionKey(address.street), name: address.street.trim() }
      const listed = [...place.streets].map(([key, name]) => ({ key, name }))
      const ranked = rankByName(address.street, listed, (s) => s.name, 'street')
      // not a listed street at all: only a settlement listed whole can answer
      if (!ranked.length) return answer(place, typed, address.house)
      const same = ranked.find((r) => r.item.key === typed.key)
      if (same) return answer(place, same.item, address.house)
      // "вул. Миру" is not "просп. Миру", nor "2-й провулок Миру" plain "Миру"
      const fitting = ranked.filter((r) => sameStreet(address.street, r.item.name))
      if (!fitting.length)
        throw notFound(
          `${operator}: no street "${address.street}" in ${place.city.name}. Did you mean: ${ranked
            .slice(0, 5)
            .map((r) => r.item.name)
            .join(', ')}?`,
        )
      return answer(
        place,
        pick(fitting, address.street, 'street', (s) => s.name),
        address.house,
      )
    },

    /** Which files the answers come from and when the operator last replaced them. Not a `Provider` method. */
    async addressSource(ctx: ProviderContext): Promise<RivneAddressSource> {
      return {
        files: (await loaded(ctx)).files.map((f) => {
          const stamp = Date.parse(f.lastModified ?? '')
          return { url: f.url, modified: Number.isNaN(stamp) ? null : new Date(stamp).toISOString() }
        }),
      }
    },
  }

  function pick<T>(
    ranked: { item: T; score: number }[],
    query: string,
    label: string,
    describe: (t: T) => string,
  ): T {
    const [top, second] = ranked
    const list = (items: typeof ranked) =>
      items
        .slice(0, 6)
        .map((r) => describe(r.item))
        .join('; ')
    if (!top) throw notFound(`No ${label} matches "${query}" in ${operator}'s lists`)
    if (top.score < CONFIDENT)
      throw notFound(`No ${label} matches "${query}" well. Did you mean: ${list(ranked)}?`)
    if (second && second.score >= top.score - TIE)
      throw notFound(
        `"${query}" matches several: ${list(ranked.filter((r) => r.score >= top.score - 0.1))}. Be more specific${label === 'settlement' ? ' or pass a district' : ''}.`,
      )
    return top.item
  }
}

const clip = (s: string) => (s.length > 140 ? `${s.slice(0, 137).trimEnd()}…` : s)

/** The two PDF links, by their button text (the file names change on re-upload). Exported for tests. */
export function parseRivneLinks(html: string): { city: string; oblast: string } | null {
  let city: string | undefined
  let oblast: string | undefined
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = m[2]!.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
    if (!/чергу\s+відключень/iu.test(label)) continue
    const url = new URL(m[1]!.replace(/&amp;/g, '&'), RIVNE_ADDRESS_PAGE).toString()
    if (/област/iu.test(label)) oblast ??= url
    else if (/Рівне/u.test(label)) city ??= url
  }
  return city && oblast ? { city, oblast } : null
}

// --- tables ---

export interface TableRow {
  /** One string per column; the lines of a cell joined as printed */
  cells: string[]
  /** A line of some cell lies outside the cell's box: the cell holds more than the PDF shows */
  cut: boolean
}

const CITY_HEADER = [/№/, /Назви вулиць/, /підчерга/]
const OBLAST_HEADER = [/громади/, /населених пунктів/, /Назви вулиць/, /Черга/]
/** Page furniture outside the table */
const FURNITURE = /^(ст\.\s*\d+\s*з\s*\d+|Графік погодинного відключення.*)$/u

/**
 * The rows of an Excel table printed to PDF. Excel clips every cell to its box, and a box spans
 * the row's height, so the clip rectangles are the row grid: a row is a smallest box (by its
 * vertical extent), a column starts where the boxes narrower than the table start. A line is
 * joined to the next without a space: Excel wraps in the middle of a word, and keeps the space
 * when it wraps after one. Header rows (repeated on each page) are dropped; `header` must match
 * one, column by column. Exported for tests.
 */
export function tableRows(doc: PdfDocument, header: RegExp[]): TableRow[] {
  const pages = Array.from({ length: doc.pageCount }, (_, i) => doc.page(i))
  const sameBand = (a: PdfRect, b: PdfRect) => Math.abs(a.y - b.y) < 0.3 && Math.abs(a.h - b.h) < 0.3
  const inside = (a: PdfRect, b: PdfRect) => a.y >= b.y - 0.3 && a.y + a.h <= b.y + b.h + 0.3

  const perPage = pages.map((page) => {
    const boxes: PdfRect[] = []
    for (const r of page.runs) if (r.clip && !boxes.some((b) => sameBand(b, r.clip!))) boxes.push(r.clip)
    // the page and the table are clips too: they contain rows, a row contains nothing
    const bands = boxes.filter((b) => !boxes.some((o) => o !== b && !sameBand(o, b) && inside(o, b)))
    return { page, bands: bands.sort((a, b) => b.y - a.y) }
  })

  // column starts: the left and right edges of the cell boxes, but for the table's right edge
  const edges: number[] = []
  for (const { page, bands } of perPage)
    for (const r of page.runs)
      if (r.clip && bands.some((b) => sameBand(b, r.clip!))) edges.push(r.clip.x, r.clip.x + r.clip.w)
  const right = Math.max(...edges)
  const starts: number[] = []
  for (const e of [...new Set(edges.map((e) => Math.round(e * 10) / 10))].sort((a, b) => a - b))
    if (right - e > 3 && (!starts.length || e - starts.at(-1)! > 3)) starts.push(e)
  if (starts.length !== header.length)
    throw new OutageError('parse', `${starts.length} table columns, expected ${header.length}`)

  const rows: TableRow[] = []
  let headers = 0
  perPage.forEach(({ page, bands }, pageNo) => {
    const cells = bands.map(() => starts.map(() => [] as { x: number; y: number; text: string }[]))
    const cut = bands.map(() => false)
    for (const r of page.runs) {
      if (r.text.includes('�')) throw new OutageError('parse', `page ${pageNo + 1}: unreadable characters`)
      // a cell's own box says which row it is, even for a line pushed out of it
      let i = r.clip ? bands.findIndex((b) => sameBand(b, r.clip!)) : -1
      if (i === -1) i = bands.findIndex((b) => r.y >= b.y - 0.5 && r.y <= b.y + b.h + 0.5)
      else if (r.y < bands[i]!.y - 0.5 || r.y > bands[i]!.y + bands[i]!.h + 0.5) cut[i] = true
      if (i === -1) {
        if (FURNITURE.test(r.text.trim()) || !r.text.trim()) continue
        throw new OutageError('parse', `page ${pageNo + 1}: text outside the table: "${r.text.slice(0, 40)}"`)
      }
      let col = 0
      for (let c = 0; c < starts.length; c++) if (r.x >= starts[c]! - 1) col = c
      cells[i]![col]!.push({ x: r.x, y: r.y, text: r.text })
    }
    bands.forEach((_, i) => {
      const text = cells[i]!.map((runs) =>
        runs
          .sort((a, b) => b.y - a.y || a.x - b.x)
          .map((r) => r.text)
          .join(''),
      )
      if (text.every((t) => !t.trim())) return
      if (header.every((re, c) => re.test(text[c]!))) return void headers++
      rows.push({ cells: text.map((t) => t.replace(/\s+/g, ' ').trim()), cut: cut[i]! })
    })
  })
  if (!headers) throw new OutageError('parse', 'the table header is not what it was')
  if (!rows.length) throw new OutageError('parse', 'no rows under the table header')
  return rows
}

// --- reading the cells ---

const groupOfCell = (cell: string): GroupId => {
  const m = /^([1-9])\s*[.,]\s*([1-9])$/.exec(cell.trim())
  if (!m) throw new OutageError('parse', `"${cell}" is not a group`)
  return `${m[1]}.${m[2]}`
}

/** Both tables → settlements and what each row says about them. Exported for tests. */
export function buildRivneDirectory(city: readonly TableRow[], oblast: readonly TableRow[]): RivneDirectory {
  const stats: RivneStats = { rows: 0, whole: 0, streets: 0, unknown: 0, skipped: 0, mentions: 0, partial: 0 }
  const count = (rows: RivneRow[]) => {
    for (const r of rows) for (const m of r.mentions) (stats.mentions++, m.partial && stats.partial++)
  }
  const places = new Map<string, Place>()
  const place = (id: string, name: string, district?: string) => {
    let p = places.get(id)
    if (!p)
      places.set(
        id,
        (p = { city: { id, name, ...(district ? { district } : {}) }, rows: [], streets: new Map() }),
      )
    return p
  }
  const add = (p: Place, row: RivneRow) => {
    p.rows.push(row)
    for (const m of row.mentions) {
      const known = p.streets.get(m.key)
      if (!known || m.name.length > known.length) p.streets.set(m.key, m.name)
    }
  }

  const rivne = place('rivne', CITY_NAME)
  for (const r of city) {
    stats.rows++
    const group = groupOfCell(r.cells[2]!)
    const text = r.cells[1]!
    const row: RivneRow = { group, kind: 'streets', text, mentions: parseStreetList(text), cut: r.cut }
    stats.streets++
    count([row])
    add(rivne, row)
  }

  // settlement → rows; the same name in unrelated communities is another settlement
  const named = new Map<string, { name: string; communities: Set<string>; rows: RivneRow[] }[]>()
  for (const r of oblast) {
    stats.rows++
    const group = groupOfCell(r.cells[3]!)
    const communities = r.cells[0]!.split(/\s*,\s*|\s+(?=\p{Lu})/u)
      .map((c) => c.trim())
      .filter(Boolean)
    const read = readOblastRow(r.cells[1]!, r.cells[2]!)
    if (!read.length) {
      stats.skipped++
      continue
    }
    const kinds = new Set(read.map((s) => s.kind))
    stats[kinds.has('unknown') ? 'unknown' : kinds.has('streets') ? 'streets' : 'whole']++
    for (const s of read) {
      const row: RivneRow = { group, kind: s.kind, text: s.text, mentions: s.mentions, cut: r.cut }
      count([row])
      const key = normalizeSettlement(s.name)
      const clusters = named.get(key) ?? []
      named.set(key, clusters)
      const linked = clusters.filter((c) => communities.some((x) => c.communities.has(x)))
      const into = linked[0] ?? { name: s.name, communities: new Set<string>(), rows: [] }
      if (!linked.length) clusters.push(into)
      // a row filed under two communities joins what was two clusters
      for (const other of linked.slice(1)) {
        for (const x of other.communities) into.communities.add(x)
        into.rows.push(...other.rows)
        clusters.splice(clusters.indexOf(other), 1)
      }
      for (const x of communities) into.communities.add(x)
      into.rows.push(row)
    }
  }
  for (const [key, clusters] of named)
    for (const c of clusters) {
      const district = [...c.communities].sort((a, b) => a.localeCompare(b, 'uk')).join(', ')
      const p = place(`${key}|${normalizeText(district)}`, c.name, `${district} громада`)
      for (const row of c.rows) add(p, row)
    }
  return { places, stats }
}

const MARKER = String.raw`(?:смт|с-ще|селище|[смхСМХ])`
/** "с.Ганнівка", "смт Млинів", "м. Дубно", "х.Юрково": a settlement named with its kind */
const SETTLEMENT = new RegExp(
  String.raw`(?<![\p{L}\d.])${MARKER}(?:\.\s*|\s+)(\p{Lu}[\p{L}'’ʼ\x60-]*(?:\.\s?\p{Lu}[\p{L}'’ʼ\x60-]*)?(?:\s\p{Lu}[\p{L}'’ʼ\x60-]+)?)`,
  'gu',
)
const WHOLE = /^[\s\-–—:,.()]*(?:населені пункти\s+)?повністю[\s.,)]*$/iu

interface SettlementRead {
  name: string
  kind: RivneRow['kind']
  text: string
  mentions: RivneMention[]
}

/**
 * One row of the oblast table: the settlements of its second cell, each with what the third
 * cell says about it. Certain only when the text is "повністю", when the row has one
 * settlement, or when every list is introduced by its settlement ("с.Хотинь вул.… с.Балашівка
 * вул.…"). Exported for tests.
 */
export function readOblastRow(settlementCell: string, text: string): SettlementRead[] {
  const settlements = parseSettlements(settlementCell)
  if (!settlements.length) return []
  const unknown = (): SettlementRead[] =>
    settlements.map((s) => ({ name: s.name, kind: 'unknown', text, mentions: [] }))
  const whole = (name: string, said: string): SettlementRead => ({
    name,
    kind: 'whole',
    text: said,
    mentions: [],
  })
  if (WHOLE.test(text)) return settlements.map((s) => whole(s.name, text))
  const keyOf = (name: string) => normalizeSettlement(name)

  // where each settlement's part of the text starts
  const marks: { key: string; at: number; end: number }[] = []
  for (const m of text.matchAll(SETTLEMENT)) {
    const words = m[1]!.split(/\s/)
    // "с.Старе Село вул.…" is two words, "с.Хотинь Кузнєцова" one
    const hit = [m[1]!, words[0]!].find((n) => settlements.some((s) => s.key === keyOf(n)))
    // a settlement the row doesn't name: its list could be anyone's
    if (!hit) return unknown()
    marks.push({ key: keyOf(hit), at: m.index, end: m.index + m[0].length - (m[1]!.length - hit.length) })
  }

  if (settlements.length === 1) {
    const only = settlements[0]!
    if (only.whole) return [whole(only.name, settlementCell)]
    if (marks.some((m) => m.key !== only.key)) return unknown()
    // "с.Тишиця (вул.Молодіжна,…)", "смт.Володимирець вул. Винниченка, …": its own name leads the list
    let body = text
    if (marks.length === 1 && !text.slice(0, marks[0]!.at).trim()) body = text.slice(marks[0]!.end)
    else if (marks.length) return unknown()
    return [{ name: only.name, kind: 'streets', text, mentions: parseStreetList(unwrap(body)) }]
  }

  if (!marks.length || text.slice(0, marks[0]!.at).replace(/[\s,.;:(]/g, '')) {
    // no list is marked: only "(повністю)" in the settlement cell says anything certain
    return settlements.map((s) =>
      s.whole ? whole(s.name, settlementCell) : { name: s.name, kind: 'unknown', text, mentions: [] },
    )
  }
  const out = new Map<string, SettlementRead>()
  let sharing: string[] = []
  for (const [i, mark] of marks.entries()) {
    const body = text.slice(mark.end, marks[i + 1]?.at ?? text.length)
    const name = settlements.find((s) => s.key === mark.key)!.name
    if (out.has(mark.key)) return unknown()
    // "с. Пустомити, с.Люцинів, с. Жалянка -- повністю": one statement for several
    if (!body.replace(/[\s,;.]/g, '') && i < marks.length - 1) {
      sharing.push(name)
      continue
    }
    if (WHOLE.test(body)) {
      for (const n of [...sharing, name]) out.set(keyOf(n), whole(n, `${n} ${body.trim()}`))
    } else {
      // a list shared by several settlements doesn't say which street is where
      if (sharing.length) return unknown()
      const mentions = parseStreetList(unwrap(body))
      // "Зозів: І. Франка, …" inside another settlement's list: a scope without its marker
      if (
        mentions.some((m) =>
          settlements.some((s) => s.key !== mark.key && s.key === keyOf(m.name.replace(/[:.]+$/, ''))),
        )
      )
        return unknown()
      // "с.Яцковичі повністю" in the settlement cell and a list of its streets here: the row
      // still says the whole village is in this group, and the list goes with it
      const said = settlements.find((s) => s.key === mark.key)!.whole
      out.set(mark.key, {
        name,
        kind: said ? 'whole' : 'streets',
        text: said ? `${settlementCell} | ${name}: ${body.trim()}` : `${name}: ${body.trim()}`,
        mentions,
      })
    }
    sharing = []
  }
  for (const s of settlements) {
    if (out.has(s.key)) continue
    out.set(
      s.key,
      s.whole ? whole(s.name, settlementCell) : { name: s.name, kind: 'unknown', text, mentions: [] },
    )
  }
  return [...out.values()]
}

/** "(вул.A, B)" / ": вул.A" / "- A, B" → the list itself */
function unwrap(body: string): string {
  let s = body.trim().replace(/^[\s:,\-–—]+/, '')
  if (s.startsWith('(')) {
    const close = s.lastIndexOf(')')
    s = close > 0 && !/[^\s.,;]/.test(s.slice(close + 1)) ? s.slice(1, close) : s.slice(1)
  }
  return s
}

/** "с.Богуші (повністю), с.Тишиця (частково)" → names and whether the cell says "повністю" */
function parseSettlements(cell: string): { name: string; key: string; whole: boolean }[] {
  const out: { name: string; key: string; whole: boolean }[] = []
  for (const piece of cell.split(
    new RegExp(String.raw`[,;]|\s+(?=${MARKER}\.?\s*\p{Lu})|(?<=\))\s*(?=\p{Lu})`, 'u'),
  )) {
    const whole = /повністю/iu.test(piece)
    const name = piece
      .replace(/\(?\s*(?:частково|повністю)\s*\)?/giu, ' ')
      .replace(new RegExp(String.raw`^\s*${MARKER}(?:\.\s*|\s+)(?=\p{Lu})`, 'u'), '')
      .replace(/[\s.()]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    // a name is a few capitalised words; "дачі м.Вараш", "виправна колонія", "ТП-370" are not
    if (!/^\p{Lu}[\p{L}'’ʼ`.-]*(?:\s(?:та|і|\p{Lu}[\p{L}'’ʼ`-]*)){0,4}$/u.test(name)) continue
    const key = normalizeSettlement(name)
    if (key && !out.some((s) => s.key === key)) out.push({ name, key, whole })
  }
  return out
}

// --- street lists ---

const TYPES: [RegExp, string, string][] = [
  [/^(?:вулиця|вул)(?![\p{L}])[.:,]*\s*/iu, 'вул', 'вул.'],
  [/^(?:провулок|провул|пров|п-лок|п-к)(?![\p{L}])[.:]*\s*/iu, 'пров', 'пров.'],
  [/^(?:проспект|просп|пр-т|п-т)(?![\p{L}])[.:]*\s*/iu, 'просп', 'просп.'],
  [/^(?:бульвар|бульв|бул)(?![\p{L}])[.:]*\s*/iu, 'бул', 'бульв.'],
  [/^(?:площа|пл)(?![\p{L}])[.:]*\s*/iu, 'пл', 'пл.'],
  [/^(?:майдан|м-н)(?![\p{L}])[.:]*\s*/iu, 'майдан', 'майдан'],
]
/** Words before a dot that don't end a sentence */
const ABBREVIATIONS = /^(?:вул|пров|провул|просп|бульв|площ|буд|корп|діл|мас|смт|тощо)$/iu
const MONTHS =
  /^(?:січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)$/iu

/**
 * A cell's list → what it names. Items are separated by commas and semicolons, and by a full
 * stop after a number or a whole word ("93. вул.Бухала", "Плаза. вул.16 Липня"; not after an
 * initial or an abbreviation). An item that starts with a letter names a street, with its first
 * house if one follows; items that are numbers or ranges belong to the street before them.
 * Whatever isn't a name followed by house numbers makes the mention `partial`.
 *
 * Numbers are credited to a street only while it is certain which one they follow. A number
 * glued to the next name ("1,2Івана Огієнка 26": a line break in the cell; "23авул.Данила
 * Галицького 10") ends the street before it, and an item that starts like a number but reads as
 * neither a house nor a range ends it too: the numbers after it are nobody's. Streets listed
 * after another settlement's name ("с. Тинне, вул. Лугова 5, 7" in the city's list) keep no
 * houses at all: those are the village's. Exported for tests.
 */
export function parseStreetList(text: string): RivneMention[] {
  const out: RivneMention[] = []
  let current: RivneMention | null = null
  /** "с. Тинне, вул. Січових Стрільців, …" in the city's list: those streets are the village's */
  let foreign = false
  const start = (item: string): RivneMention | null => {
    // "вул.Пересопницька частково", "Дорошенка-частково"
    const part = /[\s\-–—(]+частково\)?[\s.]*$/iu.exec(item)
    let name = part ? item.slice(0, part.index) : item
    let type = 'вул'
    let label = ''
    for (const [re, canon, shown] of TYPES)
      if (re.test(name)) {
        name = name.replace(re, '')
        type = canon
        label = shown
        break
      }
    // "пр." is a провулок before an adjective ("пр.Бригадний"), a проспект otherwise ("пр. Миру")
    const pr = /^пр\.\s*(?=\p{Lu})/u.exec(name)
    if (pr) {
      name = name.slice(pr[0].length)
      ;[type, label] = /(?:ий|ій)$/u.test(name.split(/\s/)[0]!) ? ['пров', 'пров.'] : ['просп', 'просп.']
    }
    name = name.replace(/[\s\-–—:.]+$/, '').trim()
    // "вул, Пересопницька 150": the type alone, cut off by a stray comma
    if (!/[\p{L}\d]/u.test(name)) return null
    const m: RivneMention = {
      name: label ? `${label} ${name}` : name,
      key: `${type}|${nameKey(name)}`,
      houses: new Map(),
      ranges: [],
      partial: foreign || !!part,
    }
    // the same street twice in one cell is one mention
    const known = out.find((o) => o.key === m.key)
    if (known) {
      known.partial ||= !!part
      return known
    }
    out.push(m)
    return m
  }
  /** false: `raw` isn't a house, a range or a note about the street */
  const spec = (m: RivneMention, raw: string): boolean => {
    // another settlement's street: its houses aren't this settlement's
    if (foreign) return ((m.partial = true), true)
    let s = raw.trim()
    if (!s) return true
    let note = false
    let parity: 0 | 1 | null = null
    s = s
      .replace(
        /\(([^()]*)\)?|\b(непарні|парні)\b/giu,
        (_, inner: string | undefined, bare: string | undefined) => {
          const word = (bare ?? inner ?? '').trim().toLowerCase()
          if (word === 'парні') parity = 0
          else if (word === 'непарні') parity = 1
          else note = true
          return ' '
        },
      )
      .replace(/^(?:буд(?:инок)?\.?\s*)?№?\s*/iu, '')
      .trim()
    if (/частково/iu.test(raw)) m.partial = true
    if (!s) return ((m.partial ||= note), true)
    const range = /^(\d+)\s*([а-яіїєґa-z])?\s*[-–—]\s*(\d+)\s*([а-яіїєґa-z])?$/iu.exec(s)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[3])
      if (to < from || to - from > MAX_RANGE) return ((m.partial = true), true)
      m.ranges.push({ from, to, parity, loose: note })
      // "46 -52а": the lettered end is named outright
      for (const [n, l] of [
        [range[1], range[2]],
        [range[3], range[4]],
      ] as const)
        if (l && !note) m.houses.set(houseKey(n + l), `${n}${l}`)
      return true
    }
    const one = /^(\d+)\s*-?\s*([а-яіїєґa-z])?(?:\s*\/\s*(\d+|[а-яіїєґa-z])\s*([а-яіїєґa-z])?)?$/iu.exec(s)
    if (!one || parity !== null) {
      m.partial = true
      // words that aren't a note ("1-ого Грудня 1-25", "34 Березнева 40") may name another street
      return !!one || !/\p{L}{3}/u.test(s)
    }
    const number = `${one[1]}${one[2] ?? ''}${one[3] ? `/${one[3]}${one[4] ?? ''}` : ''}`
    m.houses.set(houseKey(number), number)
    return true
  }
  /** Houses after a street's name; text that isn't any leaves the numbers after it unassigned */
  const follow = (m: RivneMention | null, raw: string): RivneMention | null => (m && spec(m, raw) ? m : null)

  for (const raw of splitItems(text)) {
    let item = raw.trim().replace(/^["«»“”„]+(?=\s)/, '')
    // "60, (частково) вул.Анатолія Грицая": the note is about the street before, the name is new
    const lead = /^\(\s*частково\s*\)\s*(?=\p{L})/iu.exec(item)
    if (lead) {
      if (current) current.partial = true
      item = item.slice(lead[0].length)
    }
    if (!item) continue
    if (/^\(?\s*частково\s*\)?$/iu.test(item)) {
      if (current) current.partial = true
      continue
    }
    if (/^[\d№(]/.test(item) || /^буд\.?\s*№?\s*\d/iu.test(item)) {
      // "18 вул.Відінська 2": a missing comma
      const glued = /^(\d+\s*[а-яіїєґ]?)\s+((?:вул|пров|просп|провулок|проспект)[.\s].*)$/iu.exec(item)
      // "16 Липня 7", "1 Травня", "8-го Березня": a street named by a date
      const dated = /^(\d+(?:-?го)?\s+(\p{L}+))(.*)$/u.exec(item)
      if (glued) {
        if (current) spec(current, glued[1]!)
        const [name, rest] = cut(glued[2]!)
        current = follow(start(name), rest)
      } else if (dated && MONTHS.test(dated[2]!)) {
        current = follow(start(dated[1]!), dated[3]!)
      } else current = follow(current, item)
      continue
    }
    if (new RegExp(String.raw`^${MARKER}\.\s?\p{Lu}`, 'u').test(item)) foreign = true
    const [name, rest] = cut(item)
    current = follow(start(name), rest)
  }
  return out
}

/** "вул.Млинівська 1 -16" → name and what follows it; "вул.16 Липня 2" keeps its date */
function cut(item: string): [string, string] {
  const m = /^((?:\P{N}*?\d+(?:-?го)?\s+(?=\p{L}{4}))?[^\d(№]*)(.*)$/su.exec(item)!
  let name = m[1]!
  let rest = m[2]!
  // "ЗОШ №23", "Ліцей №3", "ВПУ-22": a number that is part of a name
  if (/^№\s*\d+\s*$/.test(rest) || /[\p{L}]-$/u.test(name)) {
    name = item
    rest = ''
  }
  // "Андріївська буд.1-179"
  const house = /\sбуд\.?\s*$/iu.exec(name)
  if (house) name = name.slice(0, house.index)
  return [name, rest]
}

function splitItems(text: string): string[] {
  const s = text
    .replace(/\s+/g, ' ')
    // a number glued to the name after it: "1,2Івана Огієнка 26" (a line break inside the cell),
    // "23авул.Данила Галицького 10". "1А" and "17вересня" stay as they are
    .replace(/(\d)(?=\p{Lu}\p{Ll}{2})/gu, '$1, ')
    .replace(/(\d[а-яіїєґ]?)(?=(?:вул|пров|просп)\.)/giu, '$1, ')
  const balanced = [...s].reduce((d, c) => (d < 0 ? d : c === '(' ? d + 1 : c === ')' ? d - 1 : d), 0) === 0
  const items: string[] = []
  let depth = 0
  let from = 0
  const push = (to: number, next: number) => {
    items.push(s.slice(from, to))
    from = next
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (balanced && c === '(') depth++
    else if (balanced && c === ')') depth--
    else if (depth) continue
    else if (c === ',' || c === ';') push(i, i + 1)
    else if (c === '.') {
      const before = /(\d\s*[а-яіїєґ]?|[\p{L}'’ʼ]{4,}|[)"»”])$/iu.exec(s.slice(from, i))
      const after = s.slice(i + 1)
      if (!before || !after.trim()) continue
      const word = /^\p{L}/u.test(before[1]!)
      // after a number anything new starts an item; after a word only a spaced capital, a digit or "вул."
      const next = word ? /^(?:\s+[\p{Lu}\d"«]|\s*(?:вул|пров)[.\s])/u : /^\s*[\p{L}\d"«]/u
      if (!next.test(after) || (word && ABBREVIATIONS.test(before[1]!))) continue
      push(i, i + 1)
    }
  }
  items.push(s.slice(from))
  return items
}

/**
 * What makes two spellings one street: "Кн.Володимира" = "Князя Володимира", "С.Бандери" =
 * "Ст.Бандери" = "Степана Бандери", "Л. Українки" = "Лесі Українки": every word but the last
 * counts by its first letter. A bare "Бандери" stays apart: "Перша Першотравнева" and
 * "Першотравнева" are two streets.
 */
function nameKey(name: string): string {
  const words = normalizeText(name)
    .replace(/[«»"“”„]/g, ' ')
    .replace(/\./g, '. ')
    .split(/\s+/)
    .map((w) => w.replace(/\.$/, ''))
    .filter(Boolean)
  return words.map((w, i) => (i < words.length - 1 && !/\d/.test(w) ? w[0]! : w)).join(' ')
}

/** The key of a street as a person types it: "вулиця Степана Бандери", "пров. Робітничий" */
export function mentionKey(typed: string): string {
  return parseStreetList(typed.replace(/[,;()]/g, ' '))[0]?.key ?? `вул|${nameKey(typed)}`
}

/** The word a street is known by: the last one */
const mainWord = (key: string) => key.split('|')[1]!.split(' ').at(-1)!

/** "5а", "5-А", "5 а", "5A" → "5А"; "14/44" stays a fraction */
export function houseKey(s: string): string {
  return s
    .toUpperCase()
    .replace(/[ABCEHIKMOPTX]/g, (c) => LATIN[c]!)
    .replace(/№|БУД(?:ИНОК)?\.?/g, '')
    .replace(/\\/g, '/')
    .replace(/[\s.]/g, '')
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

// --- deciding ---

export interface RivneDecision {
  /** Set when the list settles it; sorted */
  groups: GroupId[] | null
  /** The house as the list writes it, when it names it */
  house?: string
  /** Otherwise: every group the address could be in, with the operator's words */
  candidates: { group: GroupId; why: string; text: string }[]
}

/**
 * What a settlement's rows say about a house. A house the list names is settled by that. A house
 * inside a range, or on a street (or in a settlement) listed whole in exactly one group, is
 * settled unless a row of another group has the street in text that wasn't read as a street (the
 * raw text is searched for the street's main word); and a street listed whole or in part in two
 * groups is never settled by that. Exported for tests.
 */
export function decideRivne(rows: readonly RivneRow[], streetKey: string, house: string): RivneDecision {
  const number = /^(\d+)$/.exec(house)
  const base = /^\d+/.exec(house)
  const certain = new Set<GroupId>()
  const ranged = new Map<GroupId, string>()
  let written: string | undefined
  const candidates: RivneDecision['candidates'] = []
  const maybe = (group: GroupId, why: string, text: string) => {
    if (!candidates.some((c) => c.group === group && c.why === why)) candidates.push({ group, why, text })
  }
  const word = mainWord(streetKey)
  const mentions = (row: RivneRow) => row.mentions.filter((m) => m.key === streetKey)

  for (const row of rows) {
    if (row.kind === 'whole') maybe(row.group, 'the settlement is listed whole', row.text)
    if (row.kind === 'unknown') maybe(row.group, 'the row names the settlement', row.text)
    for (const m of mentions(row)) {
      const exact = m.houses.get(house)
      if (exact !== undefined) {
        certain.add(row.group)
        written ??= exact
        continue
      }
      let inRange: 'yes' | 'maybe' | 'no' = 'no'
      for (const r of m.ranges) {
        const n = Number(base?.[0])
        if (!base || n < r.from || n > r.to) continue
        if (r.parity !== null && n % 2 !== r.parity) continue
        // "42-64" may be one side of the street: only its own side is certain
        const sided = r.parity === null && r.from % 2 === r.to % 2 && n % 2 !== r.from % 2
        if (number && !r.loose && !sided) inRange = 'yes'
        else if (inRange === 'no') inRange = 'maybe'
      }
      if (inRange === 'yes') ranged.set(row.group, row.text)
      else if (inRange === 'maybe') maybe(row.group, 'a range that may include it', row.text)
      else if (m.partial) maybe(row.group, 'the street is listed in part', row.text)
      else if (!m.houses.size && !m.ranges.length) maybe(row.group, 'the street is listed whole', row.text)
    }
  }
  if (certain.size) {
    for (const g of ranged.keys()) certain.add(g)
    return { groups: [...certain].sort(compareGroups), house: written, candidates: [] }
  }

  /**
   * Rows of other groups with the street's main word in text that wasn't read as a street: a row
   * that couldn't be assigned to a settlement, a list split wrongly, a cell cut off in the file.
   * The word inside another street's name ("Володимира Стельмаха" for "Князя Володимира") is
   * accounted for; under another spelling of what may be the same street ("Володимира") it isn't.
   */
  const unread = (settled: ReadonlySet<GroupId>) => {
    const count = (text: string) => (word.length > 2 ? normalizeText(text).split(word).length - 1 : 0)
    let found = false
    for (const row of rows) {
      if (settled.has(row.group)) continue
      let loose = count(row.text)
      for (const m of row.mentions)
        if (m.key === streetKey || mainWord(m.key) !== word) loose -= count(m.name)
      if (row.cut) maybe(row.group, 'the cell is cut off in the file', row.text)
      else if (loose > 0) maybe(row.group, 'the row mentions the street', row.text)
      else continue
      found = true
    }
    return found
  }

  if (ranged.size) {
    const groups = new Set(ranged.keys())
    if (!unread(groups)) return { groups: [...groups].sort(compareGroups), candidates: [] }
    for (const [g, text] of ranged) maybe(g, 'a range that includes it', text)
  } else {
    const whole = candidates.filter((c) => /whole$/.test(c.why))
    const groups = new Set(candidates.map((c) => c.group))
    if (groups.size === 1 && whole.length && !unread(groups)) return { groups: [...groups], candidates: [] }
  }
  return { groups: null, candidates: candidates.sort((a, b) => compareGroups(a.group, b.group)) }
}
