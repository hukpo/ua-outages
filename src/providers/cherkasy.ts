import { OutageError } from '../errors.js'
import { addDays, kyivDate, kyivInstant, toKyivIso } from '../time.js'
import type { RegionInfo, RegionSchedule } from '../types.js'
import { postsToSchedule, type SchedulePost } from './posts.js'
import type { Provider, ProviderContext } from './provider.js'
import { findUaDate, parseGroupLines } from './ua-text.js'

/**
 * Cherkasyoblenergo publishes each day's schedule as a news post, "Графік погодинних
 * відключень (ГПВ) на 6 листопада", with lines like "1.1 00:00 - 02:00, 07:00 - 10:00".
 * Corrections come as a newer post ("Оновлено графік … на 6 листопада"). The site's CMS has
 * a JSON API, so we search the posts and fetch only the newest post for each relevant day.
 *
 * No address search: the operator's lookup (cabinet.cherkasyoblenergo.com/api_new/disconn.php)
 * serves an incomplete TLS chain (the Sectigo intermediate is missing), so Node's fetch rejects
 * it. Working around that needs a custom CA via an undici dispatcher, which this
 * dependency-free SDK doesn't do.
 */
const INFO: RegionInfo = {
  id: 'cherkasy',
  name: 'Черкаська область',
  operator: 'Черкасиобленерго',
  website: 'https://www.cherkasyoblenergo.com/off',
  capabilities: { schedule: true, addressSearch: false },
}

const API = 'https://www.cherkasyoblenergo.com/api/v1/posts'
/** The search is sorted newest first; 10 posts cover several days including emergency notices. */
const SEARCH_URL = `${API}/search?${new URLSearchParams({ q: 'ГПВ', lang: 'uk', page: '0', size: '10' })}`

/** Hourly schedule posts. Emergency (ГАВ) and industrial (ГОП) notices have no group windows. */
const SCHEDULE_TITLE = /ГПВ|погодинн/i

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

    async getSchedules(ctx: ProviderContext): Promise<RegionSchedule> {
      const now = ctx.now()
      const search = await ctx.http.json<SearchResponse>(SEARCH_URL, { region })
      const wanted = pickSchedulePosts(search, now)
      const posts = await Promise.all(
        wanted.map(async (slug) => {
          const url = `${API}/${encodeURIComponent(slug)}?lang=uk`
          const res = await ctx.http.json<PostResponse>(url, { region })
          if (typeof res?.data?.content !== 'string')
            throw new OutageError('parse', `Cherkasy post ${slug}: no "content"`, { region, url })
          return res.data
        }),
      )
      return parseCherkasyPosts(posts, now)
    },
  }
}

/**
 * Slugs of the newest schedule post for each day from yesterday on. Exported for tests.
 * The day comes from the title: slugs are reused ("onovleno-…-na-1-lystopada" is about 3 листопада).
 */
export function pickSchedulePosts(res: SearchResponse, now: Date): string[] {
  const list = res?.data?.content
  if (!Array.isArray(list))
    throw new OutageError('parse', 'Cherkasy post search: no "data.content" list', { region: INFO.id })
  const today = kyivDate(now)
  const newest = new Map<string, { slug: string; at: number }>()
  for (const p of list) {
    if (!p.slug || !p.title || !SCHEDULE_TITLE.test(p.title)) continue
    const at = Date.parse(kyivIso(p.publishedAt ?? p.createdAt) ?? '')
    const date = findUaDate(p.title, Number.isFinite(at) ? new Date(at) : now)
    if (!date || date < addDays(today, -1) || date > addDays(today, 2)) continue
    const prev = newest.get(date)
    if (!prev || at > prev.at) newest.set(date, { slug: p.slug, at })
  }
  return [...newest.values()].map((p) => p.slug)
}

/** Full posts → schedule. Exported for tests. */
export function parseCherkasyPosts(
  posts: readonly (PostSummary & { content?: string })[],
  now: Date,
): RegionSchedule {
  const prepared: SchedulePost[] = posts.map((p) => ({
    title: p.title ?? '',
    body: flattenPostHtml(p.content ?? ''),
    publishedAt: kyivIso(p.publishedAt ?? p.createdAt) ?? '',
  }))
  // a schedule post we can't read is a format change; a cancellation legitimately has no lines
  const unreadable = prepared.filter(
    (p) => !Object.keys(parseGroupLines(p.body)).length && !/не\s+застосов|скасова/i.test(p.body),
  )
  if (unreadable.length && unreadable.length === prepared.length)
    throw new OutageError('parse', `Cherkasy: no group lines in "${unreadable[0]!.title}"`, { region: INFO.id })
  return postsToSchedule(INFO.id, prepared, now)
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
