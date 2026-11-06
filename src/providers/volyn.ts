import { OutageError } from '../errors.js'
import type { TableLayout } from '../image/table.js'
import { compareGroups, normalizeGroup } from '../schedule.js'
import { addDays, kyivDate, kyivInstant } from '../time.js'
import { normalizeHouse, normalizeSettlement, normalizeStreet } from '../text.js'
import type { AddressQuery, GroupId, GroupMatch, RegionInfo } from '../types.js'
import { scheduleFromImages, type DatedImages } from './image-schedule.js'
import type { Provider } from './provider.js'

/**
 * Volynoblenergo (energy.volyn.ua). The hourly schedule is published only as a PNG with two
 * tables (00–12 and 12–24, half-hour cells); the operator's archive API lists the images per
 * date, and the cells are read by colour (see `src/image`). The address → group form takes a free-text settlement and street
 * and answers with a table of every matching record, so it maps to `lookupAddress`.
 */
const SITE = 'https://energy.volyn.ua'
const QUEUE_FORM = `${SITE}/spozhyvacham/perervy-u-elektropostachanni/cherga/`

const INFO: RegionInfo = {
  id: 'volyn',
  name: 'Волинська область',
  operator: 'Волиньобленерго',
  website: `${SITE}/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/`,
  capabilities: { schedule: true, addressSearch: true },
}

/** One row of the result table. */
export interface VolynRecord {
  district: string
  city: string
  street: string
  /** House numbers as listed, already split */
  houses: string[]
  /** null = "Не залучено" (not part of the hourly schedule) */
  group: GroupId | null
}

export function volynProvider(): Provider {
  const region = INFO.id
  return {
    info: INFO,
    sampleAddress: { city: 'Луцьк', street: 'Винниченка', house: '8' },

    async getSchedules(ctx) {
      const archive = await ctx.http.json<unknown>(`${IMAGE_API}/api/archive_gpv_graphs?page=1`, {
        region,
        headers: { Accept: 'application/ld+json' },
      })
      const dates = latestGraphs(archive, addDays(kyivDate(ctx.now()), -1))
      return scheduleFromImages(ctx, region, dates, (path) => `${IMAGE_API}${path}`, LAYOUT)
    },

    async lookupAddress(ctx, address) {
      if (!address.city)
        throw new OutageError('not-found', `${INFO.name}: specify a city or village`, { region })
      // the form wants bare names: "Луцьк", "Лесі Українки" (no "м.", "вул.")
      const html = await ctx.http.text(QUEUE_FORM, {
        region,
        method: 'POST',
        body: new URLSearchParams({
          formCity: bare(address.city, 'settlement'),
          formStreet: bare(address.street, 'street'),
        }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      })
      return matchRecords(parseQueueTable(html), address)
    },
  }
}

/** The result page → records; [] for "Вибраної адреси у графіках не знайдено". Exported for tests. */
export function parseQueueTable(html: string): VolynRecord[] {
  const region = INFO.id
  const table = /<table class='table[^']*'>([\s\S]*?)<\/table>/.exec(html)?.[1]
  if (!table) {
    if (/адреси у графіках не знайдено/i.test(html)) return []
    throw new OutageError('parse', 'Volyn: neither a result table nor a "not found" notice', { region })
  }
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
    [...r[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]!.replace(/&nbsp;/g, ' ').trim()),
  )
  const [header, ...body] = rows
  if (header?.[0] !== 'Район' || header[4] !== 'Черга у ГПВ')
    throw new OutageError('parse', `Volyn: unexpected table header ${JSON.stringify(header)}`, { region })
  return body
    .filter((cells) => cells.length >= 5)
    .map((cells) => ({
      district: cells[0]!,
      city: cells[1]!,
      street: cells[2]!,
      // "10, 10,12, 14, 20 б, <>": split on commas, drop the placeholders
      houses: cells[3]!
        .split(',')
        .map((h) => h.trim())
        .filter((h) => /\d/.test(h)),
      group: /^\d+\.\d+$/.test(cells[4]!) ? normalizeGroup(cells[4]!) : null,
    }))
}

/**
 * Picks the records of one settlement, street and house. The form matches by substring
 * ("Луц" finds Луцьк), so exact names win; the same house often appears in several records
 * (one per connection), and every listed group is returned. Exported for tests.
 */
export function matchRecords(records: readonly VolynRecord[], address: AddressQuery): GroupMatch {
  const region = INFO.id
  const where = `${address.house}, ${address.street}, ${address.city ?? ''}`
  const narrow = (
    list: readonly VolynRecord[],
    key: (r: VolynRecord) => string,
    want: string,
    label: string,
  ) => {
    const exact = list.filter((r) => key(r) === want)
    if (exact.length) return exact
    const names = [...new Set(list.map(key))]
    if (names.length > 1)
      throw new OutageError(
        'not-found',
        `"${want}" matches several ${label}: ${names.slice(0, 8).join('; ')}. Be more specific.`,
        { region },
      )
    return list
  }
  if (!records.length)
    throw new OutageError('not-found', `${INFO.operator} knows no address "${where}"`, { region })

  const inCity = narrow(
    records,
    (r) => normalizeSettlement(r.city),
    normalizeSettlement(address.city ?? ''),
    'settlements',
  )
  const onStreet = narrow(
    inCity,
    (r) => normalizeStreet(r.street),
    normalizeStreet(address.street),
    'streets',
  )
  const want = normalizeHouse(address.house)
  const hits = onStreet.filter((r) => r.houses.some((h) => normalizeHouse(h) === want))
  if (!hits.length) {
    const known = [...new Set(onStreet.flatMap((r) => r.houses))].slice(0, 12).join(', ')
    throw new OutageError(
      'not-found',
      `House "${address.house}" not found on ${onStreet[0]!.street}. Known: ${known}`,
      { region },
    )
  }
  const groups = [...new Set(hits.map((r) => r.group).filter((g): g is GroupId => !!g))].sort(compareGroups)
  if (!groups.length)
    throw new OutageError(
      'not-found',
      `${where}: the address is not part of the hourly schedule ("Не залучено")`,
      { region },
    )
  const first = hits.find((r) => r.group)!
  return {
    region,
    group: groups[0]!,
    ...(groups.length > 1 ? { otherGroups: groups.slice(1) } : {}),
    address: { city: first.city, street: first.street, house: address.house.trim() },
  }
}

/** Name without its type word, original case kept: "вул. Лесі Українки" → "Лесі Українки". */
function bare(name: string, kind: 'street' | 'settlement'): string {
  const re =
    kind === 'street'
      ? /(^|\s)(?:вулиця|вул|проспект|просп|пр-т|провулок|пров|бульвар|бульв|бул|площа|пл|набережна|наб|пр)(?:\.|(?=\s|$))/giu
      : /(^|\s)(?:місто|м|село|с|селище|смт|с-ще|сел)(?:\.|(?=\s|$))/giu
  return name.replace(re, ' ').replace(/\s+/g, ' ').trim()
}

const IMAGE_API = 'https://api-voe-poweron.inneti.net'

/** Two tables (00–12, 12–24) of 24 half-hour cells */
const LAYOUT: TableLayout = {
  columns: 24,
  rows: 12,
  tables: 2,
  halves: false,
  palette: { on: [185, 200, 215], off: [68, 110, 155] },
}

/**
 * The newest image per schedule date, for `from` and later. `dateCreate` carries Kyiv wall
 * time labelled "+00:00" (the image itself says "станом на 22:26" for "22:26:04+00:00").
 * Exported for tests.
 */
export function latestGraphs(data: unknown, from: string): DatedImages[] {
  const members = Array.isArray(data)
    ? data
    : ((data as { 'hydra:member'?: unknown[] } | null)?.['hydra:member'] ?? null)
  if (!Array.isArray(members))
    throw new OutageError('parse', 'Volyn archive: expected a list', { region: 'volyn' })
  const byDate = new Map<string, { date: string; path: string; at: Date }[]>()
  for (const m of members as {
    dateGraph?: string
    dateCreate?: string
    imageUrl?: { contentUrl?: string }
  }[]) {
    const date = m.dateGraph?.slice(0, 10)
    const path = m.imageUrl?.contentUrl
    const c = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(m.dateCreate ?? '')
    if (!date || !path || !c || date < from) continue
    const at = kyivInstant(c[1]!, Number(c[2]) * 60 + Number(c[3]))
    const list = byDate.get(date) ?? []
    list.push({ date, path, at })
    byDate.set(date, list)
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({ date, images: list.sort((a, b) => b.at.getTime() - a.at.getTime()) }))
}
