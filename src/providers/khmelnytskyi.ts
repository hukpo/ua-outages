import { siteInput } from '../ai/posts.js'
import type { PostInput } from '../ai/types.js'
import { htmlToText } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { emergencyQueues } from '../emergency/queues.js'
import { compareGroups, normalizeGroup, STANDARD_GROUPS } from '../schedule.js'
import { addDays, kyivDate, kyivInstant, toKyivIso } from '../time.js'
import { normalizeSettlement, normalizeStreet } from '../text.js'
import type { City, EmergencyQueues, GroupId, GroupMatch, ProviderInfo } from '../types.js'
import { mapLimit } from '../util.js'
import { scheduleFromImages, type DatedImages } from './image-schedule.js'
import {
  daysToSource,
  readChannelPosts,
  readSchedulePosts,
  statedTime,
  type PostDay,
  type PostsOptions,
} from './posts.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'

/**
 * Khmelnytskoblenergo (hoe.com.ua). The hourly schedule is published as text, "Підчерга 1.1 –
 * 10:00-15:00; 18:00-21:00.", one block per announcement with the newest on top, in three
 * places: the operator's Telegram channel (first), a news post per day, and the schedule page,
 * which has shown only yesterday's blocks past midnight while the other two had today's. All
 * three are read by the client's text processor. An update lists only the hours from the time
 * it takes effect ("оновлено з 15:00"), so a day is its first announcement with the updates
 * layered on top. Older schedules were PNG tables: the archive page lists every image with its
 * date, read by the image processor. A date in the page's text wins over its images.
 *
 * The address lookup is a jQuery autocomplete chain: settlements → streets → houses →
 * `POST /shutdown-queues` (an HTML snippet with subgroups). The endpoints answer only to XHR
 * requests (`X-Requested-With`), otherwise 404.
 */
const SITE = 'https://hoe.com.ua'

const INFO: ProviderInfo = {
  id: 'khmelnytskyi',
  name: 'Хмельницька область',
  operator: 'Хмельницькобленерго',
  website: `${SITE}/page/pogodinni-vidkljuchennja`,
  capabilities: { schedule: true, addressSearch: true },
}

const NEWS = `${SITE}/post/novini-kompaniji`
const CHANNEL = 'khmelnytskoblenergo'

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
    remoteSearch: { cities: true, streets: true },
    sampleAddress: { city: 'Хмельницький', street: 'вул. Проскурівська', house: '2' },

    getSchedules: (ctx) =>
      mergeSources(
        ctx,
        region,
        [
          { id: 'site', url: INFO.website, read: readSite },
          { id: 'news', url: NEWS, read: readNews },
          {
            id: `telegram:@${CHANNEL}`,
            url: `https://t.me/s/${CHANNEL}`,
            read: async (ctx) => (await readChannelPosts(ctx, region, CHANNEL, CHANNEL_POSTS)).read,
          },
        ],
        // nothing published anywhere: the twelve subgroups stay listed, with today `unknown`
        { groups: STANDARD_GROUPS },
      ),

    async searchCities(ctx, query) {
      // the trailing slash is required; the term is a case-insensitive substring
      const found = await list<Option>(
        ctx,
        `/settlements/?term=${encodeURIComponent(searchTerm(normalizeSettlement(query)))}`,
      )
      return found.map((o) => parseSettlement(o))
    },

    async searchStreets(ctx, query, city) {
      if (!city) throw new OutageError('not-found', `${INFO.name}: pick a city first`, { region })
      // an empty term returns only the first 30 streets, so always send a word of the name
      const found = await list<Option>(
        ctx,
        `/streets/${city.id}?term=${encodeURIComponent(searchTerm(normalizeStreet(query)))}`,
      )
      return found.map((o) => ({ id: String(o.id), name: o.text.trim(), cityId: city.id }))
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
      const emergency = parseEmergencyQueues(html)
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
        ...(emergency ? { emergency } : {}),
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
 * The ГАВ alert of the `/shutdown-queues` snippet: "… (ГАВ) ваша адреса відноситься до черги:
 * <strong>8, 8, 3</strong>". Often empty (`<strong></strong>`): no ГАВ queue known. Exported for tests.
 */
export function parseEmergencyQueues(html: string): EmergencyQueues | undefined {
  const gav = /\(ГАВ\)[^<]*<strong>([^<]*)<\/strong>/.exec(html)
  return gav ? emergencyQueues({ gav: [gav[1]] }) : undefined
}

/**
 * The longest piece of a normalized name, for the server's substring search. Apostrophes are
 * split off because the operator stores "’" while people type "'" ("Кам’янецька").
 */
function searchTerm(normalized: string): string {
  return normalized.split(/[\s']+/).sort((a, b) => b.length - a.length)[0] ?? ''
}

/**
 * The newest image per date from the archive page, for `from` and later. Links look like
 * `/Content/Uploads/2026/10/file20261017164437203.png` "Графік погодинних відключень 17.10.2026
 * (оновлено, 16:50)"; the file name carries the upload time (Kyiv), which orders updates.
 * Exported for tests.
 */
export function latestImages(html: string, from: string): DatedImages[] {
  const byDate = new Map<string, { date: string; path: string; at: Date }[]>()
  const re = /<a href="(\/Content\/Uploads\/[^"]+?file(\d{8})(\d{6})\d*\.png)"[^>]*>([^<]*)/g
  for (const m of html.matchAll(re)) {
    const d = /(\d{2})\.(\d{2})\.(\d{4})/.exec(m[4]!)
    if (!d) continue
    const date = `${d[3]}-${d[2]}-${d[1]}`
    if (date < from) continue
    const f = m[2]!
    const t = m[3]!
    const at = kyivInstant(
      `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`,
      Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4)),
    )
    const list = byDate.get(date) ?? []
    list.push({ date, path: m[1]!, at })
    byDate.set(date, list)
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({ date, images: list.sort((a, b) => b.at.getTime() - a.at.getTime()) }))
}

/** Announcements on the site have no time of their own: the page order is theirs */
const TEXT: PostsOptions = { omitted: 'none', groups: STANDARD_GROUPS, updates: 'layer', timeless: true }
/** …while each Telegram post has its own time */
const CHANNEL_POSTS: PostsOptions = { omitted: 'none', groups: STANDARD_GROUPS, updates: 'layer' }

/**
 * The text announcements of a page (the schedule page or a day's news post), newest first, as
 * plain text: they are separated by <hr>. Exported for tests.
 */
export function announcements(html: string): string[] {
  const start = html.indexOf('class="post"')
  if (start === -1) return []
  const ends = ['Перевірити чергу', 'class="page__arrows-wrapper"', 'class="content-sidebar"']
    .map((m) => html.indexOf(m, start))
    .filter((i) => i !== -1)
  // from the end of the tag that holds class="post"
  const body = html.indexOf('>', start) + 1
  return html
    .slice(body, ends.length ? Math.min(...ends) : undefined)
    .split(/<hr\b[^>]*>/i)
    .map((block) => htmlToText(block))
    .filter(Boolean)
}

/** Announcements → inputs; read against today's noon (stable through the day: analysed once) */
function inputsOf(blocks: readonly string[], url: string, now: Date): PostInput[] {
  const reference = toKyivIso(kyivInstant(kyivDate(now), 12 * 60))
  return blocks.map((text) => siteInput({ site: url, title: null, text, publishedAt: reference }, INFO.id))
}

/** Announcements → what they say per date, with the operator's own time of the newest one */
async function announced(ctx: ProviderContext, inputs: PostInput[], from: string): Promise<SourceRead> {
  const now = ctx.now()
  const { days, analyzed } = await readSchedulePosts(ctx, INFO.id, inputs, TEXT)
  for (const date of [...days.keys()]) if (date < from) days.delete(date)
  return daysToSource(days, {
    ...TEXT,
    publishedAt: (day: PostDay, date) => {
      const a = analyzed[day.post]?.analysis
      return a ? statedTime(a, INFO.id, date, now) : null
    },
  })
}

/** The schedule page (text) and, for dates it has no text for, the archive's images */
async function readSite(ctx: ProviderContext): Promise<SourceRead> {
  const region = INFO.id
  const now = ctx.now()
  const from = addDays(kyivDate(now), -1)
  const [page, archive] = await Promise.all([
    ctx.http.text(INFO.website, { region }),
    ctx.http.text(`${SITE}/page/arhiv-grafikiv-pogodinnih-vidkljuchen-${kyivDate(now).slice(0, 4)}`, {
      region,
    }),
  ])
  const read = await announced(ctx, inputsOf(announcements(page), INFO.website, now), from)
  for (const d of latestImages(archive, from)) {
    if (read.days[d.date]) continue
    // one date at a time: `updatedAt` is then the upload time of the image read for that date
    const s = await scheduleFromImages(ctx, region, [d], (path) => `${SITE}${path}`)
    const schedules: SourceRead['days'][string]['schedules'] = {}
    for (const g of s.groups) schedules[g] = s.schedules[g]![0]!
    read.days[d.date] = { schedules, publishedAt: s.updatedAt }
  }
  return read
}

/**
 * The news list → the newest posts about the hourly schedule ("Прогноз ГПВ на 17 листопада"),
 * newest first. The slugs vary, so the links come from the list; a keyword in the title only
 * picks which pages to fetch, the processor reads them. Exported for tests.
 */
export function newsLinks(html: string): string[] {
  const links = [...html.matchAll(/<div class="heading">\s*<a href="(\/post\/[^"]+)"[^>]*>([^<]*)<\/a>/g)]
  if (!links.length)
    throw new OutageError('parse', 'Khmelnytskyi: no posts in the news list', { region: INFO.id, url: NEWS })
  return links.filter(([, , title]) => /ГПВ|погодинн/i.test(title!)).map(([, path]) => path!)
}

/** The day's news posts: the same announcements as the schedule page, published earlier */
async function readNews(ctx: ProviderContext): Promise<SourceRead> {
  const region = INFO.id
  const now = ctx.now()
  const links = newsLinks(await ctx.http.text(NEWS, { region })).slice(0, 3)
  const pages = await mapLimit(links, 2, (path) => ctx.http.text(`${SITE}${path}`, { region }), ctx.signal)
  return announced(
    ctx,
    pages.flatMap((html, i) => inputsOf(announcements(html), `${SITE}${links[i]}`, now)),
    kyivDate(now),
  )
}
