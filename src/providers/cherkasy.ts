import { OutageError } from '../errors.js'
import { STANDARD_GROUPS } from '../image/table.js'
import { addDays, kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { ProviderInfo, RegionSchedule } from '../types.js'
import { mapLimit } from '../util.js'
import { cherkasyAddresses } from './cherkasy-addresses.js'
import { daysToSource, postsToDays, postsToSchedule, readChannelPosts, type SchedulePost } from './posts.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'
import { findUaDate, parseGroupPost } from './ua-text.js'

/**
 * Cherkasyoblenergo publishes each day's schedule as a news post, "Графік погодинних
 * відключень (ГПВ) на 6 листопада", with lines like "1.1 00:00 - 02:00, 07:00 - 10:00", and
 * the same text in its Telegram channel a few minutes later. Corrections come as a newer post
 * ("Оновлено графік … на 6 листопада") that lists only the hours still ahead, so a day is its
 * first post with the updates layered on top. The site's CMS has a JSON API: the posts are
 * searched and the ones for today and tomorrow fetched. Both channels are read, because the
 * site post has been missing past midnight while the channel had the day.
 *
 * Address search goes through the operator's own lookup, see `cherkasy-addresses.ts`.
 */
const INFO: ProviderInfo = {
  id: 'cherkasy',
  name: 'Черкаська область',
  operator: 'Черкасиобленерго',
  website: 'https://www.cherkasyoblenergo.com/off',
  capabilities: { schedule: true, addressSearch: true },
}

const API = 'https://www.cherkasyoblenergo.com/api/v1/posts'
/** The search is sorted newest first; 20 posts cover two days of updates and emergency notices. */
const SEARCH_URL = `${API}/search?${new URLSearchParams({ q: 'ГПВ', lang: 'uk', page: '0', size: '20' })}`
const CHANNEL = 'pat_cherkasyoblenergo'

/** Hourly schedule posts. Emergency (ГАВ) and industrial (ГОП) notices have no group windows. */
const SCHEDULE_TITLE = /ГПВ|погодинн/i

/** A title that calls the schedule off; emergency (ГАВ) ones aren't about the hourly schedule */
const CANCEL_TITLE = /^(?![\s\S]*(?:аварійн|ГАВ))[\s\S]*(?:скасов|відмін|не\s+застосов|не\s+діятим)/iu

/** Posts fetched per call at most: a day has had 5 versions, plus tomorrow's */
const MAX_POSTS = 10

const POSTS = { groups: STANDARD_GROUPS, updates: 'layer' } as const

interface PostSummary {
  title?: string
  slug?: string
  /** Naive Kyiv wall-clock time, "2026-11-05T20:25:00" */
  publishedAt?: string
  createdAt?: string
}
interface SearchResponse {
  data?: { content?: PostSummary[] }
}
interface PostResponse {
  data?: PostSummary & { content?: string }
}

export function cherkasyProvider(): Provider {
  const region = INFO.id
  return {
    info: INFO,
    sampleAddress: { city: 'Черкаси', street: 'б-р. Шевченка', house: '100' },
    ...cherkasyAddresses(region, INFO.operator),

    getSchedules: (ctx) =>
      mergeSources(
        ctx,
        region,
        [
          { id: 'site', url: INFO.website, read: readSite },
          {
            id: `telegram:@${CHANNEL}`,
            url: `https://t.me/s/${CHANNEL}`,
            read: async (ctx) => (await readChannelPosts(ctx, region, CHANNEL, POSTS)).read,
          },
        ],
        { groups: STANDARD_GROUPS },
      ),
  }
}

async function readSite(ctx: ProviderContext): Promise<SourceRead> {
  const region = INFO.id
  const now = ctx.now()
  const search = await ctx.http.json<SearchResponse>(SEARCH_URL, { region })
  const posts = await mapLimit(
    pickSchedulePosts(search, now),
    3,
    async (slug) => {
      const url = `${API}/${encodeURIComponent(slug)}?lang=uk`
      const res = await ctx.http.json<PostResponse>(url, { region })
      if (typeof res?.data?.content !== 'string')
        throw new OutageError('parse', `Cherkasy post ${slug}: no "content"`, { region, url })
      return res.data
    },
    ctx.signal,
  )
  return daysToSource(postsToDays(preparePosts(posts), now, POSTS), POSTS)
}

/**
 * Slugs of the schedule posts that make up today and later, newest first: for each day its
 * updates back to the first post published before the day began (that one is the whole day,
 * the later ones list only the hours ahead), and before them the cancellations since yesterday
 * whose title names no day. Exported for tests.
 * The day comes from the title: slugs are reused ("onovleno-…-na-1-lystopada" is about 3 листопада).
 */
export function pickSchedulePosts(res: SearchResponse, now: Date): string[] {
  const list = res?.data?.content
  if (!Array.isArray(list))
    throw new OutageError('parse', 'Cherkasy post search: no "data.content" list', { region: INFO.id })
  const today = kyivDate(now)
  const found: { slug: string; at: number; date: string }[] = []
  /** Cancellations whose title names no day ("Скасовано застосування ГПВ"): the text says which */
  const cancellations: string[] = []
  for (const p of list) {
    if (!p.slug || !p.title || !SCHEDULE_TITLE.test(p.title)) continue
    const at = Date.parse(kyivIso(p.publishedAt ?? p.createdAt) ?? '')
    const date = findUaDate(p.title, Number.isFinite(at) ? new Date(at) : now)
    if (!date && CANCEL_TITLE.test(p.title) && at >= kyivInstant(addDays(today, -1), 0).getTime())
      cancellations.push(p.slug)
    if (!date || date < today || date > addDays(today, 2)) continue
    found.push({ slug: p.slug, at, date })
  }
  found.sort((a, b) => b.at - a.at)
  const whole = new Set<string>()
  // a cancellation left unread would leave the schedule it calls off standing
  const slugs: string[] = [...new Set(cancellations)].slice(0, 3)
  for (const p of found) {
    if (whole.has(p.date) || slugs.includes(p.slug)) continue
    slugs.push(p.slug)
    // published before its day: nothing older is needed for that day
    if (!(p.at >= kyivInstant(p.date, 0).getTime())) whole.add(p.date)
  }
  return slugs.slice(0, MAX_POSTS)
}

/** Full posts → schedule, the site alone. Exported for tests. */
export function parseCherkasyPosts(
  posts: readonly (PostSummary & { content?: string })[],
  now: Date,
): RegionSchedule {
  return postsToSchedule(INFO.id, preparePosts(posts), now, { updates: 'layer' })
}

function preparePosts(posts: readonly (PostSummary & { content?: string })[]): SchedulePost[] {
  const prepared: SchedulePost[] = posts.map((p) => ({
    title: p.title ?? '',
    body: flattenPostHtml(p.content ?? ''),
    publishedAt: kyivIso(p.publishedAt ?? p.createdAt) ?? '',
  }))
  // a schedule post we can't read is a format change; a cancellation legitimately has no lines
  const unreadable = prepared.filter(
    (p) => !Object.keys(parseGroupPost(p.body)).length && !/не\s+застосов|скасова/i.test(p.body),
  )
  if (unreadable.length && unreadable.length === prepared.length)
    throw new OutageError('parse', `Cherkasy: no group lines in "${unreadable[0]!.title}"`, {
      region: INFO.id,
    })
  return prepared
}

/**
 * The posts are hand-edited HTML where one time is split across inline tags and `&nbsp;`:
 * `1.1&nbsp;<span>00</span><span>:00 - 02:00,&nbsp;</span>`. Block ends become line breaks,
 * inline tags vanish without a space, and "00 :00" is rejoined, giving "1.1 00:00 - 02:00,".
 */
export function flattenPostHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;| /g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/(\d)[ \t]+:(?=\d{2})/g, '$1:')
    .replace(/[ \t]+/g, ' ')
}

/** "2026-11-05T20:25:00" (Kyiv wall clock, no offset) → ISO with the Kyiv offset. */
function kyivIso(naive: string | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(naive ?? '')
  if (!m) return null
  const t = kyivInstant(m[1]!, Number(m[2]) * 60 + Number(m[3])).getTime() + Number(m[4] ?? 0) * 1000
  return toKyivIso(new Date(t))
}
