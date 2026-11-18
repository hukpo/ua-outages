import { analyzeAll, channelInputs, type Analyzed } from '../ai/posts.js'
import { postRegion } from '../ai/regions.js'
import type { ImageReading, PostAnalysis, PostRegion } from '../ai/types.js'
import type { TelegramPost } from '../emergency/telegram.js'
import { OutageError } from '../errors.js'
import { addDays, kyivDate, kyivMinuteOfDay } from '../time.js'
import type { DaySchedule, GroupId, RegionId } from '../types.js'
import type { MinuteSlot } from '../schedule.js'
import { mapLimit } from '../util.js'
import { toSlots } from '../ai/map.js'
import { clockMinutes } from '../ai/validate.js'
import { hourlySchedule, readingToDay } from './image-schedule.js'
import {
  assembleDays,
  gpvEvents,
  isWhole,
  textPublications,
  textUnread,
  type UnreadItem,
  type DatedPublication,
  type PostDay,
  type PostsOptions,
} from './posts.js'
import { aiOf, type ProviderContext } from './provider.js'

/**
 * Channels that post the schedule as a picture (a poster, a table) with a caption, and correct
 * it in words or with a new picture: Chernihiv, Zakarpattia. Captions go through the text
 * processor, pictures through the image processor:
 *
 * - a post whose text says its photos are the schedule must have one that reads as a schedule;
 *   a post whose pictures can't be read fails the channel (`parse`) unless a later post's
 *   picture was read: it may be newer than every one that can, and an older one must not pass
 *   for the current schedule;
 * - a bare photo (no text) is checked cheaply first (`ImageProcessor.isSchedule`), and read in
 *   full only when it looks like a schedule;
 * - the day is the picture's own date; the caption's, when the picture has none; never the post
 *   time alone. Both given and different, or neither: `parse`;
 * - a picture posted during the day it is for replaces the hours from the post time on (a
 *   re-issued poster lists only the rest of its day), one posted before it is the whole day;
 * - corrections in words (`gpv` change events) are added on top (see `layerPublications`).
 */

/** One schedule picture as posted */
export interface PostedPicture {
  publishedAt: string
  url: string
  schedules: Record<GroupId, DaySchedule>
}

export interface PicturePostsRead {
  /** Per date, everything layered: pictures and corrections */
  days: Map<string, PostDay>
  analyzed: Analyzed[]
  /** Every schedule picture per date, oldest first, as drawn */
  pictures: Record<string, PostedPicture[]>
  /** The newest post that shaped a day */
  url?: string
}

const fail = (region: RegionId, url: string, message: string, cause?: unknown) =>
  new OutageError('parse', message, { region, url, ...(cause ? { cause } : {}) })

/**
 * The caption's day for its photos: its one `gpv` event with no hours in words, when the caption
 * names the day ("на 17.11", "сьогодні"); "Оновлений графік у фото" names none, and the picture
 * must then show its own date
 */
function captionDate(a: PostAnalysis | null, region: RegionId, postDay: string): string | null {
  const events = (a ? gpvEvents(a, region) : []).filter((e) => e.action !== 'cancel' && !e.schedule.length)
  if (events.some((e) => !e.dateNamed)) return null
  const days = new Set(events.map((e) => e.date ?? postDay))
  return days.size === 1 ? [...days][0]! : null
}

/** `posts` oldest first, as `readChannelWindow` gives them */
export async function readPicturePosts(
  ctx: ProviderContext,
  region: RegionId,
  posts: readonly TelegramPost[],
  opts: PostsOptions = {},
): Promise<PicturePostsRead> {
  const ai = aiOf(ctx)
  ai.requireImage(region)
  const info = postRegion(region)
  const now = ctx.now()

  // captions through the text processor; a bare photo has none
  const withText = posts.filter((p) => p.text)
  const read = await analyzeAll(ctx, region, channelInputs(withText, region))
  const byUrl = new Map(read.map((a) => [a.input.url, a]))
  const analyzed: Analyzed[] = posts.map(
    (p) => byUrl.get(p.url) ?? { input: channelInputs([p], region)[0]!, analysis: null, error: null },
  )

  // CDN links expire: the pictures are fetched right after the page, and only those that matter
  const wanted = posts
    .map((post, i) => ({ post, i, a: analyzed[i]! }))
    .filter(
      ({ post, a }) => post.photos.length && (!post.text || (a.analysis && announces(a.analysis, region))),
    )
  const loaded = await mapLimit(
    wanted,
    3,
    async (w) => ({
      ...w,
      photos: await Promise.all(w.post.photos.map((u) => ctx.http.bytes(u, { region }))),
    }),
    ctx.signal,
  )

  const pubs: DatedPublication[] = textPublications(analyzed, region, now, opts)
  const pictures: PicturePostsRead['pictures'] = {}
  /** What couldn't be read: captions (their hours are in the pictures, read below), then pictures */
  const unread: UnreadItem[] = textUnread(analyzed, region, now, opts, { blind: false })
  // a post that says its schedule is in a picture, with none to fetch: as good as unread
  posts.forEach((post, i) => {
    const a = analyzed[i]!.analysis
    if (post.photos.length || !a || !announces(a, region)) return
    const postDay = kyivDate(new Date(post.at))
    const said = captionDate(a, region, postDay)
    unread.push({
      post: i,
      days: said ? [said] : [postDay, addDays(postDay, 1)],
      error: fail(region, post.url, 'the post announces a schedule picture and has none'),
    })
  })
  for (const w of loaded) {
    try {
      for (const r of await readPost(ctx, region, info, w, opts)) {
        // a picture draws the whole day: with nothing read for the day before it (Zakarpattia posts
        // the day's first poster that morning), it is the whole day; a re-issue after another
        // version replaces the hours from its post time on
        if (
          !r.stated &&
          !pubs.some((p) => p.date === r.pub.date && p.post < w.i && !p.pub.cancelled && isWhole(p.pub))
        )
          r.pub.pub = { ...r.pub.pub, from: 0 }
        pubs.push(r.pub)
        ;(pictures[r.pub.date] ??= []).push(r.picture)
      }
    } catch (error) {
      if (!(error instanceof OutageError) || error.code !== 'parse') throw error
      const postDay = kyivDate(new Date(w.post.at))
      const said = captionDate(w.a.analysis, region, postDay)
      // a poster is for the day it is posted or the next: either may be the one it replaced
      unread.push({ post: w.i, days: said ? [said] : [postDay, addDays(postDay, 1)], error })
    }
  }
  // a picture or caption that can't be read may be newer than every one that can: the day stays
  // as read, flagged, until a later whole day (see `isWhole`)
  const days = assembleDays(analyzed, pubs, unread, region, now, opts)
  const newest = [...days.values()]
    .filter((d) => !d.unread || Object.keys(d.groups).length)
    .sort((x, y) => y.at - x.at)[0]
  return { days, analyzed, pictures, url: newest ? posts[newest.post]?.url : undefined }
}

/** One post's pictures → a publication per day they are for, with the pictures as drawn */
async function readPost(
  ctx: ProviderContext,
  region: RegionId,
  info: PostRegion,
  { post, i, a, photos }: { post: TelegramPost; i: number; a: Analyzed; photos: Uint8Array[] },
  opts: PostsOptions,
): Promise<{ pub: DatedPublication; picture: PostedPicture; stated: boolean }[]> {
  const ai = aiOf(ctx)
  const at = new Date(post.at)
  const postDay = kyivDate(at)
  const caption = post.text || null
  const said = captionDate(a.analysis, region, postDay)
  let found = 0
  // an album may split the queues over its pictures: one publication per day of the post
  const perDay = new Map<
    string,
    { groups: Record<string, MinuteSlot[]>; schedules: Record<GroupId, DaySchedule> }
  >()
  for (const [index, bytes] of photos.entries()) {
    const src = {
      url: post.url,
      bytes,
      caption,
      publishedAt: post.at,
      index,
      of: photos.length,
      region: info,
    }
    // a bare photo: is it a schedule at all? (crews, damage, infographics are most of them)
    if (!caption && !(await ai.isSchedule(region, src, ctx.signal))) continue
    const reading: ImageReading = await ai.readImage(region, src, ctx.signal)
    if (!hourlySchedule(reading)) continue
    const date = reading.date ?? said
    if (!date) throw fail(region, post.url, `a schedule picture with no date, on it or in its post`)
    if (reading.date && said && reading.date !== said)
      throw fail(region, post.url, `the picture reads ${reading.date}, its post says ${said}`)
    if (date < addDays(postDay, -1) || date > addDays(postDay, 1))
      throw fail(region, post.url, `a picture for ${date} in a post of ${postDay}`)
    found++
    const day = perDay.get(date) ?? { groups: {}, schedules: {} }
    for (const q of reading.schedule) {
      if (q.queue in day.groups) throw fail(region, post.url, `queue ${q.queue} on two pictures of the album`)
      day.groups[q.queue] = toSlots(q.intervals)
    }
    Object.assign(day.schedules, readingToDay(reading, date))
    perDay.set(date, day)
  }
  if (!found && caption && a.analysis && announces(a.analysis, region))
    throw fail(
      region,
      post.url,
      `the post announces a schedule picture, and none of its ${photos.length} reads as one`,
    )
  const out: { pub: DatedPublication; picture: PostedPicture; stated: boolean }[] = []
  for (const [date, day] of perDay) {
    const missing = info.queues.filter((q) => !(q in day.groups))
    if (missing.length)
      throw fail(region, post.url, `the post's pictures leave out queues ${missing.join(', ')}`)
    const during = date === postDay && opts.updates === 'layer' ? kyivMinuteOfDay(at) : 0
    // "графік діє з 15:00" in the caption: the picture replaces the day from then, not from the
    // post time (the hours between still stand as they were)
    const said = a.analysis
      ? gpvEvents(a.analysis, region).find(
          (e) => e.action !== 'cancel' && !e.schedule.length && e.at && (e.date ?? postDay) === date,
        )
      : undefined
    const from = opts.updates === 'layer' && said?.at ? clockMinutes(said.at) : during
    const to = opts.updates === 'layer' && said?.at && said.until ? clockMinutes(said.until, true) : undefined
    out.push({
      pub: {
        date,
        at: at.getTime(),
        post: i,
        pub: { groups: day.groups, from, ...(to !== undefined ? { to } : {}) },
      },
      picture: { publishedAt: post.at, url: post.url, schedules: day.schedules },
      stated: !!said?.at,
    })
  }
  return out
}

/** The post's text says its photos are the schedule */
const announces = (a: PostAnalysis, region: RegionId) =>
  a.photosAreSchedules || gpvEvents(a, region).some((e) => e.action !== 'cancel' && !e.schedule.length)
