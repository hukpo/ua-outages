import { STANDARD_GROUPS } from '../schedule.js'
import { siteInput } from '../ai/posts.js'
import type { PostInput } from '../ai/types.js'
import { htmlToText } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import type { ProviderInfo } from '../types.js'
import { daysToSource, readChannelPosts, readSchedulePosts } from './posts.js'
import type { Provider, ProviderContext } from './provider.js'
import { mergeSources, type SourceRead } from './sources.js'

/**
 * Kharkivoblenergo publishes each day's schedule as a news post, and the same text in its
 * Telegram channel a few minutes earlier; both are read by the client's text processor. The site's Drupal JSON:API is open, so posts are read
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
      return (await readSchedulePosts(ctx, INFO.id, kharkivPosts(res), POSTS)).read
    } catch (e) {
      ctx.signal?.throwIfAborted()
      // nothing to read the posts with: another host won't change that
      if (e instanceof OutageError && e.code === 'config') throw e
      first ??= e
    }
  }
  throw first
}

/** The JSON:API answer → posts for the text processor; `changed` is the time of the last edit. Exported for tests. */
export function kharkivPosts(res: JsonApi): PostInput[] {
  if (!Array.isArray(res?.data))
    throw new OutageError('parse', 'Kharkiv JSON:API: no "data" list', { region: INFO.id })
  return res.data.map((n) =>
    siteInput(
      {
        site: INFO.website,
        title: n.attributes?.title ?? '',
        text: htmlToText(n.attributes?.body?.value ?? ''),
        publishedAt: n.attributes?.changed ?? n.attributes?.created ?? '',
      },
      INFO.id,
    ),
  )
}
