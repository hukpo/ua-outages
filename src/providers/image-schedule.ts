import { toSlots } from '../ai/map.js'
import { postRegion } from '../ai/regions.js'
import type { ImageReading } from '../ai/types.js'
import { OutageError } from '../errors.js'
import { compareGroups, makeDay } from '../schedule.js'
import { toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, RegionId, RegionSchedule } from '../types.js'
import { aiOf, type ProviderContext } from './provider.js'

/** Images published for one schedule date, newest first. */
export interface DatedImages {
  date: string
  images: { path: string; at: Date }[]
}

/** One date read from its images: every group's day, and when that image was published. */
export interface DatedDay {
  schedules: Record<GroupId, DaySchedule>
  publishedAt: string | null
}

/** A checked reading → every queue's day on `date` */
export function readingToDay(reading: ImageReading, date: string): Record<GroupId, DaySchedule> {
  const schedules: Record<GroupId, DaySchedule> = {}
  for (const q of reading.schedule) schedules[q.queue] = makeDay(date, toSlots(q.intervals))
  return schedules
}

/**
 * Reads operators' schedule pictures with the client's image processor, one day per date. For
 * each date the newest picture decides. Operators also post announcements as pictures under the
 * same date: a picture that isn't a schedule is skipped for the next older one. A picture that
 * can't be read, or that names another date, is a `parse` error for the whole read: it may be
 * the version in force, and an older picture of the same date in its place would be a
 * superseded schedule shown as current. A date where no picture is a schedule is a `parse`
 * error too. Each distinct picture is read once (cached by its bytes). The result is what
 * `SourceRead.days` takes.
 */
export async function readDatedImages(
  ctx: ProviderContext,
  region: RegionId,
  dates: readonly DatedImages[],
  url: (path: string) => string,
): Promise<Record<string, DatedDay>> {
  const ai = aiOf(ctx)
  ai.requireImage(region)
  const info = postRegion(region)
  const days: Record<string, DatedDay> = {}
  for (const { date, images } of dates) {
    for (const img of images) {
      ctx.signal?.throwIfAborted()
      const at = toKyivIso(img.at)
      const bytes = await ctx.http.bytes(url(img.path), { region })
      const reading = await ai.readImage(
        region,
        { url: url(img.path), bytes, caption: null, publishedAt: at, region: info },
        ctx.signal,
      )
      if (!reading.isSchedule) continue
      if (reading.date && reading.date !== date)
        throw new OutageError('parse', `${img.path}: the picture listed for ${date} says ${reading.date}`, {
          region,
          url: url(img.path),
        })
      days[date] = { schedules: readingToDay(reading, date), publishedAt: at }
      break
    }
    if (!days[date] && images.length)
      throw new OutageError('parse', `none of the ${images.length} picture(s) for ${date} is a schedule`, {
        region,
      })
  }
  return days
}

/** `readDatedImages` as one region schedule: `updatedAt` is the newest image read. */
export async function scheduleFromImages(
  ctx: ProviderContext,
  region: RegionId,
  dates: readonly DatedImages[],
  url: (path: string) => string,
): Promise<RegionSchedule> {
  const days = await readDatedImages(ctx, region, dates, url)
  const schedules: Record<string, DaySchedule[]> = {}
  let updated = 0
  for (const day of Object.values(days)) {
    for (const [g, d] of Object.entries(day.schedules)) (schedules[g] ??= []).push(d)
    updated = Math.max(updated, Date.parse(day.publishedAt!))
  }
  return {
    region,
    groups: Object.keys(schedules).sort(compareGroups),
    schedules,
    updatedAt: updated ? toKyivIso(new Date(updated)) : null,
    fetchedAt: toKyivIso(ctx.now()),
  }
}
