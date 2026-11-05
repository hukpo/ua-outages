import { OutageError } from '../errors.js'
import { compareGroups, normalizeGroup } from '../schedule.js'
import { normalizeHouse, normalizeSettlement, normalizeStreet } from '../text.js'
import type { AddressQuery, GroupId, GroupMatch, RegionInfo } from '../types.js'
import type { Provider } from './provider.js'

/**
 * Volynoblenergo (energy.volyn.ua). The hourly schedule is published only as an image, so
 * there is no schedule here. The address → group form takes a free-text settlement and street
 * and answers with a table of every matching record, so it maps to `lookupAddress`.
 */
const SITE = 'https://energy.volyn.ua'
const QUEUE_FORM = `${SITE}/spozhyvacham/perervy-u-elektropostachanni/cherga/`

const INFO: RegionInfo = {
  id: 'volyn',
  name: 'Волинська область',
  operator: 'Волиньобленерго',
  website: `${SITE}/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/`,
  capabilities: { schedule: false, addressSearch: true },
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

    async getSchedules() {
      throw new OutageError(
        'unsupported',
        `${INFO.operator} publishes the hourly schedule only as an image`,
        { region },
      )
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
