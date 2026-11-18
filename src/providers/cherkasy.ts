import { siteInput } from '../ai/posts.js'
import type { PostInput } from '../ai/types.js'
import { STANDARD_GROUPS } from '../schedule.js'
import { OutageError } from '../errors.js'
import { addDays, kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { ProviderInfo } from '../types.js'
import { mapLimit } from '../util.js'
import { cherkasyAddresses } from './cherkasy-addresses.js'
import { daysToSource, readChannelPosts, readSchedulePosts } from './posts.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'

/**
 * Cherkasyoblenergo publishes each day's schedule as a news post, "Графік погодинних
 * відключень (ГПВ) на 6 листопада", with lines like "1.1 00:00 - 02:00, 07:00 - 10:00", and
 * the same text in its Telegram channel a few minutes later. Corrections come as a newer post
 * ("Оновлено графік … на 6 листопада") that lists only the hours still ahead, so a day is its
 * first post with the updates layered on top. The site's CMS has a JSON API: the posts the
 * search finds since yesterday are fetched and read by the client's text processor. Both channels are read, because the
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

/** Posts fetched per call at most: a day has had 5 versions, plus tomorrow's and notices */
const MAX_POSTS = 20

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
    recentPosts(search, now),
    3,
    async (slug) => {
      const url = `${API}/${encodeURIComponent(slug)}?lang=uk`
      const res = await ctx.http.json<PostResponse>(url, { region })
      if (typeof res?.data?.content !== 'string')
        throw new OutageError('parse', `Cherkasy post ${slug}: no "content"`, { region, url })
      return { ...res.data, slug }
    },
    ctx.signal,
  )
  // yesterday's first post (the evening before) is outside the window: its updates alone would
  // stand as the whole day
  return (await readSchedulePosts(ctx, region, cherkasyPosts(posts), { ...POSTS, since: kyivDate(now) })).read
}

/**
 * Slugs of the posts the search found since yesterday's start, newest first: every version of
 * today's and tomorrow's schedule is among them (a day's first post comes the evening before),
 * and the processor tells schedules from notices. Exported for tests.
 */
export function recentPosts(res: SearchResponse, now: Date): string[] {
  const list = res?.data?.content
  if (!Array.isArray(list))
    throw new OutageError('parse', 'Cherkasy post search: no "data.content" list', { region: INFO.id })
  const since = kyivInstant(addDays(kyivDate(now), -1), 0).getTime()
  return list
    .map((p) => ({ slug: p.slug, at: Date.parse(kyivIso(p.publishedAt ?? p.createdAt) ?? '') }))
    .filter((p): p is { slug: string; at: number } => !!p.slug && p.at >= since)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_POSTS)
    .map((p) => p.slug)
}

/** Full posts → inputs for the text processor. Exported for tests. */
export function cherkasyPosts(posts: readonly (PostSummary & { content?: string })[]): PostInput[] {
  return posts.map((p) =>
    siteInput(
      {
        url: p.slug ? `${API}/${encodeURIComponent(p.slug)}?lang=uk` : null,
        site: INFO.website,
        title: p.title ?? '',
        text: flattenPostHtml(p.content ?? ''),
        publishedAt: kyivIso(p.publishedAt ?? p.createdAt) ?? '',
      },
      INFO.id,
    ),
  )
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
