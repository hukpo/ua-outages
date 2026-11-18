import { toSlots } from '../ai/map.js'
import type { Analyzed } from '../ai/posts.js'
import { postRegion } from '../ai/regions.js'
import type { ImageReading } from '../ai/types.js'
import { OutageError } from '../errors.js'
import { makeDay, type MinuteSlot } from '../schedule.js'
import { kyivDate, toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, RegionId } from '../types.js'
import {
  assembleDays,
  type DatedPublication,
  type PostDay,
  type PostsOptions,
  type UnreadItem,
} from './posts.js'
import { aiOf, type ProviderContext } from './provider.js'

/** Images published for one schedule date, newest first. */
export interface DatedImages {
  date: string
  images: { path: string; at: Date }[]
}

/**
 * The picture is an hourly (ГПВ) schedule: a ГАВ or СГАВ table, even with 1.1…6.2 rows, is not
 * the day's hours. An unnamed kind counts as hourly: these readers only get schedule pictures
 */
export const hourlySchedule = (r: ImageReading) => r.isSchedule && (r.kind === 'gpv' || r.kind === null)

/** A checked reading → every queue's day on `date` */
export function readingToDay(reading: ImageReading, date: string): Record<GroupId, DaySchedule> {
  const schedules: Record<GroupId, DaySchedule> = {}
  for (const q of reading.schedule) schedules[q.queue] = makeDay(date, toSlots(q.intervals))
  return schedules
}

/** A schedule picture a site or API publishes (not a post) */
export interface SitePicture {
  url: string
  /** When it was published, ISO; null when nothing says */
  at: string | null
  /** The day the source lists it for; null: the picture's own date decides */
  date: string | null
  bytes: () => Promise<Uint8Array>
}

/**
 * Pictures a site or API publishes, newest first, put together like every post reader's
 * (`assembleDays`): each picture read is the whole day it is for (`isWhole`), the newest one of a
 * date decides, and one that can't be read (or isn't a schedule while none of the date's is, or
 * whose date the source contradicts, or `check` refuses) leaves the day as an older picture makes
 * it, flagged `unread`; it is read again after 10 minutes. Older pictures of a date are read only
 * while no newer one gave it. Each distinct picture is read once (cached by its bytes).
 */
export async function readSitePictures(
  ctx: ProviderContext,
  region: RegionId,
  pictures: readonly SitePicture[],
  opts: PostsOptions & { check?: (date: string, picture: SitePicture) => string | null } = {},
): Promise<Map<string, PostDay>> {
  const ai = aiOf(ctx)
  ai.requireImage(region)
  const info = postRegion(region)
  const now = ctx.now()
  const nowIso = toKyivIso(now)
  const analyzed: Analyzed[] = pictures.map((p) => ({
    input: {
      url: p.url,
      source: { kind: 'site', site: p.url },
      publishedAt: p.at ?? '',
      edited: false,
      title: null,
      text: '',
      replyTo: null,
      photoCount: 1,
      regions: [info],
    },
    analysis: null,
    error: null,
  }))
  const pubs: DatedPublication[] = []
  const items: UnreadItem[] = []
  const given = new Set<string>()
  const listed = new Map<string, number>()
  const unread = (post: number, date: string, message: string, cause?: unknown) =>
    items.push({
      post,
      days: [date],
      error: new OutageError('parse', `${pictures[post]!.url}: ${message}`, {
        region,
        url: pictures[post]!.url,
        ...(cause ? { cause } : {}),
      }),
    })
  for (const [i, p] of pictures.entries()) {
    ctx.signal?.throwIfAborted()
    // an older version of a day a newer picture gave: no need to read it
    if (p.date && given.has(p.date)) continue
    if (p.date) listed.set(p.date, (listed.get(p.date) ?? 0) + 1)
    const fallback = p.date ?? kyivDate(now)
    let reading: ImageReading
    const src = {
      url: p.url,
      bytes: await p.bytes(),
      caption: null,
      publishedAt: p.at ?? nowIso,
      region: info,
    }
    try {
      reading = await ai.readImage(region, src, ctx.signal)
    } catch (error) {
      if (!(error instanceof OutageError) || error.code !== 'parse') throw error
      unread(i, fallback, error.message, error)
      continue
    }
    // an announcement among the date's pictures: the next older one may be the schedule
    if (!hourlySchedule(reading)) continue
    const date = reading.date ?? p.date
    if (!date) {
      unread(i, fallback, 'a schedule picture with no date, on it or where it is listed')
      continue
    }
    const refused =
      p.date && reading.date && reading.date !== p.date
        ? `the picture listed for ${p.date} says ${reading.date}`
        : (opts.check?.(date, p) ?? null)
    if (refused) {
      await ai.misread(region, [src], refused)
      unread(i, p.date ?? fallback, refused)
      continue
    }
    const groups: Record<string, MinuteSlot[] | null> = {}
    for (const q of reading.schedule) groups[q.queue] = toSlots(q.intervals)
    pubs.push({ date, at: p.at ? Date.parse(p.at) : NaN, post: i, seq: -i, pub: { groups, from: 0 } })
    given.add(date)
  }
  // a date whose pictures are none of them a schedule: its hours aren't there
  for (const [date, n] of listed)
    if (!given.has(date)) {
      const i = pictures.findIndex((p) => p.date === date)
      if (!items.some((it) => it.days.includes(date)))
        unread(i, date, `none of the ${n} picture(s) for ${date} is a schedule`)
    }
  return assembleDays(analyzed, pubs, items, region, now, opts)
}

/** An archive's dated images (newest first per date) → the pictures `readSitePictures` takes */
export const archivePictures = (
  ctx: ProviderContext,
  region: RegionId,
  dates: readonly DatedImages[],
  url: (path: string) => string,
): SitePicture[] =>
  dates.flatMap(({ date, images }) =>
    images.map((img) => ({
      url: url(img.path),
      at: toKyivIso(img.at),
      date,
      bytes: () => ctx.http.bytes(url(img.path), { region }),
    })),
  )
