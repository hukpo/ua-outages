import { OutageError } from '../errors.js'
import { compareGroups, normalizeGroup } from '../schedule.js'
import { matchScore, normalizeSettlement, normalizeStreet } from '../text.js'
import type { City, GroupId, GroupMatch, RegionInfo } from '../types.js'
import type { Provider, ProviderContext } from './provider.js'

/**
 * Khmelnytskoblenergo (hoe.com.ua). The hourly schedule is published only as an image, so
 * there is no schedule here. The address lookup is a jQuery autocomplete chain:
 * settlements → streets → houses → `POST /shutdown-queues` (an HTML snippet with subgroups).
 * The endpoints answer only to XHR requests (`X-Requested-With`), otherwise 404.
 */
const SITE = 'https://hoe.com.ua'

const INFO: RegionInfo = {
  id: 'khmelnytskyi',
  name: 'Хмельницька область',
  operator: 'Хмельницькобленерго',
  website: `${SITE}/page/pogodinni-vidkljuchennja`,
  capabilities: { schedule: false, addressSearch: true },
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
    sampleAddress: { city: 'Хмельницький', street: 'вул. Проскурівська', house: '2' },

    async getSchedules() {
      throw new OutageError(
        'unsupported',
        `${INFO.operator} publishes the hourly schedule only as an image`,
        { region },
      )
    },

    async searchCities(ctx, query) {
      // the trailing slash is required; the term is a case-insensitive substring
      const found = await list<Option>(
        ctx,
        `/settlements/?term=${encodeURIComponent(searchTerm(normalizeSettlement(query)))}`,
      )
      return found.map((o) => parseSettlement(o)).filter((c) => matchScore(query, c.name, 'settlement') > 0)
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
      // an empty term returns only the first 30 streets, so always send a word of the name
      const found = await list<Option>(
        ctx,
        `/streets/${city.id}?term=${encodeURIComponent(searchTerm(normalizeStreet(query)))}`,
      )
      return found
        .map((o) => ({ id: String(o.id), name: o.text.trim(), cityId: city.id }))
        .filter((s) => matchScore(query, s.name) > 0)
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
