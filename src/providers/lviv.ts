import { toSlots } from '../ai/map.js'
import { analyzeAll, siteInput } from '../ai/posts.js'
import { htmlToText } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { compareGroups, makeDay, unpublished } from '../schedule.js'
import { kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, ProviderInfo, RegionSchedule } from '../types.js'
import type { MinuteSlot } from '../schedule.js'
import { emergencyQueues } from '../emergency/queues.js'
import { gpvEvents, statedTime } from './posts.js'
import {
  STANDARD_GROUPS,
  hydraList,
  powerOnAddressSearch,
  rankGroups,
  uncachedJson,
  type PowerOnBuilding,
} from './poweron.js'
import type { Provider, ProviderContext } from './provider.js'

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
 * without outages.
 *
 * LOE's system writes the text from a template (`lvivTemplate`: five kinds of line over 526
 * schedules of its archive), read exactly here with no processor. A text that strays from it in
 * any line goes to the client's text processor when there is one, and is a `parse` error when
 * there isn't: never a guess. A slot with only a picture (before 30.10.2025) is `parse` too.
 * Exported for tests.
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

  /** Slots whose text isn't the template: for the text processor */
  const prose: { item: MenuItem; text: string }[] = []
  for (const item of slots) {
    const text = htmlToText(item.rawHtml?.trim() || item.description?.trim() || '')
    if (!text) {
      if (item.imageUrl?.trim())
        throw new OutageError('parse', `Lviv ${item.name}: the schedule is published only as a picture`, {
          region,
          url: new URL(item.imageUrl.trim(), SCHEDULE_URL).href,
        })
      continue // an empty slot: nothing published
    }
    const t = lvivTemplate(text)
    if (!t) {
      prose.push({ item, text })
      continue
    }
    const groups: Record<GroupId, DaySchedule> = {}
    if (t.cancelled)
      for (const g of STANDARD_GROUPS) groups[g] = { date: t.date, status: 'no-outages', intervals: [] }
    else for (const [g, slots] of Object.entries(t.groups)) groups[g] = makeDay(t.date, slots)
    keep(t.date, t.stated, groups)
  }

  if (prose.length) {
    if (!ctx.ai?.text)
      throw new OutageError(
        'parse',
        `Lviv ${prose.map((p) => p.item.name).join(', ')}: the schedule text doesn't follow its template ` +
          `("${prose[0]!.text.slice(0, 80)}…"); a textProcessor can read it`,
        { region },
      )
    // read against today's noon: stable through the day, so each text is analysed once a day
    const reference = toKyivIso(kyivInstant(kyivDate(now), 12 * 60))
    const analyzed = await analyzeAll(
      ctx,
      region,
      prose.map((p) =>
        siteInput({ site: SCHEDULE_URL, title: null, text: p.text, publishedAt: reference }, region),
      ),
    )
    for (const [i, { item }] of prose.entries()) {
      const { analysis, error } = analyzed[i]!
      if (!analysis) throw error
      const events = gpvEvents(analysis, region)
      if (!events.length)
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
        const groups: Record<GroupId, DaySchedule> = {}
        if (ev.action === 'cancel')
          for (const g of STANDARD_GROUPS) groups[g] = { date: day, status: 'no-outages', intervals: [] }
        else
          for (const q of ev.schedule)
            groups[q.queue] = q.intervals
              ? makeDay(day, toSlots(q.intervals))
              : { date: day, status: 'unknown', intervals: [] }
        if (Object.keys(groups).length) keep(day, updatedAt, groups)
      }
    }
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

const DATE = String.raw`(\d{2})\.(\d{2})\.(\d{4})`
const CLOCK = String.raw`(\d{1,2}):(\d{2})`
const HEAD = new RegExp(`^Графік погодинних відключень на ${DATE}$`)
const STAMP = new RegExp(`^Інформація станом на ${CLOCK} ${DATE}$`)
const SPAN = String.raw`з \d{1,2}:\d{2} до \d{1,2}:\d{2}`
const OFF = new RegExp(`^Група ([1-6])\\.([12])\\. Електроенергії немає (${SPAN}(?:, ${SPAN})*)\\.$`)
const ON = /^Група ([1-6])\.([12])\. Електроенергія є\.$/
const CANCEL = new RegExp(
  `^Отримано вказівку НЕК «Укренерго» про відміну застосування ГПВ на ${DATE} до окремого розпорядження НЕК «Укренерго»\\.`,
)

export interface LvivTemplate {
  date: string
  /** "Інформація станом на 18:56 17.10.2026", ISO */
  stated: string | null
  /** Each group once, its outages; `cancelled`: the hourly schedule is called off for the day */
  groups: Record<GroupId, MinuteSlot[]>
  cancelled: boolean
}

/**
 * The text of a schedule slot, read exactly when it is LOE's template, line for line:
 *
 *   Графік погодинних відключень на 17.10.2026
 *   Інформація станом на 18:56 17.10.2026
 *   Група 1.1. Електроенергії немає з 20:00 до 22:00, з 23:00 до 24:00.
 *   Група 1.2. Електроенергія є.
 *
 * or the cancellation notice "Отримано вказівку НЕК «Укренерго» про відміну застосування ГПВ на
 * 20.11.2024 до окремого розпорядження НЕК «Укренерго». …". Any other line, a group twice or
 * missing, a time that doesn't exist: null (the text isn't the template). Exported for tests.
 */
export function lvivTemplate(text: string): LvivTemplate | null {
  const cancel = CANCEL.exec(text.trim())
  if (cancel) {
    // "… Інформація станом на 18:32 20.11.2024" at its end
    const at = new RegExp(`Інформація станом на ${CLOCK} ${DATE}\\s*$`).exec(text.trim())
    const stated =
      at && clockOk(+at[1]!, +at[2]!, false)
        ? kyivIso(`${at[5]}-${at[4]}-${at[3]}T${at[1]!.padStart(2, '0')}:${at[2]}`)
        : null
    return { date: isoDate(cancel), stated, groups: {}, cancelled: true }
  }
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const head = HEAD.exec(lines[0] ?? '')
  const stamp = STAMP.exec(lines[1] ?? '')
  if (!head || !stamp) return null
  const date = isoDate(head)
  const stated = clockOk(+stamp[1]!, +stamp[2]!, false)
    ? `${stamp[5]}-${stamp[4]}-${stamp[3]}T${stamp[1]!.padStart(2, '0')}:${stamp[2]}`
    : null
  if (!stated) return null
  const groups: Record<GroupId, MinuteSlot[]> = {}
  for (const line of lines.slice(2)) {
    const off = OFF.exec(line)
    const on = off ? null : ON.exec(line)
    const m = off ?? on
    if (!m) return null
    const g = `${m[1]}.${m[2]}`
    if (g in groups) return null
    const slots: MinuteSlot[] = []
    if (off)
      for (const [, h1, m1, h2, m2] of off[3]!.matchAll(/з (\d{1,2}):(\d{2}) до (\d{1,2}):(\d{2})/g)) {
        if (!clockOk(+h1!, +m1!, false) || !clockOk(+h2!, +m2!, true)) return null
        const start = +h1! * 60 + +m1!
        const end = +h2! * 60 + +m2!
        if (start >= end) return null
        slots.push({ start, end, kind: 'off' })
      }
    groups[g] = slots
  }
  if (STANDARD_GROUPS.some((g) => !(g in groups))) return null
  return { date, stated: kyivIso(stated), groups, cancelled: false }
}

const isoDate = (m: RegExpExecArray) => `${m.at(-1)}-${m.at(-2)}-${m.at(-3)}`
const clockOk = (h: number, m: number, end: boolean) => m < 60 && (h < 24 || (end && h === 24 && m === 0))
/** "2026-10-17T18:56" in Kyiv → ISO with the offset */
const kyivIso = (local: string) =>
  toKyivIso(kyivInstant(local.slice(0, 10), +local.slice(11, 13) * 60 + +local.slice(14, 16)))

const time = (iso: string | null) => (iso ? Date.parse(iso) : 0)
