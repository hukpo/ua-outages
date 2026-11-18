import { analyzeAll, siteInput, type Analyzed } from '../ai/posts.js'
import { htmlToText } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { slotsToIntervals, STANDARD_GROUPS } from '../schedule.js'
import { addDays, kyivDate, kyivInstant, parseClock, toKyivIso } from '../time.js'
import type { ProviderInfo } from '../types.js'
import { daysToSource, gpvEvents, hasSchedule, postsToDays, readChannelPosts, type PostDay } from './posts.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'
import { zoeAddresses } from './zaporizhzhia-addresses.js'

/**
 * Zaporizhzhiaoblenergo posts schedules on a WordPress archive page, newest first; corrections
 * are new posts ("ОНОВЛЕНО ГПВ НА 5 ЛИСТОПАДА … (оновлено 21:25)"), each listing the whole day.
 * The posts carry no machine timestamps: page order decides which version is current, and the
 * operator's own "(оновлено HH:MM)" (`PostAnalysis.statedAt`) is the time of a version. The
 * articles are read by the client's text processor. A post lists only the groups that
 * have outages that day; the rest have none.
 *
 * The site is the complete record (8–13 versions a day). The Telegram channel repeats well
 * under half of them, minutes later, so it is read only as the fallback for when the site can't
 * be reached, and for the time of a day's first post, which the site doesn't give.
 * Addresses come from the operator's Google Sheets, one per group (`zaporizhzhia-addresses.ts`).
 */
const INFO: ProviderInfo = {
  id: 'zaporizhzhia',
  name: 'Запорізька область',
  operator: 'Запоріжжяобленерго',
  website: 'https://www.zoe.com.ua/outage/',
  capabilities: { schedule: true, addressSearch: true },
}

const CHANNEL = 'Zaporizhzhyaoblenergo_news'
const POSTS = { omitted: 'none', groups: STANDARD_GROUPS } as const
/** The site's articles: no time of their own, the page order is theirs */
const SITE_POSTS = { ...POSTS, timeless: true } as const

/** The site's page: what it says per date, and every version on it for comparing with Telegram */
interface SiteRead {
  read: SourceRead
  /** Newest first */
  versions: { date: string; content: string }[]
}

export function zaporizhzhiaProvider(): Provider {
  const addresses = zoeAddresses(INFO.id, INFO.operator)
  return {
    info: INFO,
    sampleAddress: { city: 'Запоріжжя', street: 'бульвар Шевченка', house: '10А' },
    ...addresses,
    getSchedules(ctx) {
      // one fetch of the page serves both readers
      let page: Promise<SiteRead> | undefined
      const site = () =>
        (page ??= ctx.http.text(INFO.website, { region: INFO.id }).then((html) => readZoe(ctx, html)))
      return mergeSources(
        ctx,
        INFO.id,
        [
          { id: 'site', url: INFO.website, read: async () => (await site()).read },
          {
            id: `telegram:@${CHANNEL}`,
            url: `https://t.me/s/${CHANNEL}`,
            read: async (ctx) => readChannel(ctx, await site().catch(() => null)),
          },
        ],
        { groups: STANDARD_GROUPS },
      )
    },
  }
}

/**
 * The channel as the fallback: its days, minus the ones the site already has. A day equal to
 * one of the site's versions is dropped (the channel has posted a version an hour or two after
 * the site had moved on, and its later post time would win the date), except when it equals the
 * site's current version and that one has no time: a day's first post, for which the channel's
 * post time is the only time there is. A day the site has nothing equal to stays, and the newer
 * of the two wins.
 */
async function readChannel(ctx: ProviderContext, site: SiteRead | null): Promise<SourceRead> {
  // 20 posts were 30 hours of this channel on a busy day
  const { read, days } = await readChannelPosts(ctx, INFO.id, CHANNEL, { ...POSTS, maxPages: 3 })
  if (site)
    for (const [date, day] of days) {
      const versions = site.versions.filter((v) => v.date === date)
      const same = versions.findIndex((v) => v.content === contentOf(date, day))
      if (same > 0 || (same === 0 && site.read.days[date]?.publishedAt)) delete read.days[date]
    }
  return read
}

/** A day's outages as one comparable string */
const contentOf = (date: string, day: PostDay) =>
  STANDARD_GROUPS.map((g) => {
    const slots = day.groups[g]
    return slots === null || (slots === undefined && day.cancelled)
      ? '?'
      : slotsToIntervals(date, slots ?? [])
          .map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)
          .join(',')
  }).join('|')

/** The page's articles, newest first: id, title, plain text. Exported for tests. */
export function articlesOf(html: string): { id: string | null; title: string; text: string }[] {
  const articles = [...html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/g)]
  if (!articles.length)
    throw new OutageError('parse', 'Zaporizhzhia: no posts on the page', { region: INFO.id })
  return articles.map((a) => ({
    id: /\bid="post-(\d+)"/.exec(a[1]!)?.[1] ?? null,
    title: htmlToText(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(a[2]!)?.[1] ?? ''),
    text: htmlToText(a[2]!.replace(/<h2[^>]*>[\s\S]*?<\/h2>/, '')),
  }))
}

/**
 * "(оновлено 23:34)" in the title of an article about `date` → the instant: that clock time on
 * the day itself or on the evening before, whichever is the latest that isn't after the
 * article above it on the page (or after now, for the top one). Articles newest first; an
 * article without a stamp (a day's first post) gets null. Exported for tests.
 */
export function stampTimes(
  articles: readonly { date: string | null; stamp: string | null }[],
  now: Date,
): (string | null)[] {
  // the operator's clock and ours needn't agree to the minute
  let upper = now.getTime() + 10 * 60_000
  return articles.map(({ date, stamp }) => {
    const minutes = stamp ? parseClock(stamp) : null
    if (!date || minutes === null) return null
    const at = [date, addDays(date, -1)].map((d) => kyivInstant(d, minutes).getTime()).find((t) => t <= upper)
    if (at === undefined) return null
    upper = at
    return toKyivIso(new Date(at))
  })
}

/**
 * The page → its days. The articles have no time of their own: each is given today's noon as
 * the date to read it against (stable through the day, so it is analysed once a day at most),
 * the page order says which is newer, and "(оновлено HH:MM)" dates the versions.
 */
async function readZoe(ctx: ProviderContext, html: string): Promise<SiteRead> {
  const now = ctx.now()
  const reference = toKyivIso(kyivInstant(kyivDate(now), 12 * 60))
  const inputs = articlesOf(html).map((a) =>
    siteInput(
      {
        url: a.id ? `https://www.zoe.com.ua/?p=${a.id}` : null,
        site: INFO.website,
        title: a.title,
        text: a.text,
        publishedAt: reference,
      },
      INFO.id,
    ),
  )
  const analyzed = await analyzeAll(ctx, INFO.id, inputs)
  // an article above the newest one read fine may be the current version
  const firstGood = analyzed.findIndex((a) => a.analysis && hasSchedule(a.analysis, INFO.id))
  const firstBad = analyzed.findIndex((a) => a.error)
  if (firstBad !== -1 && (firstGood === -1 || firstBad < firstGood)) throw analyzed[firstBad]!.error
  // each article alone: the date and content of every version
  const each = analyzed.map((a) => [...postsToDays([a], INFO.id, now, SITE_POSTS)][0])
  const times = stampTimes(
    analyzed.map((a, i) => ({ date: each[i]?.[0] ?? null, stamp: stampOf(a) })),
    now,
  )
  const days = postsToDays(analyzed, INFO.id, now, SITE_POSTS)
  return {
    read: daysToSource(days, { ...POSTS, publishedAt: (day) => times[day.post] ?? null }),
    versions: each.flatMap((e) => (e ? [{ date: e[0], content: contentOf(e[0], e[1]) }] : [])),
  }
}

/** "(оновлено 21:25)": the processor's `statedAt`, for an article that publishes a schedule */
const stampOf = (a: Analyzed) =>
  a.analysis && gpvEvents(a.analysis, INFO.id).length ? a.analysis.statedAt : null
