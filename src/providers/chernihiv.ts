import { SECTIGO_DV_R36 } from '../certs.js'
import { readChannelWindow, type TelegramPost } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { isCardPoster, readCardPoster, type CardLayout, type CardPoster } from '../image/cards.js'
import { decodeJpeg, isJpeg } from '../image/jpeg.js'
import { decodePng, type RgbaImage } from '../image/png.js'
import { STANDARD_GROUPS } from '../image/table.js'
import { makeDay, type MinuteSlot } from '../schedule.js'
import { addDays, kyivDate, kyivInstant, kyivMinuteOfDay, parseClock, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, ProviderInfo, RegionSchedule } from '../types.js'
import { mapLimit } from '../util.js'
import { chernihivAddresses } from './chernihiv-addresses.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'

/**
 * Chernihivoblenergo. The schedule API needs a captcha token on every request, but the same
 * schedule is published openly as a poster of twelve orange cards, one per group, listing
 * "HH:MM - HH:MM" off times (or "відключень не прогнозується"). The SDK reads the digits off
 * the poster itself by matching them against the poster font (src/image/cards.ts).
 *
 * The poster comes out on two channels, read together (`mergeSources`):
 * - the operator's Telegram channel gets tomorrow's poster the evening before (20:22–23:18 on 16
 *   of 16 days in November 2026), a re-issued poster ("ОНОВЛЕНИЙ") when a day changes a lot,
 *   and short changes in words during the day; the picture is a 471 px copy;
 * - the site's `schedule_groups.jpg` (1200 px) is overwritten with the day's poster only in the
 *   morning of that day (07:15–08:05) and not touched again. What is uploaded is the evening's
 *   poster as it was (16.11.2026: the cards of post 5718, after the channel had changed the day
 *   at 07:14), so the upload is no new publication: a file that shows a poster of the channel
 *   is as old as that post, and every change the channel made since stands over it.
 */
const IMAGE = 'https://chernihivoblenergo.com.ua/files/other/schedule_groups.jpg'
const CHANNEL = 'chernigivoblenergo'
const CHANNEL_URL = `https://t.me/s/${CHANNEL}`

const INFO: ProviderInfo = {
  id: 'chernihiv',
  name: 'Чернігівська область',
  operator: 'Чернігівобленерго',
  website: 'https://chernihivoblenergo.com.ua',
  capabilities: { schedule: true, addressSearch: true },
}

export const CHERNIHIV_POSTER: CardLayout = {
  cards: 12,
  // light orange, rgb(250, 200, 160)
  isCard: (r, g, b) => r > 215 && g > 160 && g < 225 && b > 110 && b < 195 && r - b > 50,
  // black times; the blue group labels are left out
  isInk: (r, g, b) => Math.max(r, g, b) < 110 && b - r < 50,
  // dark blue date
  isHeaderInk: (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b < 120,
  // red "ОНОВЛЕНИЙ" right of the date
  isStamp: (r, g, b) => r > 150 && g < 110 && b < 110 && r - Math.max(g, b) > 70,
}

export function chernihivProvider(): Provider {
  return {
    info: INFO,
    ...chernihivAddresses(INFO.id, INFO.operator),
    getSchedules(ctx) {
      // read once: a source of its own, and what tells the site's file from a new publication
      let channel: Promise<ChannelRead> | undefined
      const telegram = () => (channel ??= readChannel(ctx))
      return mergeSources(
        ctx,
        INFO.id,
        [
          { id: 'site', url: IMAGE, read: (ctx) => readSite(ctx, telegram) },
          { id: `telegram:@${CHANNEL}`, url: CHANNEL_URL, read: telegram },
        ],
        { groups: STANDARD_GROUPS },
      )
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The poster

const decodeImage = (bytes: Uint8Array) => (isJpeg(bytes) ? decodeJpeg(bytes) : decodePng(bytes))

const parseError = (message: string, url: string, cause?: unknown) =>
  new OutageError('parse', `Chernihiv poster: ${message}`, { region: INFO.id, url, cause })

function readPoster(image: () => RgbaImage, url: string): CardPoster {
  try {
    return readCardPoster(image(), CHERNIHIV_POSTER)
  } catch (cause) {
    throw parseError((cause as Error).message, url, cause)
  }
}

// a card without times says "відключень не прогнозується"
const toDay = (date: string, slots: readonly MinuteSlot[]) =>
  makeDay(date, slots, slots.length ? undefined : 'no-outages')

/** Poster image → schedule of the day in its header. Exported for tests. */
export function parseChernihivPoster(
  bytes: Uint8Array,
  now: Date,
  modified: Date | null = null,
): RegionSchedule {
  const poster = readPoster(() => decodeImage(bytes), IMAGE)
  const date = poster.date
  // a misread date would put the schedule on the wrong day; posters are for yesterday … tomorrow
  const today = kyivDate(now)
  if (!date || date < addDays(today, -2) || date > addDays(today, 2))
    throw parseError(`no current date in the header (read ${date ?? 'nothing'})`, IMAGE)
  const schedules: Record<string, DaySchedule[]> = {}
  STANDARD_GROUPS.forEach((g, i) => (schedules[g] = [toDay(date, poster.cards[i]!)]))
  return {
    region: INFO.id,
    groups: [...STANDARD_GROUPS],
    schedules,
    updatedAt: modified ? toKyivIso(modified) : null,
    fetchedAt: toKyivIso(now),
  }
}

// ---------------------------------------------------------------------------------------------
// The site

async function readSite(ctx: ProviderContext, telegram: () => Promise<ChannelRead>): Promise<SourceRead> {
  // the server omits its intermediate certificate
  const { bytes, headers } = await ctx.http.file(IMAGE, { region: INFO.id, ca: [SECTIGO_DV_R36] })
  const modified = Date.parse(headers.get('last-modified') ?? '')
  const s = parseChernihivPoster(bytes, ctx.now(), Number.isNaN(modified) ? null : new Date(modified))
  const schedules: Record<GroupId, DaySchedule> = {}
  for (const g of s.groups) schedules[g] = s.schedules[g]![0]!
  const date = schedules[s.groups[0]!]!.date
  const today = kyivDate(ctx.now())
  // until the morning upload the file is still yesterday's poster: nothing for today here
  if (date < today) return { days: {}, groups: s.groups }
  // the file is uploaded on the morning of its day, at the earliest the evening before
  const uploaded = s.updatedAt ? kyivDate(new Date(s.updatedAt)) : today
  if (date > addDays(uploaded, 1))
    throw parseError(`the header reads ${date}, the file is of ${s.updatedAt ?? today}`, IMAGE)
  // the channel being down is its own failure; the file then has only its upload time
  const known = await telegram().catch(() => {
    ctx.signal?.throwIfAborted()
    return null
  })
  // the same poster the channel posted (the newest such): published then, not at the upload,
  // so a change the channel made in between isn't overridden by the older picture
  const poster = known?.posters[date]?.filter((p) => sameTimes(p.schedules, schedules)).at(-1)
  return {
    days: { [date]: { schedules, publishedAt: poster ? poster.publishedAt : s.updatedAt } },
    groups: s.groups,
  }
}

/** Two readings of a day list the same outages for every group */
const sameTimes = (a: Record<GroupId, DaySchedule>, b: Record<GroupId, DaySchedule>) =>
  STANDARD_GROUPS.every((g) => JSON.stringify(a[g]?.intervals) === JSON.stringify(b[g]?.intervals))

/** The channel's days, and every poster it posted per date (oldest first) as it was drawn */
export type ChannelRead = SourceRead & {
  posters: Record<string, { publishedAt: string; schedules: Record<GroupId, DaySchedule> }[]>
}

// ---------------------------------------------------------------------------------------------
// The Telegram channel

/** The post says its picture is a schedule poster: that picture has to be read, or nothing is */
const ANNOUNCES = /діятиме\s+Графік\S*\s+погодинних|значні\s+зміни\s+у\s+Графіку\s+погодинних/iu
/** "… маємо зміни у Графіку погодинних відключень (ГПВ) на 16 листопада": changes to a day's poster, in words */
const CHANGES = /маємо\s+зміни\s+у\s+Графіку\s+погодинних\s+відключень[^\n]*?\sна\s+(\d[^\n]*)/iu
const MONTHS = [
  'січня',
  'лютого',
  'березня',
  'квітня',
  'травня',
  'червня',
  'липня',
  'серпня',
  'вересня',
  'жовтня',
  'листопада',
  'грудня',
]
const MONTH = MONTHS.join('|')
const DATES = new RegExp(`^((?:\\d{1,2}(?:\\s*(?:,|та|і|й|-|–)\\s*)?)+)\\s*(${MONTH})`, 'iu')
const DAY_AHEAD = new RegExp(`(\\d{1,2}\\s+(?:${MONTH}))\\s+в\\s+області\\s+діятиме`, 'iu')
const pad = (n: number) => String(n).padStart(2, '0')

/** "3 та 4 листопада" → the dates, in the year that puts them next to `near` ("YYYY-MM-DD") */
function namedDates(text: string, near: string): string[] {
  const m = DATES.exec(text.trim())
  if (!m) return []
  const month = MONTHS.indexOf(m[2]!.toLowerCase()) + 1
  const year = Number(near.slice(0, 4))
  return [...m[1]!.matchAll(/\d{1,2}/g)].flatMap((d) => {
    const date = [year - 1, year, year + 1]
      .map((y) => `${y}-${pad(month)}-${pad(Number(d[0]))}`)
      .find((c) => c >= addDays(near, -180) && c <= addDays(near, 180))
    // "31 листопада" is no date
    return date && addDays(date, 0) === date ? [date] : []
  })
}

/** A day as the channel has it so far: the times of each card, and the post that last changed them */
interface ChannelDay {
  cards: MinuteSlot[][]
  publishedAt: string
  /**
   * Groups (as card indexes) a change in words left in a state that isn't known at all, see
   * `amend`: their day is `unknown` from then on, until the next poster
   */
  open: Set<number>
  /**
   * Per card, the time after an outage a change post started without saying when it ends
   * (`maybe`), see `amend`
   */
  started: MinuteSlot[][]
}

/** Sorted, and joined where they touch or overlap */
function joined(slots: readonly MinuteSlot[]): MinuteSlot[] {
  const out: MinuteSlot[] = []
  for (const s of [...slots].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/**
 * A re-issued poster ("ОНОВЛЕНИЙ") lists only the rest of its day: on 02.11.2026, posted at
 * 14:48, every card began at 14:30 or later, and the outages running then were cut to start at
 * 14:30. What the earlier poster had before that moment is kept, the rest is replaced.
 */
function layer(
  base: ChannelDay,
  poster: MinuteSlot[][],
  posted: number,
): Pick<ChannelDay, 'cards' | 'started'> {
  const cut = Math.min(posted, ...poster.flat().map((s) => s.start))
  const before = (slots: MinuteSlot[]) =>
    slots.filter((s) => s.start < cut).map((s) => ({ ...s, end: Math.min(s.end, cut) }))
  return {
    cards: poster.map((later, i) =>
      joined([
        ...before(base.cards[i]!),
        ...later.filter((s) => s.end > cut).map((s) => ({ ...s, start: Math.max(s.start, cut) })),
      ]),
    ),
    // a stretch a change post started before then stays what it was
    started: base.started.map(before),
  }
}

const clock = (text: string | undefined) => (text ? parseClock(text.replace('.', ':')) : null)

/**
 * Applies a change post to the day, as far as its words are exact:
 * - "З 6:00 до 8:00 додатково відключаються черги 1/1 та 1/2": that outage is added;
 * - "До 17:00 продовжується відключення для черг 4/1 та 4/2": the last outage of the poster
 *   that begins before 17:00 ends at 17:00, if it is running when the post comes or still ahead.
 *   A "продовжується" that fits no outage of the poster (15.11.2026 00:11, "До 01:00
 *   продовжується …", an outage running over from the day before) is an outage from the post
 *   to that time, when the post is of the day itself.
 * - "З 07:15 починається відключення для черг 5/1 та 5/2" doesn't say when it ends, and
 *   "З 22:00 відключаються …" neither. No end is invented: the poster's outages stay, and the
 *   time from 07:15 to the poster's next outage of the group (to midnight when there is none)
 *   is `maybe`: the power went off at 07:15 and may be back at any moment of it. A
 *   "продовжується" posted while that stretch runs is its end: off from 07:15 to then.
 *
 * A group is `open`, its day not known until the next poster (as in `cek-telegram.ts`), when a
 * line about it can't be read this way: a start inside an outage the day already has (the
 * poster's or a started one: the power came back in between, when isn't said), an end already
 * past or one the poster's outage already passes, a line with neither.
 *
 * With `exact: false` (a post for two days, which doesn't say which line is for which) nothing
 * is applied and every group a line names is open. `live`: the post is of the day itself.
 */
function amend(day: ChannelDay, text: string, posted: number, exact = true, live = true): void {
  for (const line of text.split('\n')) {
    const groups = [...line.matchAll(/(?<![\d/.:])([1-6])\/([12])(?![\d/])/g)].map((m) =>
      STANDARD_GROUPS.indexOf(`${m[1]}.${m[2]}`),
    )
    if (!groups.length) {
      // a line with a time and no group that can be told: it may be about any of them
      if (/\d{1,2}[:.]\d{2}/.test(line) && /черг/iu.test(line))
        STANDARD_GROUPS.forEach((_, i) => day.open.add(i))
      continue
    }
    const added = /з\s+(\d{1,2}[:.]\d{2})\s+до\s+(\d{1,2}[:.]\d{2})\s+(?:додатково\s+)?відключа/iu.exec(line)
    const until = added ? null : /до\s+(\d{1,2}[:.]\d{2})\s+продовжується,?\s+відключення/iu.exec(line)
    const begun =
      added || until
        ? null
        : /(?<![\p{L}\d])з\s+(\d{1,2}[:.]\d{2})\s+(?:починається\s+відключення|відключа[єю]ться)(?![^\n]*\sдо\s+\d)/iu.exec(
            line,
          )
    const start = clock(added?.[1] ?? begun?.[1])
    // "до 00:00" is midnight at the end of the day
    const end = clock(added?.[2] ?? until?.[1]) || (added || until ? 1440 : null)
    for (const g of groups) {
      const slots = day.cards[g]!
      if (exact && added && start !== null && end !== null && start < end) {
        day.cards[g] = joined([...slots, { start, end, kind: 'off' }])
        continue
      }
      if (exact && begun && start !== null) {
        const running = [...slots, ...day.started[g]!].some((s) => s.start < start && start < s.end)
        const next = slots.find((s) => s.start >= start)?.start ?? 1440
        if (running) day.open.add(g)
        // the same start posted again is the same outage
        else if (next > start && !day.started[g]!.some((s) => s.start === start))
          day.started[g]!.push({ start, end: next, kind: 'maybe' })
        continue
      }
      if (!exact || !until || end === null) {
        day.open.add(g)
        continue
      }
      // an outage a post started is running now: this is its end, and it was off all along
      const running = live ? day.started[g]!.find((s) => s.start <= posted && posted < s.end) : undefined
      if (running) {
        day.started[g] = day.started[g]!.filter((s) => s.start !== running.start)
        if (posted < end) day.cards[g] = joined([...slots, { start: running.start, end, kind: 'off' }])
        else day.open.add(g)
        continue
      }
      // a started stretch still ahead (or on a day after the post's) before that end: whether the
      // outage that goes on is that one or the poster's isn't said
      if (day.started[g]!.some((s) => s.start < end && s.end > posted)) {
        day.open.add(g)
        continue
      }
      const last = slots.filter((s) => s.start < end).at(-1)
      if (last && last.end >= posted && last.end < end) {
        last.end = end
        day.cards[g] = joined(slots)
      } else if (live && posted < end && (!last || last.end < posted)) {
        // no outage of the poster is running or ahead: the one that goes on isn't in it
        day.cards[g] = joined([...slots, { start: posted, end, kind: 'off' }])
      } else day.open.add(g)
    }
  }
}

/**
 * The day a poster of the channel is for. The header decides, never the post time; still a
 * poster is for the day it is posted on or the next one, and its caption names the same day.
 * A header that isn't read with confidence (a digit the date's typography has rarely shown)
 * counts when its most likely reading is the very day the caption names. Exported for tests.
 */
export function posterDay(
  poster: Pick<CardPoster, 'date' | 'dateGuess'>,
  post: Pick<TelegramPost, 'text' | 'url'>,
  postDate: string,
): string {
  const changes = CHANGES.exec(post.text)
  const named = DAY_AHEAD.exec(post.text)?.[1] ?? changes?.[1]
  const dates = named ? namedDates(named, postDate) : []
  // "сьогодні маємо значні зміни у Графіку …": the re-issue of the day
  const said =
    dates.length === 1 ? dates[0] : /сьогодні\s+маємо\s+значні\s+зміни/iu.test(post.text) ? postDate : null
  const date = poster.date ?? (said && poster.dateGuess === said ? said : null)
  if (!date || (date !== postDate && date !== addDays(postDate, 1)))
    throw parseError(
      `no date in the header that fits a post of ${postDate} (read ${poster.date ?? `nothing for sure, perhaps ${poster.dateGuess}`})`,
      post.url,
    )
  if (said && said !== date)
    throw parseError(
      `the header reads ${date}, the post says ${named ? `"${named.trim()}"` : 'today'}`,
      post.url,
    )
  return date
}

/**
 * The channel's posts, each with its pictures (or why one couldn't be loaded) → every day the
 * channel has published, from `today` on. Exported for tests.
 */
export function chernihivChannelDays(
  posts: readonly { post: TelegramPost; photos: readonly (Uint8Array | Error)[] }[],
  today: string,
): ChannelRead {
  const days = new Map<string, ChannelDay>()
  const posters: ChannelRead['posters'] = {}
  let url: string | undefined
  for (const { post, photos } of [...posts].sort((a, b) => a.post.id - b.post.id)) {
    const at = new Date(post.at)
    const postDate = kyivDate(at)
    const announces = ANNOUNCES.test(post.text)
    for (const photo of photos) {
      let img: RgbaImage | null = null
      if (!(photo instanceof Error))
        try {
          img = decodeImage(photo)
        } catch {
          img = null
        }
      // every other picture of the channel is a landscape banner or a photograph
      if (!img || img.height <= img.width || !isCardPoster(img, CHERNIHIV_POSTER)) {
        // a poster that can't be seen may be newer than every one that can: an older one must
        // not pass for the current schedule
        if (announces)
          throw parseError(
            photo instanceof Error
              ? `the picture of a schedule post couldn't be loaded (${photo.message})`
              : 'the picture of a schedule post is not the poster of twelve cards',
            post.url,
            photo instanceof Error ? photo : undefined,
          )
        continue
      }
      const poster = readPoster(() => img, post.url)
      const date = posterDay(poster, post, postDate)
      const drawn: Record<GroupId, DaySchedule> = {}
      STANDARD_GROUPS.forEach((g, i) => (drawn[g] = toDay(date, poster.cards[i]!)))
      ;(posters[date] ??= []).push({ publishedAt: post.at, schedules: drawn })
      const base = days.get(date)
      const { cards, started } =
        poster.stamped && base
          ? layer(base, poster.cards, date === postDate ? kyivMinuteOfDay(at) : 0)
          : { cards: poster.cards, started: poster.cards.map(() => []) }
      days.set(date, { cards, publishedAt: post.at, open: new Set(), started })
      url = post.url
    }
    const changes = CHANGES.exec(post.text)
    if (!changes) continue
    const dates = namedDates(changes[1]!, postDate)
    for (const date of dates) {
      const day = days.get(date)
      if (!day) continue
      // which line is for which day isn't said when the post is for two
      amend(
        day,
        post.text,
        date === postDate ? kyivMinuteOfDay(at) : 0,
        dates.length === 1,
        date === postDate,
      )
      // applied or not, the poster is no longer the last word on this day
      day.publishedAt = post.at
      url = post.url
    }
  }
  const out: ChannelRead = { days: {}, groups: [...STANDARD_GROUPS], url, posters }
  for (const [date, day] of days) {
    if (date < today) continue
    const schedules: Record<GroupId, DaySchedule> = {}
    STANDARD_GROUPS.forEach(
      (g, i) =>
        // a change that couldn't be applied: neither the poster's hours nor a guess
        (schedules[g] = day.open.has(i)
          ? { date, status: 'unknown', intervals: [] }
          : toDay(date, [...day.cards[i]!, ...day.started[i]!])),
    )
    out.days[date] = { schedules, publishedAt: day.publishedAt }
  }
  return out
}

async function readChannel(ctx: ProviderContext): Promise<ChannelRead> {
  const region = INFO.id
  const today = kyivDate(ctx.now())
  // today's poster came yesterday evening
  const since = kyivInstant(addDays(today, -1), 12 * 60)
  const { posts, from } = await readChannelWindow(ctx, CHANNEL, { region, since, withPhotoOnly: true })
  if (Date.parse(from) > since.getTime())
    throw new OutageError(
      'parse',
      `Telegram @${CHANNEL}: the posts since ${toKyivIso(since)} couldn't all be read (only from ${from})`,
      { region, url: CHANNEL_URL },
    )
  // CDN links expire: the pictures are fetched right after the page
  const loaded = await mapLimit(
    posts,
    4,
    async (post) => ({
      post,
      photos: await Promise.all(
        post.photos.map((url) =>
          ctx.http.bytes(url, { region }).catch((e: unknown) => {
            ctx.signal?.throwIfAborted()
            return e instanceof Error ? e : new Error(String(e))
          }),
        ),
      ),
    }),
    ctx.signal,
  )
  return chernihivChannelDays(loaded, today)
}
