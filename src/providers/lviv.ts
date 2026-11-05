import { OutageError } from '../errors.js'
import { compareGroups, makeDay, normalizeGroup } from '../schedule.js'
import { toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, RegionInfo, RegionSchedule } from '../types.js'
import { parseUaDateTime } from './gpv.js'
import { STANDARD_GROUPS, hydraList, powerOnAddressSearch, rankGroups, type PowerOnBuilding } from './poweron.js'
import type { Provider, ProviderContext } from './provider.js'
import { findUaDate, parseGroupLines } from './ua-text.js'

/**
 * Lvivoblenergo (poweron.loe.lviv.ua). Two hosts of the PowerOn platform:
 *
 * - `api.loe.lviv.ua` serves the schedule as a menu with "Today" and "Tomorrow" items whose
 *   `rawHtml` is prose: "Група 1.1. Електроенергії немає з 08:00 до 12:00." The response also
 *   inlines the whole archive, so it is 2–3 MB; there is no smaller endpoint.
 * - `power-api.loe.lviv.ua` serves the address directory; its `pw_accounts` has one row per
 *   customer account, so buildings are deduplicated here.
 */
const SCHEDULE_URL = 'https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic'
const API = 'https://power-api.loe.lviv.ua/api'

const INFO: RegionInfo = {
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
      return parseLvivMenu(await ctx.http.json(SCHEDULE_URL, { region }), ctx.now())
    },

    ...powerOnAddressSearch({
      info: INFO,
      label: 'Lviv',
      api: API,
      // the whole street is one row per account (a big street is ~2 MB), which is what the
      // official site downloads; an exact building filter is tried first to keep it light
      streetBuildings: (ctx, street) => accounts(ctx, street.cityId ?? '', street.id),
      findBuilding: (ctx, street, house) => accounts(ctx, street.cityId ?? '', street.id, house),
    }),
  }
}

/** Rows per customer account → one entry per building, its groups most common first. Exported for tests. */
export function accountsToBuildings(rows: readonly Account[]): PowerOnBuilding[] {
  const byNumber = new Map<string, (string | null | undefined)[]>()
  for (const r of rows) {
    const number = r.buildingName?.trim()
    if (!number) continue
    const list = byNumber.get(number) ?? []
    list.push(r.chergGpv)
    byNumber.set(number, list)
  }
  return [...byNumber.entries()].map(([number, cherg]) => ({ number, groups: rankGroups(cherg) }))
}

/**
 * The menu response (JSON-LD or a plain array) → schedules. A day is taken from the text
 * ("Графік погодинних відключень на 17.10.2026"), not from the slot name: "Today" sometimes
 * already holds tomorrow's schedule. Exported for tests.
 */
export function parseLvivMenu(data: unknown, now: Date): RegionSchedule {
  const region = INFO.id
  const [menu] = hydraList<{ menuItems?: MenuItem[] }>(data, 'Lviv menus', region)
  const items = menu?.menuItems
  if (!Array.isArray(items)) throw new OutageError('parse', 'Lviv: no menu items in the schedule response', { region })
  const slots = items.filter((i) => i.name === 'Today' || i.name === 'Tomorrow')
  if (!slots.length) throw new OutageError('parse', 'Lviv: no "Today"/"Tomorrow" items (format changed?)', { region })

  /** date → the latest publication for it */
  const days = new Map<string, { updatedAt: string | null; groups: Record<GroupId, DaySchedule> }>()
  const keep = (date: string, updatedAt: string | null, groups: Record<GroupId, DaySchedule>) => {
    const prev = days.get(date)
    if (!prev || time(updatedAt) >= time(prev.updatedAt)) days.set(date, { updatedAt, groups })
  }

  for (const item of slots) {
    const html = item.rawHtml?.trim() ?? ''
    const description = item.description?.trim() ?? ''
    if (html) {
      const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
      const date = /відключень\s+на\s+(\d{2}\.\d{2}\.\d{4})/i.exec(text)?.[1] ?? text
      const day = findUaDate(date, now)
      if (!day) throw new OutageError('parse', `Lviv ${item.name}: no date in the schedule text`, { region })
      const parsed = parseGroupLines(html)
      const groups: Record<GroupId, DaySchedule> = {}
      for (const [raw, slots] of Object.entries(parsed)) {
        const g = normalizeGroup(raw)
        if (g) groups[g] = makeDay(day, slots)
      }
      if (!Object.keys(groups).length)
        throw new OutageError('parse', `Lviv ${item.name}: schedule text without groups (format changed?)`, { region })
      keep(day, updatedAtOf(text), groups)
    } else if (/відмін\S*\s+застосування\s+ГПВ/i.test(description)) {
      // "Отримано вказівку НЕК «Укренерго» про відміну застосування ГПВ на 20.11.2024 …"
      const day = findUaDate(description.replace(/^[\s\S]*?ГПВ\s+на/i, ''), now)
      if (!day) throw new OutageError('parse', `Lviv ${item.name}: cancellation notice without a date`, { region })
      const groups: Record<GroupId, DaySchedule> = {}
      for (const g of STANDARD_GROUPS) groups[g] = { date: day, status: 'no-outages', intervals: [] }
      keep(day, updatedAtOf(description), groups)
    } else if (item.imageUrl?.trim()) {
      // before 30.10.2025 LOE published only a picture; text parsing can't read that
      throw new OutageError('parse', `Lviv ${item.name}: the schedule is published only as an image`, { region })
    }
    // otherwise the slot is empty: nothing published
  }

  const dates = [...days.keys()].sort()
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

/** "Інформація станом на 18:56 17.10.2026" (Kyiv time) → ISO. */
function updatedAtOf(text: string): string | null {
  const m = /станом\s+на\s+(\d{1,2}:\d{2}\s+\d{2}\.\d{2}\.\d{4})/i.exec(text)
  return m ? parseUaDateTime(m[1]) : null
}
