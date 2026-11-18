import { toSlots } from '../ai/map.js'
import { analyzeAll, channelInputs, failIfNewestUnread } from '../ai/posts.js'
import type { PostEvent } from '../ai/types.js'
import { readChannelWindow, type TelegramPost } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { cellsToIntervals, compareGroups, makeDay } from '../schedule.js'
import { matchScore, normalizeHouse, normalizeSettlement, normalizeStreet, streetType } from '../text.js'
import { addDays, kyivDate } from '../time.js'
import type {
  City,
  DaySchedule,
  GroupId,
  GroupMatch,
  House,
  IntervalKind,
  ProviderInfo,
  Street,
} from '../types.js'
import { gpvEvents } from './posts.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'
import { mapLimit } from '../util.js'

/**
 * Chernivtsioblenergo. Two channels of the operator, merged per day:
 *
 * - `site` (oblenergo.cv.ua): server-rendered HTML with 48 half-hour cells per group;
 *   `/shutdowns/` shows today and `/shutdowns/?next` tomorrow. The page has no change time: its
 *   "актуальний станом на 0:30" is a half-hour mark that moves by itself;
 * - `telegram:@oe_cv_ua`: the operator posts every version of a day's schedule there, so the
 *   time of the newest post about a date is when that date last changed. That is the change
 *   time given to the site's days, unless that post states the day in words and the page shows
 *   something else: then the page is behind it and has no time at all. Until 15.11.2026 the
 *   posts carried the schedule as text, since then as pictures: text (read by the client's text
 *   processor) is a second copy of the day, pictures only the clock (a page behind a picture
 *   post can't be told).
 *
 * Groups are numbered 1–12 (not 1.1–6.2) and kept as the operator names them.
 *
 * Address search has no API: `/shutdowns-search/<district>/` renders a district's whole
 * directory (~21k rows) and the page filters it in the browser. We do the same — each
 * district is fetched once per provider instance and indexed in memory.
 */
const SITE = 'https://oblenergo.cv.ua'
const CHANNEL = 'oe_cv_ua'
const GROUPS: readonly GroupId[] = Array.from({ length: 12 }, (_, i) => String(i + 1))
/**
 * How far back the channel is read. The newest post about today is from yesterday evening at
 * the earliest (20:00–23:00), and posts come newest first, so two pages always reach it.
 */
const CHANNEL_LOOKBACK_MS = 36 * 3600_000
const CHANNEL_PAGES = 2

const INFO: ProviderInfo = {
  id: 'chernivtsi',
  name: 'Чернівецька область',
  operator: 'Чернівціобленерго',
  website: `${SITE}/shutdowns/`,
  capabilities: { schedule: true, addressSearch: true },
}

/** `<u>з</u>` заживлені (on) · `<o>в</o>` відключені · `<s>мз</s>` можливо заживлені */
const CELL: Record<string, IntervalKind | null> = { u: null, o: 'off', s: 'maybe' }

/** Districts ("дільниці") of `/shutdowns-search/<id>/`; 1 is the city of Chernivtsi. */
const DISTRICTS: readonly { id: number; name: string }[] = [
  { id: 1, name: 'Чернівці' },
  { id: 2, name: 'Вижницька' },
  { id: 3, name: 'Герцаївська' },
  { id: 4, name: 'Глибоцька' },
  { id: 5, name: 'Заставнівська' },
  { id: 6, name: 'Кіцманська' },
  { id: 7, name: 'Кельменецька' },
  { id: 8, name: 'Новоселицька' },
  { id: 9, name: 'Путильська' },
  { id: 10, name: 'Сокирянська' },
  { id: 11, name: 'Сторожинецька' },
  { id: 12, name: 'Хотинська' },
]

/** District directories are ~2 MB of HTML each; don't download all twelve at once. */
const DIRECTORY_CONCURRENCY = 3

/** One district, indexed: city → street → house → groups. */
interface Directory {
  cities: Map<string, CityEntry>
}
interface CityEntry {
  city: City
  streets: Map<string, StreetEntry>
  /** Directory rows, to tell a real settlement from a few stray rows elsewhere */
  rows: number
}
interface StreetEntry {
  street: Street
  houses: Map<string, { house: House; groups: Set<GroupId> }>
}

export function chernivtsiProvider(): Provider {
  const region = INFO.id
  const directories = new Map<number, Promise<Directory>>()
  let allCities: Promise<City[]> | null = null

  const directory = (ctx: ProviderContext, district: number) => {
    let dir = directories.get(district)
    if (!dir) {
      const name = DISTRICTS.find((d) => d.id === district)?.name ?? String(district)
      dir = ctx.http
        .text(`${SITE}/shutdowns-search/${district}/`, { region })
        .then((html) => parseDirectory(html, district, name))
      // a failed download shouldn't be cached
      dir.catch(() => directories.delete(district))
      directories.set(district, dir)
    }
    return dir
  }

  const cityEntry = async (ctx: ProviderContext, city: City | undefined) => {
    if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
    const entry = (await directory(ctx, districtOf(city.id))).cities.get(city.id)
    if (!entry) throw new OutageError('not-found', `${INFO.name}: unknown city ${city.name}`, { region })
    return entry
  }

  return {
    info: INFO,
    sampleAddress: { city: 'Чернівці', street: 'бульвар Героїв Крут', house: '10' },

    getSchedules(ctx) {
      // each channel is read once and both readers look at both: the site's days take their
      // change time from the channel, and the channel's text is compared with the site's cells
      const site = (async () => {
        const html = await ctx.http.text(`${SITE}/shutdowns/`, { region })
        const today = parseSchedulePage(html)
        // the link to tomorrow appears only once it is published
        if (!html.includes('href="/shutdowns/?next"')) return [today]
        const next = parseSchedulePage(await ctx.http.text(`${SITE}/shutdowns/?next`, { region }))
        // without a tomorrow `?next` is today's page again
        return next.date === today.date ? [today] : [today, next]
      })()
      const channel = readChannelWindow(ctx, CHANNEL, {
        region,
        since: new Date(ctx.now().getTime() - CHANNEL_LOOKBACK_MS),
        maxPages: CHANNEL_PAGES,
      }).then((read) => parseChannelPosts(ctx, read.posts))
      // both are awaited by both readers; a failure is reported there, not as an unhandled one
      site.catch(() => {})
      channel.catch(() => {})

      return mergeSources(
        ctx,
        region,
        [
          {
            id: 'site',
            url: INFO.website,
            async read() {
              const pages = await site
              // channel unreadable: the days are as good, only without a change time
              const known = await channel.catch(() => null)
              const days: SourceRead['days'] = {}
              for (const p of pages) {
                // the newest post about the date says something else in words (an all-clear, other
                // hours): the page doesn't show that publication, so it can't have its time. With
                // no time of its own it loses the day to the post
                const said = known?.text.get(p.date)
                const behind = !!said && !saysTheSame(said, p.days)
                days[p.date] = {
                  schedules: p.days,
                  publishedAt: behind ? null : (known?.clock.get(p.date) ?? null),
                }
              }
              return { days }
            },
          },
          {
            id: `telegram:@${CHANNEL}`,
            url: `https://t.me/s/${CHANNEL}`,
            async read() {
              const { clock, text } = await channel
              const pages = await site.catch(() => [])
              const days: SourceRead['days'] = {}
              const today = kyivDate(ctx.now())
              for (const [date, schedules] of text) {
                // the window reaches back into yesterday; a past day is of no use to anyone
                if (date < today) continue
                const page = pages.find((p) => p.date === date)
                days[date] = {
                  schedules: page && saysTheSame(schedules, page.days) ? page.days : schedules,
                  publishedAt: clock.get(date) ?? null,
                }
              }
              return { days }
            },
          },
        ],
        { groups: GROUPS },
      )
    },

    async searchCities(ctx, query) {
      // fast path: the city of Chernivtsi is district 1 alone, no need to download the other 11
      if (matchScore(query, CITY_NAME, 'settlement') === 1)
        return [...(await directory(ctx, 1)).cities.values()].map((c) => c.city)
      allCities ??= mapLimit(DISTRICTS, DIRECTORY_CONCURRENCY, (d) => directory(ctx, d.id)).then(
        nameDuplicates,
      )
      allCities.catch(() => (allCities = null))
      return allCities
    },

    async searchStreets(ctx, query, city) {
      const entry = await cityEntry(ctx, city)
      return [...entry.streets.values()].map((s) => s.street)
    },

    async searchHouses(ctx, street) {
      const city = { id: street.cityId ?? '', name: '' }
      const entry = (await cityEntry(ctx, city)).streets.get(street.id)
      return entry ? [...entry.houses.values()].map((h) => h.house) : []
    },

    async groupOf(ctx, house, street, city): Promise<GroupMatch> {
      const entry = await cityEntry(ctx, city ?? { id: street.cityId ?? '', name: '' })
      const hit = entry.streets.get(street.id)?.houses.get(house.id)
      if (!hit)
        throw new OutageError(
          'not-found',
          `${house.number}, ${street.name}: not in the operator's directory`,
          { region },
        )
      const [group, ...other] = [...hit.groups].sort(compareGroups)
      return {
        region,
        group: group!,
        ...(other.length ? { otherGroups: other } : {}),
        address: { city: entry.city.name, street: street.name, house: house.number },
      }
    },
  }
}

// --- schedule ---

/**
 * One `/shutdowns/` page → its day for every group, dated by the page's own date line, so a
 * page still showing another day is never read as today. Exported for tests.
 */
export function parseSchedulePage(html: string): { date: string; days: Record<GroupId, DaySchedule> } {
  const region = INFO.id
  const gsv = html.indexOf('<div id="gsv"')
  if (gsv === -1)
    throw new OutageError('parse', 'Chernivtsi: no schedule block (#gsv) on the page', { region })
  const block = html.slice(gsv)

  const dateText = /<ul>\s*<p>\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(block)
  if (!dateText) throw new OutageError('parse', 'Chernivtsi: no date in the schedule block', { region })
  const date = `${dateText[3]}-${dateText[2]}-${dateText[1]}`

  const days: Record<GroupId, DaySchedule> = {}
  const rows = [...block.matchAll(/<div id="inf(\d+)"[^>]*>([\s\S]*?)<\/div>/g)]
  if (!rows.length)
    throw new OutageError('parse', 'Chernivtsi: no group rows in the schedule block', { region })
  let anyOutage = false
  for (const [, group, inner] of rows) {
    const cells = [...inner!.matchAll(/<(u|o|s)>[^<]*<\/\1>/g)].map((m) => CELL[m[1]!]!)
    if (cells.length !== 48)
      throw new OutageError('parse', `Chernivtsi: group ${group} has ${cells.length} cells, expected 48`, {
        region,
      })
    if (cells.some((c) => c)) anyOutage = true
    days[String(Number(group))] = { date, status: 'scheduled', intervals: cellsToIntervals(date, cells) }
  }
  // a page that is all "з" means no outages for anyone that day
  if (!anyOutage) for (const d of Object.values(days)) d.status = 'no-outages'

  return { date, days }
}

// --- Telegram ---

/** What the channel says about the days it posted about. */
export interface ChannelDays {
  /** date → time of the newest post about that date's schedule: when the operator last changed it */
  clock: Map<string, string>
  /** date → the day as text, when the newest post about that date carries it as text */
  text: Map<string, Record<GroupId, DaySchedule>>
}

/**
 * Posts (oldest first) → the change clock and the text days, read by the client's text
 * processor. A post is about the day its `gpv` event names when that is the post's own day or the
 * next one; the channel has misdated a post before, and such a post is skipped. The text is
 * "графік заживлення", the hours WITH power; the processor gives the hours without. "На 13.11 /
 * Електропостачання без обмежень для всіх груп" is a day with no outages for anyone. A post
 * whose hours are only in its picture moves the clock and outdates the text of the day.
 *
 * Telegram shows when a post was made, not when it was edited, so an edited post keeps its
 * first time. Exported for tests.
 */
export async function parseChannelPosts(
  ctx: ProviderContext,
  posts: readonly TelegramPost[],
): Promise<ChannelDays> {
  const clock = new Map<string, string>()
  const text = new Map<string, Record<GroupId, DaySchedule>>()
  const sorted = [...posts].sort((a, b) => a.id - b.id)
  const analyzed = await analyzeAll(ctx, INFO.id, channelInputs(sorted, INFO.id))
  // a post that can't be read may be the newest version of a day: its clock and text are unknown
  failIfNewestUnread(analyzed, (a) => gpvEvents(a, INFO.id).length > 0)
  for (const { input, analysis } of analyzed) {
    if (!analysis) continue
    const posted = kyivDate(new Date(input.publishedAt))
    for (const ev of gpvEvents(analysis, INFO.id)) {
      const date = ev.date ?? posted
      if (date !== posted && date !== addDays(posted, 1)) continue
      clock.set(date, input.publishedAt)
      // only the newest post about a date counts: a picture after a text post outdates the text
      const days =
        ev.action === 'cancel' ? noOutages(date) : ev.schedule.length ? textDay(ev.schedule, date) : null
      if (days) text.set(date, days)
      else text.delete(date)
    }
  }
  return { clock, text }
}

const noOutages = (date: string): Record<GroupId, DaySchedule> =>
  Object.fromEntries(GROUPS.map((g) => [g, { date, status: 'no-outages' as const, intervals: [] }]))

/** A day as text → per group; null when a group is listed without hours (unread rather than misread) */
function textDay(schedule: PostEvent['schedule'], date: string): Record<GroupId, DaySchedule> | null {
  const days: Record<GroupId, DaySchedule> = {}
  let anyOutage = false
  for (const q of schedule) {
    if (!q.intervals) return null
    if (q.intervals.length) anyOutage = true
    days[q.queue] = makeDay(date, toSlots(q.intervals))
  }
  // like the page: nobody has an outage that day
  if (!anyOutage) for (const d of Object.values(days)) d.status = 'no-outages'
  return days
}

/**
 * The text and the page describe the same day: in every group of the text, the page's `off`
 * and `maybe` cells together are exactly the text's gaps. Then the page's richer day stands for
 * both and the channels don't count as disagreeing over the "maybe" half hours.
 */
function saysTheSame(text: Record<GroupId, DaySchedule>, page: Record<GroupId, DaySchedule>): boolean {
  const spans = (d: DaySchedule) => {
    const out: [string, string][] = []
    for (const i of d.intervals) {
      const last = out.at(-1)
      if (last && last[1] === i.from) last[1] = i.to
      else out.push([i.from, i.to])
    }
    return JSON.stringify(out)
  }
  return Object.entries(text).every(([g, d]) => page[g] && spans(page[g]) === spans(d))
}

// --- address directory ---

/** District 1's table has no settlement column: it is the city itself. */
const CITY_NAME = 'м. Чернівці'

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A `/shutdowns-search/<district>/` page → index. The city table (district 1) has rows
 * `<p>street</p><b>буд. N</b><u>group</u>`; the others add `<s>settlement</s>` first.
 * The same street or settlement is spelled in several cases ("м. ВИЖНИЦЯ" / "м. Вижниця"),
 * so entries are keyed by their normalized names. Exported for tests.
 */
export function parseDirectory(html: string, district: number, districtName: string): Directory {
  const region = INFO.id
  const table = /<div id="(city|obl)_tbl"[^>]*>([\s\S]*)/.exec(html)
  if (!table)
    throw new OutageError('parse', `Chernivtsi: no address table for district ${district}`, { region })
  const isCity = table[1] === 'city'
  const cities = new Map<string, CityEntry>()

  const rowRe = isCity
    ? /<div><p>([^<]*)<\/p><b>([^<]*)<\/b><u>([^<]*)<\/u><\/div>/g
    : /<div><s>([^<]*)<\/s><p>([^<]*)<\/p><b>([^<]*)<\/b><u>([^<]*)<\/u><\/div>/g
  for (const m of table[2]!.matchAll(rowRe)) {
    const [cityName, streetName, houseText, groupText] = isCity
      ? [CITY_NAME, m[1]!, m[2]!, m[3]!]
      : [m[1]!, m[2]!, m[3]!, m[4]!]
    const street = decode(streetName).trim()
    const number = decode(houseText)
      .replace(/^\s*буд\.?\s*/i, '')
      .trim()
    const group = /^\s*(\d{1,2})\s*$/.exec(groupText)?.[1]
    // the directory has leftover rows with GUIDs instead of names
    if (!street || !number || !group || GUID.test(street) || GUID.test(number)) continue

    const settlement = decode(cityName).trim()
    const cityId = `${district}:${normalizeSettlement(settlement)}`
    let c = cities.get(cityId)
    if (!c) {
      c = {
        city: { id: cityId, name: titleCase(settlement), district: districtName },
        streets: new Map(),
        rows: 0,
      }
      cities.set(cityId, c)
    }
    // "вул. X" and "пров. X" are different streets; "бульвар X" and "бульвар X БУЛЬВ." are not
    const streetId = `${cityId}|${streetType(street) ?? ''}|${normalizeStreet(street)}`
    let s = c.streets.get(streetId)
    if (!s) {
      s = { street: { id: streetId, name: street, cityId }, houses: new Map() }
      c.streets.set(streetId, s)
    }
    const houseId = normalizeHouse(number)
    let h = s.houses.get(houseId)
    if (!h) {
      h = { house: { id: houseId, number, streetId }, groups: new Set() }
      s.houses.set(houseId, h)
    }
    h.groups.add(String(Number(group)))
    c.rows++
  }
  if (!cities.size)
    throw new OutageError('parse', `Chernivtsi: address table for district ${district} has no rows`, {
      region,
    })
  return { cities }
}

/**
 * A settlement name can occur in several districts: namesakes, or a few stray rows (district
 * directories list some addresses of the city of Chernivtsi). The one with the most rows keeps
 * the plain name; the others get their district appended, so a plain query picks the main one
 * and "Чернівці (Глибоцька)" still reaches the rest.
 */
function nameDuplicates(dirs: Directory[]): City[] {
  const byName = new Map<string, CityEntry[]>()
  for (const d of dirs)
    for (const c of d.cities.values()) {
      const key = normalizeSettlement(c.city.name)
      byName.set(key, [...(byName.get(key) ?? []), c])
    }
  for (const list of byName.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => b.rows - a.rows)
    for (const c of list.slice(1)) c.city.name = `${c.city.name} (${c.city.district})`
  }
  return dirs.flatMap((d) => [...d.cities.values()].map((c) => c.city))
}

/** City id is "<district>:<name>". */
const districtOf = (cityId: string) => Number(cityId.split(':')[0])

/** "м. ВИЖНИЦЯ" → "м. Вижниця", "с. СЛОБОДА-БАНИЛІВ" → "с. Слобода-Банилів"; mixed case is kept. */
function titleCase(name: string): string {
  return name.replace(/[А-ЯІЇЄҐ][А-ЯІЇЄҐ'’]+/g, (w) => w[0] + w.slice(1).toLowerCase())
}

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
}
