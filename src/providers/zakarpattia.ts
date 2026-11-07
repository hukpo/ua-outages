import { OutageError } from '../errors.js'
import { toKyivIso } from '../time.js'
import type { GroupId, RegionInfo } from '../types.js'
import { hydraList, parseCherg, powerOnAddressSearch, type PowerOnBuilding } from './poweron.js'
import type { Provider } from './provider.js'

/**
 * Zakarpattiaoblenergo (outage.zakarpat.energy), a PowerOn platform backend.
 *
 * The schedule itself is published only as a picture (`/options?option_key=pw_gpv_image_today`
 * points to a PNG). While no picture is published, `getSchedules` returns no groups (no
 * outages announced); once one is, it throws `unsupported` with its address, since no sample of
 * that picture exists yet to build a reader from. The address lookup works: `pw_address_queues`
 * returns, per street and group, a comma-separated list of houses.
 */
const API = 'https://api-outage-zakarpat-energy.inneti.net/api'

const INFO: RegionInfo = {
  id: 'zakarpattia',
  name: 'Закарпатська область',
  operator: 'Закарпаттяобленерго',
  website: 'https://zakarpat.energy/customers/break-in-electricity-supply/schedule/',
  capabilities: { schedule: true, addressSearch: true },
}

const IMAGE_HOST = 'https://api-outage-zakarpat-energy.inneti.net'

interface Option {
  value?: string | null
}

interface AddressQueue {
  buildingNames?: string | null
  chergGpv?: string | null
}

export function zakarpattiaProvider(): Provider {
  const region = INFO.id
  return {
    info: INFO,
    sampleAddress: { city: 'Ужгород', street: 'Корзо', house: '9' },

    async getSchedules(ctx) {
      const images = await Promise.all(
        ['pw_gpv_image_today', 'pw_gpv_image_tomorrow'].map(async (key) => {
          const data = await ctx.http.json(`${API}/options?option_key=${key}`, { region })
          const value = hydraList<Option>(data, `Zakarpattia ${key}`, region)[0]?.value
          if (value !== undefined && value !== null && typeof value !== 'string')
            throw new OutageError('parse', `Zakarpattia ${key}: unexpected value`, { region })
          return value?.trim() ?? ''
        }),
      )
      const published = images.find(Boolean)
      if (published)
        throw new OutageError(
          'unsupported',
          `Zakarpattia: the schedule is published only as an image (${new URL(published, IMAGE_HOST).href}); use findGroup for the group of an address`,
          { region },
        )
      return { region, groups: [], schedules: {}, updatedAt: null, fetchedAt: toKyivIso(ctx.now()) }
    },

    ...powerOnAddressSearch({
      info: INFO,
      label: 'Zakarpattia',
      api: API,
      async streetBuildings(ctx, street) {
        // the `buildingNames` filter of this endpoint matches substrings ("5" finds "15"),
        // so the whole street is loaded (a few rows) and houses are matched here
        const q = new URLSearchParams({
          pagination: 'false',
          'city.id': street.cityId ?? '',
          'street.id': street.id,
        })
        const data = await ctx.http.json(`${API}/pw_address_queues?${q}`, { region })
        return queuesToBuildings(hydraList<AddressQueue>(data, 'Zakarpattia pw_address_queues', region))
      },
    }),
  }
}

/**
 * Rows "houses of this street in group X" → one entry per house with all its groups (a house
 * can be listed under several groups). Exported for tests.
 */
export function queuesToBuildings(rows: readonly AddressQueue[]): PowerOnBuilding[] {
  const byNumber = new Map<string, GroupId[]>()
  for (const row of rows) {
    const group = parseCherg(row.chergGpv)
    for (const number of splitHouses(row.buildingNames ?? '')) {
      const groups = byNumber.get(number) ?? []
      if (group && !groups.includes(group)) groups.push(group)
      byNumber.set(number, groups)
    }
  }
  return [...byNumber.entries()].map(([number, groups]) => ({ number, groups }))
}

/**
 * ", 10, 17(2поверх,приміщення №2), 22/2, б/н" → ["10", "17(2поверх,приміщення №2)", "22/2", "б/н"].
 * Commas inside parentheses belong to the house; empty items are dropped.
 */
export function splitHouses(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean)
}
