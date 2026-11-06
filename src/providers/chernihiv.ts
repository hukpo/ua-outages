import { OutageError } from '../errors.js'
import { compareGroups, makeDay } from '../schedule.js'
import { toKyivIso } from '../time.js'
import type { DaySchedule, RegionInfo, RegionSchedule } from '../types.js'
import type { Provider } from './provider.js'
import { findUaDate, parseGroupBlocks } from './ua-text.js'

/**
 * Chernihivoblenergo. The schedule API needs a captcha token on every request, but the same
 * schedule is published openly as an image of twelve cards ("1.1 → 00:00 - 02:30 …") that is
 * overwritten on each update. Reading it needs text recognition, which the app supplies as
 * the `ocr` client option (a vision model, tesseract.js, …); the SDK parses the text.
 * The address lookup also needs the captcha, so there is none here.
 */
const IMAGE = 'https://chernihivoblenergo.com.ua/files/other/schedule_groups.jpg'

const INFO: RegionInfo = {
  id: 'chernihiv',
  name: 'Чернігівська область',
  operator: 'Чернігівобленерго',
  website: 'https://chernihivoblenergo.com.ua',
  capabilities: { schedule: true, addressSearch: false },
}

export function chernihivProvider(): Provider {
  const region = INFO.id
  return {
    info: INFO,
    async getSchedules(ctx) {
      if (!ctx.ocr)
        throw new OutageError(
          'unsupported',
          `${INFO.operator} publishes the schedule as an image with text; pass an \`ocr\` function to OutageClient to read it`,
          { region },
        )
      const bytes = await ctx.http.bytes(IMAGE, { region })
      const text = await ctx.ocr({ bytes, mimeType: 'image/jpeg', region })
      return parseChernihivText(text, ctx.now())
    },
  }
}

/** OCR text of the schedule image → schedule. Exported for tests. */
export function parseChernihivText(text: string, now: Date): RegionSchedule {
  const region = INFO.id
  const date = findUaDate(text, now)
  if (!date) throw new OutageError('parse', 'Chernihiv: no date in the recognised text', { region })
  const groups = parseGroupBlocks(text)
  const ids = Object.keys(groups).sort(compareGroups)
  // the image always shows all twelve groups; fewer means the recognition missed something
  if (ids.length < 12)
    throw new OutageError(
      'parse',
      `Chernihiv: recognised ${ids.length} of 12 groups (${ids.join(', ') || 'none'}); the OCR output may be incomplete`,
      { region },
    )
  const schedules: Record<string, DaySchedule[]> = {}
  for (const g of ids) schedules[g] = [makeDay(date, groups[g]!)]
  return { region, groups: ids, schedules, updatedAt: null, fetchedAt: toKyivIso(now) }
}
