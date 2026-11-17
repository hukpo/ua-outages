import { OutageError } from '../errors.js'
import { STANDARD_GROUPS } from '../image/table.js'
import type { ProviderInfo, RegionSchedule } from '../types.js'
import { daysToSource, postsToDays, postsToSchedule, readChannelPosts, type SchedulePost } from './posts.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'

/**
 * Kharkivoblenergo publishes each day's schedule as a news post, and the same text in its
 * Telegram channel a few minutes earlier. The site's Drupal JSON:API is open, so posts are read
 * as JSON instead of scraping pages. Both are read: the site post has been hours late (or absent
 * past midnight) while the channel had the day. The address lookup on the site needs a captcha,
 * so there is no address search here.
 */
const INFO: ProviderInfo = {
  id: 'kharkiv',
  name: 'Харківська область',
  operator: 'Харківобленерго',
  website: 'https://www.oblenergo.kharkiv.ua/uk',
  capabilities: { schedule: true, addressSearch: false },
}

/**
 * The bare host has answered 400 "The provided host name is not valid for this server" on every
 * path while `www.` worked; it is kept as the second try in case that flips back.
 */
const HOSTS = ['https://www.oblenergo.kharkiv.ua', 'https://oblenergo.kharkiv.ua']
const CHANNEL = 'kharkivenergy'

const PATH =
  '/uk/jsonapi/node/newsforlenta?' +
  new URLSearchParams({
    sort: '-created',
    'page[limit]': '10',
    'fields[node--newsforlenta]': 'title,created,changed,body',
    'filter[t][condition][path]': 'title',
    'filter[t][condition][operator]': 'CONTAINS',
    'filter[t][condition][value]': 'погодинн',
  }).toString()

/** A same-day correction may list only the hours still ahead, as the neighbouring operators' do */
const POSTS = { groups: STANDARD_GROUPS, updates: 'layer' } as const

interface JsonApi {
  data?: {
    attributes?: { title?: string; changed?: string; created?: string; body?: { value?: string } | null }
  }[]
}

export function kharkivProvider(): Provider {
  return {
    info: INFO,
    getSchedules: (ctx) =>
      mergeSources(
        ctx,
        INFO.id,
        [
          { id: 'site', url: INFO.website, read: readSite },
          {
            id: `telegram:@${CHANNEL}`,
            url: `https://t.me/s/${CHANNEL}`,
            read: async (ctx) => (await readChannelPosts(ctx, INFO.id, CHANNEL, POSTS)).read,
          },
        ],
        { groups: STANDARD_GROUPS },
      ),
  }
}

async function readSite(ctx: ProviderContext): Promise<SourceRead> {
  let first: unknown
  for (const host of HOSTS) {
    try {
      const res = await ctx.http.json<JsonApi>(host + PATH, {
        region: INFO.id,
        headers: { Accept: 'application/vnd.api+json' },
      })
      return daysToSource(postsToDays(kharkivPosts(res), ctx.now(), POSTS), POSTS)
    } catch (e) {
      ctx.signal?.throwIfAborted()
      first ??= e
    }
  }
  throw first
}

/** The JSON:API answer → posts; `changed` is the time of the last edit. Exported for tests. */
export function kharkivPosts(res: JsonApi): SchedulePost[] {
  if (!Array.isArray(res?.data))
    throw new OutageError('parse', 'Kharkiv JSON:API: no "data" list', { region: INFO.id })
  return res.data.map((n) => ({
    title: n.attributes?.title ?? '',
    body: n.attributes?.body?.value ?? '',
    publishedAt: n.attributes?.changed ?? n.attributes?.created ?? '',
  }))
}

/** The site's posts alone → schedule. Exported for tests. */
export function parseKharkiv(res: JsonApi, now: Date): RegionSchedule {
  return postsToSchedule(INFO.id, kharkivPosts(res), now, POSTS)
}
