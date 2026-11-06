import { OutageError } from '../errors.js'
import { decodePng } from '../image/png.js'
import { readScheduleTable, STANDARD_GROUPS, type TableLayout } from '../image/table.js'
import { cellsToIntervals, compareGroups } from '../schedule.js'
import { toKyivIso } from '../time.js'
import type { DaySchedule, RegionId, RegionSchedule } from '../types.js'
import type { ProviderContext } from './provider.js'

/** Images published for one schedule date, newest first. */
export interface DatedImages {
  date: string
  images: { path: string; at: Date }[]
}

/**
 * Builds a region schedule from operators' table images. For each date the newest image that
 * actually contains the table wins: operators also post text announcements as images under the
 * same date, and those are skipped. A date where no image has a readable table is a `parse`
 * error, so a changed template shows up in the health check.
 */
export async function scheduleFromImages(
  ctx: ProviderContext,
  region: RegionId,
  dates: readonly DatedImages[],
  url: (path: string) => string,
  layout: TableLayout,
): Promise<RegionSchedule> {
  const schedules: Record<string, DaySchedule[]> = {}
  let updated = 0
  for (const { date, images } of dates) {
    let lastError = ''
    let read = false
    for (const img of images) {
      let cells
      try {
        cells = readScheduleTable(decodePng(await ctx.http.bytes(url(img.path), { region })), layout)
      } catch (e) {
        if (e instanceof OutageError) throw e
        lastError = `${img.path}: ${(e as Error).message}`
        continue
      }
      cells.forEach((row, i) =>
        (schedules[STANDARD_GROUPS[i]!] ??= []).push({
          date,
          status: 'scheduled',
          intervals: cellsToIntervals(date, row),
        }),
      )
      updated = Math.max(updated, img.at.getTime())
      read = true
      break
    }
    if (!read && images.length)
      throw new OutageError(
        'parse',
        `no readable schedule table among ${images.length} image(s) for ${date} (${lastError})`,
        {
          region,
        },
      )
  }
  return {
    region,
    groups: Object.keys(schedules).sort(compareGroups),
    schedules,
    updatedAt: updated ? toKyivIso(new Date(updated)) : null,
    fetchedAt: toKyivIso(ctx.now()),
  }
}
