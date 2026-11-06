import { SECTIGO_DV_R36 } from '../certs.js'
import { OutageError } from '../errors.js'
import { readCardPoster, type CardLayout } from '../image/cards.js'
import { decodeJpeg, isJpeg } from '../image/jpeg.js'
import { decodePng } from '../image/png.js'
import { STANDARD_GROUPS } from '../image/table.js'
import { makeDay } from '../schedule.js'
import { addDays, kyivDate, toKyivIso } from '../time.js'
import type { DaySchedule, RegionInfo, RegionSchedule } from '../types.js'
import type { Provider } from './provider.js'

/**
 * Chernihivoblenergo. The schedule API needs a captcha token on every request, but the same
 * schedule is published openly as a poster of twelve orange cards, one per group, listing
 * "HH:MM - HH:MM" off times (or "відключень не прогнозується"), overwritten on each update.
 * The SDK reads the digits off the poster itself by matching them against the poster font
 * (src/image/cards.ts). The address lookup also needs the captcha, so there is none here.
 */
const IMAGE = 'https://chernihivoblenergo.com.ua/files/other/schedule_groups.jpg'

const INFO: RegionInfo = {
  id: 'chernihiv',
  name: 'Чернігівська область',
  operator: 'Чернігівобленерго',
  website: 'https://chernihivoblenergo.com.ua',
  capabilities: { schedule: true, addressSearch: false },
}

export const CHERNIHIV_POSTER: CardLayout = {
  cards: 12,
  // light orange, rgb(250, 200, 160)
  isCard: (r, g, b) => r > 215 && g > 160 && g < 225 && b > 110 && b < 195 && r - b > 50,
  // black times; the blue group labels are left out
  isInk: (r, g, b) => Math.max(r, g, b) < 110 && b - r < 50,
  // dark blue date
  isHeaderInk: (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b < 120,
}

export function chernihivProvider(): Provider {
  return {
    info: INFO,
    async getSchedules(ctx) {
      // the server omits its intermediate certificate
      const { bytes, headers } = await ctx.http.file(IMAGE, { region: INFO.id, ca: [SECTIGO_DV_R36] })
      const modified = Date.parse(headers.get('last-modified') ?? '')
      return parseChernihivPoster(bytes, ctx.now(), Number.isNaN(modified) ? null : new Date(modified))
    },
  }
}

/** Poster image → schedule. Exported for tests. */
export function parseChernihivPoster(
  bytes: Uint8Array,
  now: Date,
  modified: Date | null = null,
): RegionSchedule {
  const region = INFO.id
  let poster
  try {
    const img = isJpeg(bytes) ? decodeJpeg(bytes) : decodePng(bytes)
    poster = readCardPoster(img, CHERNIHIV_POSTER)
  } catch (cause) {
    throw new OutageError('parse', `Chernihiv poster: ${(cause as Error).message}`, {
      region,
      url: IMAGE,
      cause,
    })
  }
  const date = poster.date
  // a misread date would put the schedule on the wrong day; posters are for yesterday … tomorrow
  const today = kyivDate(now)
  if (!date || date < addDays(today, -2) || date > addDays(today, 2))
    throw new OutageError(
      'parse',
      `Chernihiv poster: no current date in the header (read ${date ?? 'nothing'})`,
      {
        region,
        url: IMAGE,
      },
    )
  const schedules: Record<string, DaySchedule[]> = {}
  // a card without times says "відключень не прогнозується"
  STANDARD_GROUPS.forEach((g, i) => {
    const slots = poster.cards[i]!
    schedules[g] = [makeDay(date, slots, slots.length ? undefined : 'no-outages')]
  })
  return {
    region,
    groups: [...STANDARD_GROUPS],
    schedules,
    updatedAt: modified ? toKyivIso(modified) : null,
    fetchedAt: toKyivIso(now),
  }
}
