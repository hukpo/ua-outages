import { OutageError } from '../errors.js'
import { emergencyQueues, queueNames } from '../emergency/queues.js'
import { compareGroups, normalizeGroup, STANDARD_GROUPS } from '../schedule.js'
import { addDays, kyivDate, kyivInstant } from '../time.js'
import { houseKey, normalizeSettlement, normalizeStreet, normalizeText } from '../text.js'

export { houseKey }
import type { AddressQuery, City, GroupId, GroupMatch, House, ProviderInfo, Street } from '../types.js'
import { archivePictures, readSitePictures, type DatedImages } from './image-schedule.js'
import { daysToSource } from './posts.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources } from './sources.js'

/**
 * Volynoblenergo (energy.volyn.ua). The hourly schedule is published only as a PNG with two
 * tables (00–12 and 12–24, half-hour cells); the operator's archive API lists the images per
 * date, and each picture is read by the client's image processor. The archive is the only channel
 * (the operator has no Telegram channel): it holds tomorrow's picture from about 22:15 the
 * evening before and every version of today's, each with its upload time, which is `updatedAt`.
 * Only pictures dated today or later are read; with none, today is `unknown`.
 *
 * The address → group form takes a free-text settlement and a street and answers with a table
 * of every record matching both as substrings. `findGroup` goes through `lookupAddress`. For
 * autocomplete there is no settlement directory (the form answers nothing without a street), so
 * there is no `searchCities`: the settlement stays free text, passed as the `city` of
 * `searchStreets` (`{ id: '', name: 'Луцьк' }`), and the streets found are those of the
 * settlement with exactly that name.
 */
const SITE = 'https://energy.volyn.ua'
const QUEUE_FORM = `${SITE}/spozhyvacham/perervy-u-elektropostachanni/cherga/`

const INFO: ProviderInfo = {
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
  /** "Черга у ГАВ" (the 6th column); null = "Не залучено" or no such column */
  gav: string | null
}

export function volynProvider(): Provider {
  const region = INFO.id
  /** street id → its records from the last search that found it, so picking a house costs no request */
  const found = new Map<string, { records: VolynRecord[]; at: number }>()
  // the newest answer replaces what was kept: a street's queue can change
  const remember = (id: string, records: readonly VolynRecord[]) => {
    found.delete(id)
    found.set(id, { records: records.filter((r) => streetId(r) === id), at: Date.now() })
    if (found.size > FOUND_MAX) found.delete(found.keys().next().value!)
  }
  /** Records of a street from `searchStreets`; asked again when they aren't kept (an id from earlier) or are old */
  const streetRecords = async (ctx: ProviderContext, street: Street): Promise<VolynRecord[]> => {
    const known = found.get(street.id)
    if (known && Date.now() - known.at <= FOUND_TTL_MS) return known.records
    const [, city, name] = street.id.split(SEP)
    const records =
      city && name ? (await search(ctx, city, name)).filter((r) => streetId(r) === street.id) : []
    if (!records.length)
      throw new OutageError('not-found', `${INFO.operator}: unknown street ${street.name}`, { region })
    remember(street.id, records)
    return records
  }
  return {
    info: INFO,
    sampleAddress: { city: 'Луцьк', street: 'Винниченка', house: '8' },

    remoteSearch: { streets: true },

    getSchedules: (ctx) =>
      mergeSources(
        ctx,
        region,
        [
          {
            id: 'site',
            url: INFO.website,
            async read(ctx) {
              const archive = await ctx.http.json<unknown>(`${IMAGE_API}/api/archive_gpv_graphs?page=1`, {
                region,
                headers: { Accept: 'application/ld+json' },
              })
              // a picture for a past date says nothing about today
              const today = kyivDate(ctx.now())
              const dates = latestGraphs(archive, today).filter((d) => d.date <= addDays(today, 2))
              const opts = { groups: STANDARD_GROUPS }
              const days = await readSitePictures(
                ctx,
                region,
                archivePictures(ctx, region, dates, (path) => `${IMAGE_API}${path}`),
                opts,
              )
              return daysToSource(days, opts)
            },
          },
        ],
        { groups: STANDARD_GROUPS },
      ),

    async searchStreets(ctx, query, city) {
      if (!city?.name.trim())
        throw new OutageError(
          'not-found',
          `${INFO.name}: name the city or village, e.g. { city: { id: '', name: 'Луцьк' } }`,
          { region },
        )
      // one or two letters match thousands of records ("а" in Lutsk: 2987)
      const fragment = bare(query, 'street')
      if (fragment.length < MIN_FRAGMENT) return []
      const records = await search(ctx, city.name, fragment)
      const out = new Map<string, Street>()
      for (const r of inSettlement(records, city.name)) {
        const id = streetId(r)
        if (!out.has(id)) out.set(id, { id, name: r.street, cityId: cityId(r) })
        remember(id, records)
      }
      // two villages of one name: say which district each street is in
      if (new Set([...out.values()].map((s) => s.cityId)).size > 1)
        for (const s of out.values()) s.name = `${s.name} (${s.id.split(SEP)[0]} район)`
      return [...out.values()]
    },

    async searchHouses(ctx, street) {
      const seen = new Set<string>()
      const out: House[] = []
      for (const r of await streetRecords(ctx, street))
        for (const number of r.houses) {
          const key = houseKey(number)
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ id: `${street.id}#${key}`, number, streetId: street.id })
        }
      return out
    },

    async groupOf(ctx, house, street, city) {
      const [, settlement, name] = street.id.split(SEP)
      // the street was picked from one settlement of one district: its records are only that one's
      return matchRecords(await streetRecords(ctx, street), {
        city: settlement ?? city?.name,
        street: name ?? street.name,
        house: house.number,
      })
    },

    async lookupAddress(ctx, address) {
      if (!address.city)
        throw new OutageError('not-found', `${INFO.name}: specify a city or village`, { region })
      return matchRecords(await search(ctx, address.city, address.street), address)
    },
  }
}

/** Shortest street fragment sent to the form */
const MIN_FRAGMENT = 3
const SEP = '|'
const cityId = (r: VolynRecord) => `${r.district}${SEP}${r.city}`
const streetId = (r: VolynRecord) => `${cityId(r)}${SEP}${r.street}`

/** The form's answer for a settlement and a street (both matched as substrings by the server). */
async function search(ctx: ProviderContext, city: string, street: string): Promise<VolynRecord[]> {
  // the form wants bare names: "Луцьк", "Лесі Українки" (no "м.", "вул.")
  const html = await ctx.http.text(QUEUE_FORM, {
    region: INFO.id,
    method: 'POST',
    body: new URLSearchParams({ formCity: bare(city, 'settlement'), formStreet: bare(street, 'street') }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  })
  return parseQueueTable(html)
}

/** Records of the settlement with exactly this name: "Луцьк" also brings "Прилуцьке". Exported for tests. */
export function inSettlement(records: readonly VolynRecord[], city: string): VolynRecord[] {
  const want = normalizeSettlement(city)
  return records.filter((r) => normalizeSettlement(r.city) === want)
}

const FOUND_MAX = 300
/** How long a street's records answer without asking the form again */
const FOUND_TTL_MS = 6 * 3_600_000

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
      gav: header[5] === 'Черга у ГАВ' ? queueNames(cells[5]).join(', ') || null : null,
    }))
}

/** "Луцький район", "Луцький р-н", "луцький" → "луцький" */
const districtKey = (s: string) =>
  normalizeText(s)
    .replace(/(^|\s)(?:район|р-н)\.?(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Picks the records of one settlement, street and house. The form matches by substring
 * ("Луц" finds Луцьк), so exact names win; the same house often appears in several records
 * (one per connection), and every listed group is returned. Villages of one name in several
 * districts are different villages: `address.district` picks one, and without it the answer is
 * `not-found` naming the districts, never the groups of all of them. Exported for tests.
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
  const everyDistrict = narrow(
    inCity,
    (r) => normalizeStreet(r.street),
    normalizeStreet(address.street),
    'streets',
  )
  const named = everyDistrict
  const districts = [...new Set(named.map((r) => r.district))]
  const asked = address.district?.trim() ? districtKey(address.district) : ''
  const onStreet = asked ? named.filter((r) => districtKey(r.district) === asked) : named
  if (asked ? !onStreet.length : districts.length > 1)
    throw new OutageError(
      'not-found',
      `${named[0]!.city}, ${named[0]!.street}: ${
        asked ? `not in the district "${address.district!.trim()}"` : 'a settlement of this name is'
      } listed in ${districts.map((d) => `${d} район`).join('; ')}. Pass one as \`district\`.`,
      { region },
    )
  const want = houseKey(address.house)
  const hits = onStreet.filter((r) => r.houses.some((h) => houseKey(h) === want))
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
  const emergency = emergencyQueues({ gav: hits.map((r) => r.gav) })
  return {
    region,
    group: groups[0]!,
    ...(groups.length > 1 ? { otherGroups: groups.slice(1) } : {}),
    address: { city: first.city, street: first.street, house: address.house.trim() },
    ...(emergency ? { emergency } : {}),
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

/**
 * The newest image per schedule date, for `from` and later, each with the time it was uploaded:
 * `imageUrl.uploadTimestamp`, which is real UTC. `dateCreate` is the same moment as Kyiv wall
 * time labelled "+00:00" (the image itself says "станом на 22:26" for "22:26:04+00:00"); it is
 * used only for an entry without the upload time. Exported for tests.
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
    imageUrl?: { contentUrl?: string; uploadTimestamp?: string }
  }[]) {
    const date = m.dateGraph?.slice(0, 10)
    const path = m.imageUrl?.contentUrl
    if (!date || !path || date < from) continue
    const uploaded = Date.parse(m.imageUrl?.uploadTimestamp ?? '')
    const c = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(m.dateCreate ?? '')
    if (!Number.isFinite(uploaded) && !c) continue
    const at = Number.isFinite(uploaded)
      ? new Date(uploaded)
      : kyivInstant(c![1]!, Number(c![2]) * 60 + Number(c![3]))
    const list = byDate.get(date) ?? []
    list.push({ date, path, at })
    byDate.set(date, list)
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({ date, images: list.sort((a, b) => b.at.getTime() - a.at.getTime()) }))
}
