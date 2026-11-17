import { OutageError } from '../errors.js'
import { emergencyQueues, mergeEmergency } from '../emergency/queues.js'
import { readChannelWindow, type TelegramPost } from '../emergency/telegram.js'
import { decodeJpeg, isJpeg } from '../image/jpeg.js'
import { decodePng } from '../image/png.js'
import { readQueueColourTable } from '../image/queue-table.js'
import { cellsToIntervals } from '../schedule.js'
import { addDays, kyivDate, kyivInstant } from '../time.js'
import type { DaySchedule, EmergencyQueues, GroupId, ProviderInfo } from '../types.js'
import {
  STANDARD_GROUPS,
  hydraList,
  parseCherg,
  powerOnAddressSearch,
  type PowerOnBuilding,
} from './poweron.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'

/**
 * Zakarpattiaoblenergo (outage.zakarpat.energy), a PowerOn platform backend.
 *
 * The schedule is published only as a picture: a table of twelve rows (1-1 … 6-2) by 48
 * half-hours, the half-hours without power filled with the queue's colour (`src/image/
 * queue-table.ts`). It comes from two channels, merged with `mergeSources`:
 *
 * - `telegram:@zakarpatenergyofficial`: the operator's channel posts the picture with the
 *   caption "… графік погодинних включень/відключень електроенергії [ГПВ] на 17.10.2026", a new
 *   post for every change. The day is the date in the caption, the publication time is the
 *   post's. For each date from today on the newest such post is read; when its picture can't
 *   be read the channel fails with `parse` (an older version is not shown in its place).
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
      // both sources need the channel's posts: one read. Tomorrow's picture comes the evening before
      let read: Promise<DatedPost[]> | null = null
      const posts = (ctx: ProviderContext) =>
        (read ??= readChannelWindow(ctx, CHANNEL, {
          region,
          since: kyivInstant(addDays(today, -1), 0),
          withPhotoOnly: true,
        }).then((r) => newestPerDate(r.posts, today)))
      const picture = async (ctx: ProviderContext, url: string, date: string) => {
        const bytes = await ctx.http.bytes(url, { region })
        return { date, schedules: readZakarpattiaPicture(bytes, date, url) }
      }
      // the channel's picture of each date, or why it couldn't be read: once, for both sources
      type Reading =
        { post: DatedPost; schedules: Record<GroupId, DaySchedule> } | { post: DatedPost; error: unknown }
      let readings: Promise<Reading[]> | null = null
      const channelDays = (ctx: ProviderContext) =>
        (readings ??= posts(ctx).then(async (list) => {
          const out: Reading[] = []
          for (const post of list) {
            try {
              if (post.photos.length !== 1)
                throw new OutageError(
                  'parse',
                  `Zakarpattia: the schedule post for ${post.date} has ${post.photos.length} pictures, expected one`,
                  { region, url: post.url },
                )
              // CDN links expire: fetched right after the page
              out.push({ post, schedules: (await picture(ctx, post.photos[0]!, post.date)).schedules })
            } catch (error) {
              ctx.signal?.throwIfAborted()
              out.push({ post, error })
            }
          }
          return out
        }))
      return mergeSources(
        ctx,
        region,
        [
          {
            id: `telegram:@${CHANNEL}`,
            url: `https://t.me/s/${CHANNEL}`,
            async read(ctx) {
              const days: SourceRead['days'] = {}
              for (const r of await channelDays(ctx)) {
                // an older version is never shown in place of the one that can't be read
                if ('error' in r) throw r.error
                days[r.post.date] = { schedules: r.schedules, publishedAt: r.post.at }
              }
              return { days }
            },
          },
          {
            id: 'api',
            url: INFO.website,
            async read(ctx) {
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
                // the API doesn't say which day its picture is for: the channel must name that day
                const dated = await posts(ctx).catch(() => null)
                if (!dated?.some((p) => p.date === date))
                  throw new OutageError(
                    'unsupported',
                    `Zakarpattia: a schedule picture is published (${url}) with nothing to tell its date by: ${
                      dated
                        ? `the operator's Telegram channel has no schedule post for ${date}`
                        : `the operator's Telegram channel couldn't be read`
                    }`,
                    { region, url },
                  )
                // nor which version of the day: when the channel's newest picture for the date
                // can't be read, this one may be the version before it
                const unread = (await channelDays(ctx).catch(() => null))?.find(
                  (r) => r.post.date === date && 'error' in r,
                )
                if (unread)
                  throw new OutageError(
                    'unsupported',
                    `Zakarpattia: a schedule picture is published (${url}) with nothing to tell its version by: the newest schedule post for ${date} in the operator's Telegram channel couldn't be read`,
                    { region, url },
                  )
                days[date] = { schedules: (await picture(ctx, url, date)).schedules, publishedAt: null }
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

/** A schedule post and the date its caption names */
export type DatedPost = TelegramPost & { date: string }

/** "графік погодинних включень/відключень електроенергії ГПВ на 17.10.2026" → the date */
const CAPTION =
  /графік\S*\s+погодинних\s+включень\s*\/\s*відключень[^\n.!]{0,60}?\sна\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/iu

/** The date a schedule post is for, from its caption; null when it isn't one. Exported for tests. */
export function schedulePostDate(text: string): string | null {
  const m = CAPTION.exec(text)
  if (!m) return null
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  // 31.02 and the like
  return kyivDate(kyivInstant(date, 720)) === date ? date : null
}

/**
 * The newest schedule post for each date from `today` on, by date. A post for a past date is
 * never today's, whatever time it was posted at. Exported for tests.
 */
export function newestPerDate(posts: readonly TelegramPost[], today: string): DatedPost[] {
  const byDate = new Map<string, DatedPost>()
  for (const post of posts) {
    const date = schedulePostDate(post.text)
    if (!date || date < today) continue
    const known = byDate.get(date)
    if (!known || post.id > known.id) byDate.set(date, { ...post, date })
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** The schedule picture (JPEG from Telegram, PNG from the API) → every group's day. Exported for tests. */
export function readZakarpattiaPicture(
  bytes: Uint8Array,
  date: string,
  url?: string,
): Record<GroupId, DaySchedule> {
  let rows
  try {
    rows = readQueueColourTable(isJpeg(bytes) ? decodeJpeg(bytes) : decodePng(bytes))
  } catch (cause) {
    throw new OutageError('parse', `Zakarpattia schedule picture for ${date}: ${(cause as Error).message}`, {
      region: INFO.id,
      url,
      cause,
    })
  }
  const schedules: Record<GroupId, DaySchedule> = {}
  rows.forEach((row, i) => {
    schedules[STANDARD_GROUPS[i]!] = { date, status: 'scheduled', intervals: cellsToIntervals(date, row) }
  })
  return schedules
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
