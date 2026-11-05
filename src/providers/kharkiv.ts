import { OutageError } from '../errors.js'
import type { RegionInfo } from '../types.js'
import { postsToSchedule, type SchedulePost } from './posts.js'
import type { Provider } from './provider.js'

/**
 * Kharkivoblenergo publishes each day's schedule as a news post. The site's Drupal JSON:API
 * is open, so posts are read as JSON instead of scraping pages. The address lookup on the
 * site needs a captcha, so there is no address search here.
 */
const INFO: RegionInfo = {
  id: 'kharkiv',
  name: 'Харківська область',
  operator: 'Харківобленерго',
  website: 'https://oblenergo.kharkiv.ua/uk',
  capabilities: { schedule: true, addressSearch: false },
}

const URL_ =
  'https://oblenergo.kharkiv.ua/uk/jsonapi/node/newsforlenta?' +
  new URLSearchParams({
    sort: '-created',
    'page[limit]': '10',
    'fields[node--newsforlenta]': 'title,created,changed,body',
    'filter[t][condition][path]': 'title',
    'filter[t][condition][operator]': 'CONTAINS',
    'filter[t][condition][value]': 'погодинн',
  }).toString()

interface JsonApi {
  data?: {
    attributes?: { title?: string; changed?: string; created?: string; body?: { value?: string } | null }
  }[]
}

export function kharkivProvider(): Provider {
  return {
    info: INFO,
    async getSchedules(ctx) {
      const res = await ctx.http.json<JsonApi>(URL_, {
        region: INFO.id,
        headers: { Accept: 'application/vnd.api+json' },
      })
      return parseKharkiv(res, ctx.now())
    },
  }
}

/** Exported for tests. */
export function parseKharkiv(res: JsonApi, now: Date) {
  if (!Array.isArray(res?.data))
    throw new OutageError('parse', 'Kharkiv JSON:API: no "data" list', { region: INFO.id })
  const posts: SchedulePost[] = res.data.map((n) => ({
    title: n.attributes?.title ?? '',
    body: n.attributes?.body?.value ?? '',
    publishedAt: n.attributes?.changed ?? n.attributes?.created ?? '',
  }))
  return postsToSchedule(INFO.id, posts, now)
}
