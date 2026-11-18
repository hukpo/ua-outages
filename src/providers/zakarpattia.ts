import { postRegion } from '../ai/regions.js'
import { OutageError } from '../errors.js'
import { emergencyQueues, mergeEmergency } from '../emergency/queues.js'
import { readChannelWindow } from '../emergency/telegram.js'
import { addDays, kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { DaySchedule, EmergencyQueues, GroupId, ProviderInfo } from '../types.js'
import { hourlySchedule, readingToDay } from './image-schedule.js'
import { readPicturePosts, type PicturePostsRead } from './picture-posts.js'
import { daysToSource } from './posts.js'
import {
  STANDARD_GROUPS,
  hydraList,
  parseCherg,
  powerOnAddressSearch,
  type PowerOnBuilding,
} from './poweron.js'
import { aiOf, type Provider, type ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'

/**
 * Zakarpattiaoblenergo (outage.zakarpat.energy), a PowerOn platform backend.
 *
 * The schedule is published only as a picture: a table of twelve rows (1-1 … 6-2) by 48
 * half-hours, the half-hours without power filled with the queue's colour, read by the client's
 * image processor. It comes from two channels, merged with `mergeSources`:
 *
 * - `telegram:@zakarpatenergyofficial`: the operator's channel posts the picture with the
 *   caption "… графік погодинних включень/відключень електроенергії [ГПВ] на 17.10.2026", a new
 *   post for every change (see `readPicturePosts`). The day is the date in the caption, the
 *   publication time is the post's; when a schedule picture can't be read the channel fails
 *   with `parse` (an older version is not shown in its place).
 * - `api`: `/options?option_key=pw_gpv_image_today|tomorrow` point to the picture on the
 *   operator's own server. Nothing there says which day a picture is for or when it was put
 *   there (the option's `date` has stood at 30.06.2026 through the pictures of 17.10.2026), and
 *   the date in the picture's title is too small to read. So a picture is taken for today
 *   (tomorrow) only when the channel has a schedule post for that date; otherwise the source
 *   fails with `unsupported` and the picture's address; the same when the channel's newest post
 *   for that date couldn't be read (the picture here may then be the version before it, and an
 *   older version is never shown as the day). It carries no publication time, so the
 *   channel's reading wins a day both have, and the API's serves as a check (`disagrees`).
 *
 * Nothing published on either: the twelve groups are listed with today `unknown`, which is not
 * "no outages". The address lookup works: `pw_address_queues` returns, per street and group, a
 * comma-separated list of houses.
 */
const API = 'https://api-outage-zakarpat-energy.inneti.net/api'

const INFO: ProviderInfo = {
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
  /** ГАВ queue of these houses, "10" or "Не входить" */
  chergGav?: string | null
  chergSgav?: string | null
  chergAchr?: string | null
}

export function zakarpattiaProvider(): Provider {
  const region = INFO.id
  return {
    info: INFO,
    sampleAddress: { city: 'Ужгород', street: 'Корзо', house: '9' },

    getSchedules(ctx) {
      const today = kyivDate(ctx.now())
      const opts = { groups: STANDARD_GROUPS, updates: 'layer' } as const
      // both sources need the channel: one read. Tomorrow's picture comes the evening before
      let channel: Promise<PicturePostsRead> | null = null
      const readChannel = (ctx: ProviderContext) =>
        (channel ??= readChannelWindow(ctx, CHANNEL, {
          region,
          since: kyivInstant(addDays(today, -1), 0),
          withPhotoOnly: true,
        }).then((r) => readPicturePosts(ctx, region, r.posts, opts)))
      return mergeSources(
        ctx,
        region,
        [
          {
            id: `telegram:@${CHANNEL}`,
            url: `https://t.me/s/${CHANNEL}`,
            async read(ctx) {
              const { days, url } = await readChannel(ctx)
              for (const date of [...days.keys()]) if (date < today) days.delete(date)
              return { ...daysToSource(days, opts), ...(url ? { url } : {}) }
            },
          },
          {
            id: 'api',
            url: INFO.website,
            async read(ctx) {
              // its picture's day comes from the channel's captions: nothing without both
              aiOf(ctx).requireImage(region)
              aiOf(ctx).requireText(region)
              const [todayPath, tomorrowPath] = await Promise.all(
                ['pw_gpv_image_today', 'pw_gpv_image_tomorrow'].map(async (key) => {
                  const data = await ctx.http.json(`${API}/options?option_key=${key}`, { region })
                  const value = hydraList<Option>(data, `Zakarpattia ${key}`, region)[0]?.value
                  if (value !== undefined && value !== null && typeof value !== 'string')
                    throw new OutageError('parse', `Zakarpattia ${key}: unexpected value`, { region })
                  return value?.trim() ?? ''
                }),
              )
              const days: SourceRead['days'] = {}
              for (const [path, date] of [
                [todayPath, today],
                [tomorrowPath, addDays(today, 1)],
              ] as const) {
                if (!path) continue
                const url = new URL(path, IMAGE_HOST).href
                // the API doesn't say which day its picture is for, nor which version: the
                // channel must have that day, read in full
                const dated = await readChannel(ctx).catch(() => null)
                if (!dated?.pictures[date]?.length)
                  throw new OutageError(
                    'unsupported',
                    `Zakarpattia: a schedule picture is published (${url}) with nothing to tell its date by: ${
                      dated
                        ? `the operator's Telegram channel has no schedule picture for ${date}`
                        : `the operator's Telegram channel couldn't be read`
                    }`,
                    { region, url },
                  )
                days[date] = { schedules: await readApiPicture(ctx, url, date), publishedAt: null }
              }
              return { days }
            },
          },
        ],
        // its twelve groups (1.1–6.2, one PDF each on the site)
        { groups: STANDARD_GROUPS },
      )
    },

    ...powerOnAddressSearch({
      info: INFO,
      label: 'Zakarpattia',
      api: API,
      // Kyiv wall clock labelled +00:00: works end at "17:00:00+00:00"
      outages: { site: 'https://outage.zakarpat.energy/' },
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

const CHANNEL = 'zakarpatenergyofficial'

/** The API's picture for `date` → every group's day; a picture of another day is a `parse` error */
async function readApiPicture(
  ctx: ProviderContext,
  url: string,
  date: string,
): Promise<Record<GroupId, DaySchedule>> {
  const region = INFO.id
  const bytes = await ctx.http.bytes(url, { region })
  const reading = await aiOf(ctx).readImage(
    region,
    { url, bytes, caption: null, publishedAt: toKyivIso(kyivInstant(date, 0)), region: postRegion(region) },
    ctx.signal,
  )
  if (!hourlySchedule(reading) || (reading.date && reading.date !== date))
    throw new OutageError(
      'parse',
      `Zakarpattia: the API's picture for ${date} ${hourlySchedule(reading) ? `reads ${reading.date}` : 'is not an hourly schedule'}`,
      { region, url },
    )
  return readingToDay(reading, date)
}

/**
 * Rows "houses of this street in group X" → one entry per house with all its groups (a house
 * can be listed under several groups). Exported for tests.
 */
export function queuesToBuildings(rows: readonly AddressQueue[]): PowerOnBuilding[] {
  const byNumber = new Map<string, { groups: GroupId[]; emergency?: EmergencyQueues }>()
  for (const row of rows) {
    const group = parseCherg(row.chergGpv)
    const emergency = emergencyQueues({ gav: [row.chergGav], sgav: [row.chergSgav], achr: [row.chergAchr] })
    for (const number of splitHouses(row.buildingNames ?? '')) {
      const entry = byNumber.get(number) ?? { groups: [] }
      if (group && !entry.groups.includes(group)) entry.groups.push(group)
      entry.emergency = mergeEmergency(entry.emergency, emergency)
      byNumber.set(number, entry)
    }
  }
  return [...byNumber.entries()].map(([number, { groups, emergency }]) => ({
    number,
    groups,
    ...(emergency ? { emergency } : {}),
  }))
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
