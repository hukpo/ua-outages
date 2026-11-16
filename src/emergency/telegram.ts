import { OutageError } from '../errors.js'
import { toKyivIso } from '../time.js'
import type { RegionId } from '../types.js'
import type { ProviderContext } from '../providers/provider.js'

/**
 * Reader of public Telegram channel previews (`https://t.me/s/<channel>`): the server-rendered
 * page Telegram shows to browsers without the app. It holds the newest ~20 posts, oldest first;
 * `?before=<id>` gives the page before a post. No login, no API key.
 *
 * Each post is a `.tgme_widget_message` block with `data-post="<channel>/<id>"`, the text in
 * `.tgme_widget_message_text` and the original post time in `<time datetime>`. An edited post
 * shows its latest text and the word "edited" in its meta line; the edit time is not exposed.
 */
export interface TelegramPost {
  channel: string
  id: number
  url: string
  /** Original post time, ISO with the Kyiv offset (an edit keeps it) */
  at: string
  /** Plain text: line breaks kept, tags dropped, entities decoded */
  text: string
  edited: boolean
}

const PREVIEW = 'https://t.me/s/'

/** One preview page → its posts with text, oldest first. Exported for tests. */
export function parseTelegramPreview(html: string): TelegramPost[] {
  const posts: TelegramPost[] = []
  const starts = [...html.matchAll(/<div class="tgme_widget_message_wrap\b/g)].map((m) => m.index!)
  for (const [i, start] of starts.entries()) {
    const block = html.slice(start, starts[i + 1] ?? html.length)
    const post = /data-post="([^"/]+)\/(\d+)"/.exec(block)
    if (!post) continue
    // "edited &nbsp;" sits in the meta line before the date link
    const meta = /<span class="tgme_widget_message_meta">([\s\S]*?)<time\b/.exec(block)?.[1] ?? ''
    const datetime =
      /<a class="tgme_widget_message_date"[^>]*>\s*<time datetime="([^"]+)"/.exec(block)?.[1] ??
      /<time datetime="([^"]+)"/.exec(block)?.[1]
    const t = datetime ? Date.parse(datetime) : NaN
    if (!Number.isFinite(t)) continue
    const body = messageTextHtml(block)
    const text = body === null ? '' : htmlToText(body)
    if (!text) continue
    const channel = post[1]!
    const id = Number(post[2])
    posts.push({
      channel,
      id,
      url: `https://t.me/${channel}/${id}`,
      at: toKyivIso(new Date(t)),
      text,
      edited: /\bedited\b/.test(meta.replace(/<[^>]+>/g, ' ')),
    })
  }
  // the page is oldest first already; keep that order whatever happens to the markup
  return posts.sort((a, b) => a.id - b.id)
}

/** Inner HTML of the post's own text (not of a quoted reply), or null. */
function messageTextHtml(block: string): string | null {
  const open = /<div class="tgme_widget_message_text js-message_text"[^>]*>/.exec(block)
  if (!open) return null
  // the text div may contain nested divs (rare); find its matching close tag
  const from = open.index + open[0].length
  const tag = /<(\/?)div\b[^>]*>/g
  tag.lastIndex = from
  let depth = 1
  for (let m = tag.exec(block); m; m = tag.exec(block)) {
    depth += m[1] ? -1 : 1
    if (depth === 0) return block.slice(from, m.index)
  }
  return block.slice(from)
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
}

/** Message HTML → plain text: `<br>` and block ends become line breaks, other tags vanish. Exported for tests. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|blockquote|li|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all
      }
      return ENTITIES[e.toLowerCase()] ?? all
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface ReadChannelOptions {
  region: RegionId
  /** Read back until a post older than this (or `maxPages`) */
  since: Date
  /** Pages of ~20 posts, default 5 */
  maxPages?: number
}

/**
 * Posts of a channel from `since` on, oldest first, paging back with `?before=` when one page
 * doesn't reach that far. A page without any post (renamed or private channel, changed markup)
 * is a `parse` error: silence would read as "nothing announced".
 */
export async function readChannel(
  ctx: ProviderContext,
  channel: string,
  opts: ReadChannelOptions,
): Promise<TelegramPost[]> {
  const maxPages = opts.maxPages ?? 5
  const byId = new Map<number, TelegramPost>()
  let before: number | null = null
  for (let page = 0; page < maxPages; page++) {
    ctx.signal?.throwIfAborted()
    const url = `${PREVIEW}${encodeURIComponent(channel)}${before ? `?before=${before}` : ''}`
    const html = await ctx.http.text(url, { region: opts.region, headers: { Accept: 'text/html' } })
    const posts = parseTelegramPreview(html)
    // a page of photo-only posts has message blocks but no text: still a valid page
    const blocks = [...html.matchAll(/data-post="[^"/]+\/(\d+)"/g)].map((m) => Number(m[1]))
    if (!blocks.length) {
      if (page > 0) break // paged past the first post of the channel
      throw new OutageError('parse', `Telegram @${channel}: the preview page has no posts`, {
        region: opts.region,
        url,
      })
    }
    for (const p of posts) byId.set(p.id, p)
    const oldest = Math.min(...blocks)
    const oldestAt = posts.length ? Date.parse(posts[0]!.at) : NaN
    if (oldest <= 1 || (before !== null && oldest >= before)) break
    if (Number.isFinite(oldestAt) && oldestAt < opts.since.getTime()) break
    before = oldest
  }
  return [...byId.values()]
    .filter((p) => Date.parse(p.at) >= opts.since.getTime())
    .sort((a, b) => a.id - b.id)
}
