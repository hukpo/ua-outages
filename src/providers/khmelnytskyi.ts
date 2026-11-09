import { OutageError } from '../errors.js'
import type { TableLayout } from '../image/table.js'
import { STANDARD_GROUPS } from '../image/table.js'
import { compareGroups, makeDay, normalizeGroup, type MinuteSlot } from '../schedule.js'
import { addDays, kyivDate, kyivInstant } from '../time.js'
import { normalizeSettlement, normalizeStreet } from '../text.js'
import type { City, DaySchedule, GroupId, GroupMatch, RegionInfo, RegionSchedule } from '../types.js'
import { scheduleFromImages, type DatedImages } from './image-schedule.js'
import type { Provider, ProviderContext } from './provider.js'
import { findUaDate, parseGroupLines } from './ua-text.js'

/**
 * Khmelnytskoblenergo (hoe.com.ua). The hourly schedule is published either as text on the
 * schedule page ("Підчерга 1.1 – 10:00-15:00; 18:00-21:00.", one block per announcement, the
 * newest on top) or as a PNG table: the archive page lists every image with its date, and the
 * cells are read by colour (see `src/image`). A date in the text wins over its images. The address lookup is a jQuery autocomplete chain:
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
      const from = addDays(kyivDate(ctx.now()), -1)
      const [page, archive] = await Promise.all([
        ctx.http.text(INFO.website, { region }),
        ctx.http.text(`${SITE}/page/arhiv-grafikiv-pogodinnih-vidkljuchen-${year}`, { region }),
      ])
      const text = textSchedules(page, ctx.now(), from)
      const dates = latestImages(archive, from).filter((d) => !text.has(d.date))
      return mergeText(await scheduleFromImages(ctx, region, dates, (path) => `${SITE}${path}`, LAYOUT), text)
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

/**
 * The schedule page's text announcements → date → group → off slots, for `from` and later.
 * Announcements are separated by <hr>, the newest first; an older one for the same date is
 * ignored. Exported for tests.
 */
export function textSchedules(
  html: string,
  now: Date,
  from: string,
): Map<string, Record<string, MinuteSlot[]>> {
  const out = new Map<string, Record<string, MinuteSlot[]>>()
  const start = html.indexOf('class="post"')
  if (start === -1) return out
  const end = html.indexOf('Перевірити чергу', start)
  for (const block of html.slice(start, end === -1 ? undefined : end).split(/<hr\b[^>]*>/i)) {
    if (!/Підчерг/i.test(block)) continue
    const groups = parseGroupLines(block)
    const date = findUaDate(block.replace(/<[^>]+>/g, ' '), now)
    if (!date)
      throw new OutageError('parse', 'Khmelnytskyi: a schedule announcement without a date', {
        region: INFO.id,
      })
    if (!Object.keys(groups).length)
      throw new OutageError('parse', `Khmelnytskyi: no subgroups read from the ${date} announcement`, {
        region: INFO.id,
      })
    if (date >= from && !out.has(date)) out.set(date, groups)
  }
  return out
}

function mergeText(images: RegionSchedule, text: Map<string, Record<string, MinuteSlot[]>>): RegionSchedule {
  if (!text.size) return images
  const schedules: Record<string, DaySchedule[]> = { ...images.schedules }
  for (const [date, groups] of text)
    for (const g of STANDARD_GROUPS) schedules[g] = [...(schedules[g] ?? []), makeDay(date, groups[g] ?? [])]
  for (const g of Object.keys(schedules)) schedules[g]!.sort((a, b) => a.date.localeCompare(b.date))
  return { ...images, groups: Object.keys(schedules).sort(compareGroups), schedules }
}
