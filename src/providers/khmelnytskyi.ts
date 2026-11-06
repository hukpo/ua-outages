import { OutageError } from '../errors.js'
import type { TableLayout } from '../image/table.js'
import { compareGroups, normalizeGroup } from '../schedule.js'
import { addDays, kyivDate, kyivInstant } from '../time.js'
import { normalizeSettlement, normalizeStreet } from '../text.js'
import type { City, GroupId, GroupMatch, RegionInfo } from '../types.js'
import { scheduleFromImages, type DatedImages } from './image-schedule.js'
import type { Provider, ProviderContext } from './provider.js'

/**
 * Khmelnytskoblenergo (hoe.com.ua). The hourly schedule is published only as a PNG table;
 * the archive page lists every image with its date, and the cells are read by colour
 * (see `src/image`). The address lookup is a jQuery autocomplete chain:
 * settlements → streets → houses → `POST /shutdown-queues` (an HTML snippet with subgroups).
 * The endpoints answer only to XHR requests (`X-Requested-With`), otherwise 404.
 */
const SITE = 'https://hoe.com.ua'

const INFO: RegionInfo = {
  id: 'khmelnytskyi',
  name: 'Хмельницька область',
  operator: 'Хмельницькобленерго',
  website: `${SITE}/page/pogodinni-vidkljuchennja`,
  capabilities: { schedule: true, addressSearch: true },
}

const XHR = { 'X-Requested-With': 'XMLHttpRequest', Referer: `${SITE}/shutdown/queue` }

interface Option {
  id: number
  text: string
}

export function khmelnytskyiProvider(): Provider {
  const region = INFO.id

  const list = async <T>(ctx: ProviderContext, path: string) => {
    const data = await ctx.http.json<T[]>(`${SITE}${path}`, { region, headers: XHR })
    if (!Array.isArray(data))
      throw new OutageError('parse', `Khmelnytskyi ${path}: expected a list`, { region })
    return data
  }

  return {
    info: INFO,
    remoteSearch: { cities: true, streets: true },
    sampleAddress: { city: 'Хмельницький', street: 'вул. Проскурівська', house: '2' },

    async getSchedules(ctx) {
      const year = kyivDate(ctx.now()).slice(0, 4)
      const html = await ctx.http.text(`${SITE}/page/arhiv-grafikiv-pogodinnih-vidkljuchen-${year}`, {
        region,
      })
      const dates = latestImages(html, addDays(kyivDate(ctx.now()), -1))
      return scheduleFromImages(ctx, region, dates, (path) => `${SITE}${path}`, LAYOUT)
    },

    async searchCities(ctx, query) {
      // the trailing slash is required; the term is a case-insensitive substring
      const found = await list<Option>(
        ctx,
        `/settlements/?term=${encodeURIComponent(searchTerm(normalizeSettlement(query)))}`,
      )
      return found.map((o) => parseSettlement(o))
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
      // an empty term returns only the first 30 streets, so always send a word of the name
      const found = await list<Option>(
        ctx,
        `/streets/${city.id}?term=${encodeURIComponent(searchTerm(normalizeStreet(query)))}`,
      )
      return found.map((o) => ({ id: String(o.id), name: o.text.trim(), cityId: city.id }))
    },

    async searchHouses(ctx, street) {
      const houses = await list<string>(ctx, `/houses/${street.id}`)
      // the house string itself is what /shutdown-queues expects
      return houses
        .map((h) => String(h).trim())
        .filter(Boolean)
        .map((h) => ({ id: h, number: h, streetId: street.id }))
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      const html = await ctx.http.text(`${SITE}/shutdown-queues`, {
        region,
        method: 'POST',
        body: new URLSearchParams({ streetId: street.id, house: house.id }),
        headers: { ...XHR, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      })
      const groups = parseQueues(html)
      if (!groups.length)
        throw new OutageError(
          'not-found',
          `${house.number}, ${street.name}: the operator gives no hourly-outage subgroup`,
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

/** "м. Хмельницький (Хмельницька громада)" → name + district. Exported for tests. */
export function parseSettlement(o: Option): City {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(o.text.trim())
  return m ? { id: String(o.id), name: m[1]!, district: m[2]! } : { id: String(o.id), name: o.text.trim() }
}

/**
 * The `/shutdown-queues` snippet → sorted subgroups. The ГПВ alert reads
 * "… (ГПВ) ваша адреса відноситься до підчерги: <strong>1.1, 3.1</strong>"; the ГАВ alert after
 * it lists emergency queues and is ignored. Exported for tests.
 */
export function parseQueues(html: string): GroupId[] {
  const gpv = /\(ГПВ\)[^<]*<strong>([^<]*)<\/strong>/.exec(html)
  if (!gpv) {
    if (/alert/.test(html) && !/<html/i.test(html)) return []
    throw new OutageError(
      'parse',
      'Khmelnytskyi: unexpected /shutdown-queues answer (format changed or bad request)',
      {
        region: INFO.id,
      },
    )
  }
  const groups = gpv[1]!
    .split(',')
    .map((g) => normalizeGroup(g))
    .filter((g): g is GroupId => !!g)
  return [...new Set(groups)].sort(compareGroups)
}

/**
 * The longest piece of a normalized name, for the server's substring search. Apostrophes are
 * split off because the operator stores "’" while people type "'" ("Кам’янецька").
 */
function searchTerm(normalized: string): string {
  return normalized.split(/[\s']+/).sort((a, b) => b.length - a.length)[0] ?? ''
}

/** 24 hour columns, a cell may be half filled (30 minutes) */
const LAYOUT: TableLayout = {
  columns: 24,
  rows: 12,
  tables: 1,
  halves: true,
  palette: { on: [255, 255, 255], off: [143, 170, 220], maybe: [207, 205, 205] },
}

/**
 * The newest image per date from the archive page, for `from` and later. Links look like
 * `/Content/Uploads/2026/10/file20261017164437203.png` "Графік погодинних відключень 17.10.2026
 * (оновлено, 16:50)"; the file name carries the upload time (Kyiv), which orders updates.
 * Exported for tests.
 */
export function latestImages(html: string, from: string): DatedImages[] {
  const byDate = new Map<string, { date: string; path: string; at: Date }[]>()
  const re = /<a href="(\/Content\/Uploads\/[^"]+?file(\d{8})(\d{6})\d*\.png)"[^>]*>([^<]*)/g
  for (const m of html.matchAll(re)) {
    const d = /(\d{2})\.(\d{2})\.(\d{4})/.exec(m[4]!)
    if (!d) continue
    const date = `${d[3]}-${d[2]}-${d[1]}`
    if (date < from) continue
    const f = m[2]!
    const t = m[3]!
    const at = kyivInstant(
      `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`,
      Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4)),
    )
    const list = byDate.get(date) ?? []
    list.push({ date, path: m[1]!, at })
    byDate.set(date, list)
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({ date, images: list.sort((a, b) => b.at.getTime() - a.at.getTime()) }))
}
