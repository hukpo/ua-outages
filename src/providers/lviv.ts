import { toSlots } from '../ai/map.js'
import { analyzeAll, siteInput } from '../ai/posts.js'
import { postRegion } from '../ai/regions.js'
import { htmlToText } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { compareGroups, makeDay, unpublished } from '../schedule.js'
import { kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, ProviderInfo, RegionSchedule } from '../types.js'
import { emergencyQueues } from '../emergency/queues.js'
import { readingToDay } from './image-schedule.js'
import { gpvEvents, statedTime } from './posts.js'
import {
  STANDARD_GROUPS,
  hydraList,
  powerOnAddressSearch,
  rankGroups,
  uncachedJson,
  type PowerOnBuilding,
} from './poweron.js'
import { aiOf, type Provider, type ProviderContext } from './provider.js'

/**
 * Lvivoblenergo (poweron.loe.lviv.ua). Two hosts of the PowerOn platform:
 *
 * - `api.loe.lviv.ua` serves the schedule as a menu with "Today" and "Tomorrow" items whose
 *   `rawHtml` is prose: "Група 1.1. Електроенергії немає з 08:00 до 12:00.", read by the
 *   client's text processor (a slot with only a picture, by its image processor). The response also
 *   inlines the whole archive, so it is 2–3 MB; there is no smaller endpoint. Cloudflare caches
 *   it (`s-maxage=7200`), so it is requested with a cache-busting parameter (`uncachedJson`).
 * - `power-api.loe.lviv.ua` serves the address directory; its `pw_accounts` has one row per
 *   customer account, so buildings are deduplicated here.
 */
const SCHEDULE_URL = 'https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic'
const API = 'https://power-api.loe.lviv.ua/api'

const INFO: ProviderInfo = {
  id: 'lviv',
  name: 'Львівська область',
  operator: 'Львівобленерго',
  website: 'https://poweron.loe.lviv.ua/',
  capabilities: { schedule: true, addressSearch: true },
}

interface MenuItem {
  name?: string
  rawHtml?: string | null
  description?: string | null
  imageUrl?: string | null
}

interface Account {
  buildingName?: string | null
  chergGpv?: string | null
  /** ГАВ queue, "6", "20" or "Не входить" */
  chergGav?: string | null
  chergSgav?: string | null
  /** АЧР queue with its trigger frequency, "10 (48.2Гц)" */
  chergAchr?: string | null
}

export function lvivProvider(): Provider {
  const region = INFO.id

  const accounts = async (ctx: ProviderContext, cityId: string, streetId: string, house?: string) => {
    const q = new URLSearchParams({ pagination: 'false', 'city.id': cityId, 'street.id': streetId })
    if (house !== undefined) q.set('buildingName', house)
    const data = await ctx.http.json(`${API}/pw_accounts?${q}`, { region })
    return accountsToBuildings(hydraList<Account>(data, 'Lviv pw_accounts', region))
  }

  return {
    info: INFO,
    sampleAddress: { city: 'Львів', street: 'вул. Городоцька', house: '171' },

    async getSchedules(ctx) {
      // past Cloudflare, which otherwise serves this for up to two hours
      return readLvivMenu(ctx, await uncachedJson(ctx, SCHEDULE_URL, { region }))
    },

    ...powerOnAddressSearch({
      info: INFO,
      label: 'Lviv',
      api: API,
      // times here carry their real offset ("22:44:31+02:00", 17.11.2026)
      outages: { site: INFO.website, trustOffset: true },
      // the whole street is one row per account (a big street is ~2 MB), which is what the
      // official site downloads; an exact building filter is tried first to keep it light
      streetBuildings: (ctx, street) => accounts(ctx, street.cityId ?? '', street.id),
      findBuilding: (ctx, street, house) => accounts(ctx, street.cityId ?? '', street.id, house),
    }),
  }
}

/**
 * Rows per customer account → one entry per building, its groups most common first and the
 * distinct ГАВ / СГАВ / АЧР queues of all its accounts. Exported for tests.
 */
export function accountsToBuildings(rows: readonly Account[]): PowerOnBuilding[] {
  const byNumber = new Map<string, Account[]>()
  for (const r of rows) {
    const number = r.buildingName?.trim()
    if (!number) continue
    const list = byNumber.get(number) ?? []
    list.push(r)
    byNumber.set(number, list)
  }
  return [...byNumber.entries()].map(([number, list]) => {
    const emergency = emergencyQueues({
      gav: list.map((r) => r.chergGav),
      sgav: list.map((r) => r.chergSgav),
      achr: list.map((r) => r.chergAchr),
    })
    return { number, groups: rankGroups(list.map((r) => r.chergGpv)), ...(emergency ? { emergency } : {}) }
  })
}

/**
 * The menu response (JSON-LD or a plain array) → schedules. A day is the one its text names
 * ("Графік погодинних відключень на 17.10.2026"), not the slot's name: "Today" sometimes
 * already holds tomorrow's schedule. "… про відміну застосування ГПВ на 20.11.2024" is a day
 * without outages. Exported for tests.
 */
export async function readLvivMenu(ctx: ProviderContext, data: unknown): Promise<RegionSchedule> {
  const region = INFO.id
  const now = ctx.now()
  const [menu] = hydraList<{ menuItems?: MenuItem[] }>(data, 'Lviv menus', region)
  const items = menu?.menuItems
  if (!Array.isArray(items))
    throw new OutageError('parse', 'Lviv: no menu items in the schedule response', { region })
  const slots = items.filter((i) => i.name === 'Today' || i.name === 'Tomorrow')
  if (!slots.length)
    throw new OutageError('parse', 'Lviv: no "Today"/"Tomorrow" items (format changed?)', { region })

  /** date → the latest publication for it */
  const days = new Map<string, { updatedAt: string | null; groups: Record<GroupId, DaySchedule> }>()
  const keep = (date: string, updatedAt: string | null, groups: Record<GroupId, DaySchedule>) => {
    const prev = days.get(date)
    if (!prev || time(updatedAt) >= time(prev.updatedAt)) days.set(date, { updatedAt, groups })
  }
  // read against today's noon: stable through the day, so each text is analysed once a day
  const reference = toKyivIso(kyivInstant(kyivDate(now), 12 * 60))

  const texts = slots.flatMap((item) => {
    const text = htmlToText(item.rawHtml?.trim() || item.description?.trim() || '')
    return text
      ? [
          {
            item,
            input: siteInput({ site: SCHEDULE_URL, title: null, text, publishedAt: reference }, region),
          },
        ]
      : []
  })
  const analyzed = await analyzeAll(
    ctx,
    region,
    texts.map((t) => t.input),
  )
  for (const [i, { item }] of texts.entries()) {
    const { analysis, error } = analyzed[i]!
    if (!analysis) throw error
    const events = gpvEvents(analysis, region)
    if (!events.length && item.rawHtml?.trim())
      throw new OutageError(
        'parse',
        `Lviv ${item.name}: the schedule text says no schedule (format changed?)`,
        {
          region,
        },
      )
    for (const ev of events) {
      const day = ev.date ?? kyivDate(now)
      const updatedAt = statedTime(analysis, region, day, now)
      if (ev.action === 'cancel') {
        keep(
          day,
          updatedAt,
          Object.fromEntries(
            STANDARD_GROUPS.map((g) => [g, { date: day, status: 'no-outages' as const, intervals: [] }]),
          ),
        )
        continue
      }
      const groups: Record<GroupId, DaySchedule> = {}
      for (const q of ev.schedule)
        groups[q.queue] = q.intervals
          ? makeDay(day, toSlots(q.intervals))
          : { date: day, status: 'unknown', intervals: [] }
      if (Object.keys(groups).length) keep(day, updatedAt, groups)
    }
  }
  // a slot published only as a picture (before 30.10.2025 that was all there was)
  for (const item of slots) {
    const url = item.imageUrl?.trim()
    if (!url || item.rawHtml?.trim()) continue
    const bytes = await ctx.http.bytes(new URL(url, SCHEDULE_URL).href, { region })
    const reading = await aiOf(ctx).readImage(
      region,
      {
        url,
        bytes,
        caption: item.description?.trim() || null,
        publishedAt: reference,
        region: postRegion(region),
      },
      ctx.signal,
    )
    if (!reading.isSchedule) continue
    if (!reading.date)
      throw new OutageError('parse', `Lviv ${item.name}: a schedule picture with no date`, { region, url })
    keep(reading.date, null, readingToDay(reading, reading.date))
  }

  const dates = [...days.keys()].sort()
  // every slot empty: nothing published; the twelve groups stay listed as unknown
  if (!dates.length) return unpublished(region, STANDARD_GROUPS, now)
  const groups = [...new Set(dates.flatMap((d) => Object.keys(days.get(d)!.groups)))].sort(compareGroups)
  const schedules: Record<GroupId, DaySchedule[]> = {}
  for (const g of groups)
    schedules[g] = dates.map((d) => days.get(d)!.groups[g] ?? { date: d, status: 'unknown', intervals: [] })
  const updatedAt =
    dates
      .map((d) => days.get(d)!.updatedAt)
      .filter((u): u is string => !!u)
      .sort((a, b) => time(a) - time(b))
      .at(-1) ?? null

  return { region, groups, schedules, updatedAt, fetchedAt: toKyivIso(now) }
}

const time = (iso: string | null) => (iso ? Date.parse(iso) : 0)
