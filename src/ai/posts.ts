import { createHash } from 'node:crypto'
import type { TelegramPost } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { aiOf, type ProviderContext } from '../providers/provider.js'
import type { RegionId } from '../types.js'
import { channelRegions, postRegion } from './regions.js'
import type { PostAnalysis, PostInput, PostRegion } from './types.js'

/** A Telegram post as a processor input: its text, the post it replies to, how many photos */
function telegramInput(post: TelegramPost, regions: readonly PostRegion[]): PostInput {
  return {
    url: post.url,
    source: { kind: 'telegram', channel: post.channel },
    publishedAt: post.at,
    edited: post.edited,
    title: null,
    text: post.text,
    replyTo: post.replyTo ?? null,
    photoCount: post.photos.length,
    regions,
  }
}

export interface SitePost {
  /** The article's link; without one, the page's with a hash of the article */
  url?: string | null
  site: string
  title: string | null
  /** Plain text */
  text: string
  publishedAt: string
}

export function siteInput(post: SitePost, region: RegionId): PostInput {
  const url =
    post.url ??
    `${post.site}#${createHash('sha256')
      .update(`${post.title ?? ''}\n${post.text}`)
      .digest('hex')
      .slice(0, 16)}`
  return {
    url,
    source: { kind: 'site', site: post.site },
    publishedAt: post.publishedAt,
    edited: false,
    title: post.title,
    text: post.text,
    replyTo: null,
    photoCount: 0,
    regions: [postRegion(region)],
  }
}

/** Telegram posts → inputs, with the channel's registered regions */
export const channelInputs = (posts: readonly TelegramPost[], asking: RegionId): PostInput[] =>
  posts.map((p) => telegramInput(p, channelRegions(p.channel, asking)))

export interface Analyzed {
  input: PostInput
  /** The checked answer, or the error when this post couldn't be read */
  analysis: PostAnalysis | null
  error: OutageError | null
}

/**
 * Every post through the text processor (cached, so only new and edited posts cost anything).
 * A post whose answer fails is returned with its error; what that means is the caller's call.
 * Errors other than a misread (the AI API down, a cancelled call, no processor) are thrown.
 */
export async function analyzeAll(
  ctx: ProviderContext,
  region: RegionId,
  inputs: readonly PostInput[],
  /** For an emergency state: checked by the second (and third) reader, see `analyzeEmergencyPost` */
  opts: { emergency?: boolean } = {},
): Promise<Analyzed[]> {
  const ai = aiOf(ctx)
  ai.requireText(region)
  return Promise.all(
    inputs.map(async (input) => {
      try {
        const analysis = opts.emergency
          ? await ai.analyzeEmergencyPost(region, input, ctx.signal)
          : await ai.analyzePost(region, input, ctx.signal)
        return { input, analysis, error: null }
      } catch (e) {
        if (e instanceof OutageError && e.code === 'parse') return { input, analysis: null, error: e }
        throw e
      }
    }),
  )
}

/**
 * Schedule readers: a post that couldn't be read may be the newest schedule, so the source fails
 * (`parse`) unless a later post was read fine and published a schedule. Older failures are
 * skipped: they would be replaced anyway.
 */
export function failIfNewestUnread(
  list: readonly Analyzed[],
  hasSchedule: (a: PostAnalysis) => boolean,
  /** The list is newest first and its times mean nothing (a site page) */
  byOrder = false,
): void {
  if (byOrder) {
    const firstGood = list.findIndex((a) => a.analysis && hasSchedule(a.analysis))
    const firstBad = list.findIndex((a) => a.error)
    if (firstBad !== -1 && (firstGood === -1 || firstBad < firstGood)) throw list[firstBad]!.error
    return
  }
  const newestGood = Math.max(
    0,
    ...list.filter((a) => a.analysis && hasSchedule(a.analysis)).map((a) => Date.parse(a.input.publishedAt)),
  )
  const bad = list.find((a) => a.error && Date.parse(a.input.publishedAt) >= newestGood)
  if (bad) throw bad.error
}
