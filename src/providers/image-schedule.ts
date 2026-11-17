import { OutageError } from '../errors.js'
import { decodePng } from '../image/png.js'
import { NoTableError, readScheduleTable, STANDARD_GROUPS, type TableLayout } from '../image/table.js'
import { cellsToIntervals, compareGroups } from '../schedule.js'
import { toKyivIso } from '../time.js'
import type { DaySchedule, GroupId, RegionId, RegionSchedule } from '../types.js'
import type { ProviderContext } from './provider.js'

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

/**
 * Reads operators' table images, one day per date. For each date the newest image decides.
 * Operators also post text announcements as images under the same date: an image with no table
 * in it at all is skipped for the next older one. An image that can't be decoded, or whose
 * table can't be read, is a `parse` error for the whole read: it may be the version in force,
 * and an older picture of the same date in its place would be a superseded schedule shown as
 * current. A date where no image has a table is a `parse` error too, so a changed template shows
 * up in the health check. The result is what `SourceRead.days` takes.
 */
export async function readDatedImages(
  ctx: ProviderContext,
  region: RegionId,
  dates: readonly DatedImages[],
  url: (path: string) => string,
  layout: TableLayout,
): Promise<Record<string, DatedDay>> {
  const days: Record<string, DatedDay> = {}
  for (const { date, images } of dates) {
    let lastError = ''
    for (const img of images) {
      ctx.signal?.throwIfAborted()
      const bytes = await ctx.http.bytes(url(img.path), { region })
      let cells
      try {
        cells = readScheduleTable(decodePng(bytes), layout)
      } catch (e) {
        if (e instanceof OutageError) throw e
        const message = `${img.path}: ${(e as Error).message}`
        if (!(e instanceof NoTableError))
          throw new OutageError('parse', `cannot read the newest schedule image for ${date} (${message})`, {
            region,
            url: url(img.path),
            cause: e,
          })
        lastError = message
        continue
      }
      const schedules: Record<GroupId, DaySchedule> = {}
      cells.forEach((row, i) => {
        schedules[STANDARD_GROUPS[i]!] = { date, status: 'scheduled', intervals: cellsToIntervals(date, row) }
      })
      days[date] = { schedules, publishedAt: toKyivIso(img.at) }
      break
    }
    if (!days[date] && images.length)
      throw new OutageError(
        'parse',
        `no readable schedule table among ${images.length} image(s) for ${date} (${lastError})`,
        {
          region,
        },
      )
  }
  return days
}

/** `readDatedImages` as one region schedule: `updatedAt` is the newest image read. */
export async function scheduleFromImages(
  ctx: ProviderContext,
  region: RegionId,
  dates: readonly DatedImages[],
  url: (path: string) => string,
  layout: TableLayout,
): Promise<RegionSchedule> {
  const days = await readDatedImages(ctx, region, dates, url, layout)
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
