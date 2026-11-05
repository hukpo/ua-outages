import { OutageError } from '../errors.js'
import type { RegionInfo } from '../types.js'
import { postsToSchedule, type SchedulePost } from './posts.js'
import type { Provider } from './provider.js'

/**
 * Zaporizhzhiaoblenergo posts schedules on a WordPress archive page, newest first; corrections
 * are new posts ("ОНОВЛЕНО ГПВ НА 5 ЛИСТОПАДА … (оновлено 21:25)"). The posts carry no machine
 * timestamps, so page order decides which version is current. No address lookup is available.
 */
const INFO: RegionInfo = {
  id: 'zaporizhzhia',
  name: 'Запорізька область',
  operator: 'Запоріжжяобленерго',
  website: 'https://www.zoe.com.ua/outage/',
  capabilities: { schedule: true, addressSearch: false },
}

export function zaporizhzhiaProvider(): Provider {
  return {
    info: INFO,
    async getSchedules(ctx) {
      const html = await ctx.http.text(INFO.website, { region: INFO.id })
      return parseZoe(html, ctx.now())
    },
  }
}

/** Exported for tests. */
export function parseZoe(html: string, now: Date) {
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)]
  if (!articles.length)
    throw new OutageError('parse', 'Zaporizhzhia: no posts on the page', { region: INFO.id })
  const posts: SchedulePost[] = articles.map((a, i) => ({
    title: decode(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(a[1]!)?.[1] ?? ''),
    body: decode(a[1]!),
    // first on the page = newest
    publishedAt: new Date(now.getTime() - i * 1000).toISOString(),
  }))
  const s = postsToSchedule(INFO.id, posts, now)
  // the page gives no edit times; don't pretend the fetch time is one
  return { ...s, updatedAt: null }
}

function decode(s: string) {
  return s
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#039;|&#8217;|&rsquo;/g, '’')
    .replace(/&amp;/g, '&')
}
