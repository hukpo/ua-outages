import { describe, expect, it } from 'vitest'
import type { PostEvent, PostInput } from '../../src/ai/types.js'
import { OutageClient } from '../../src/client.js'
import { OutageError } from '../../src/errors.js'
import {
  cherkasyPosts,
  cherkasyProvider,
  flattenPostHtml,
  recentPosts,
} from '../../src/providers/cherkasy.js'
import type { DaySchedule } from '../../src/types.js'
import { ev, expectUnpublished, fakeText, fixture, intervalsOf, mockFetch, type Route } from '../helpers.js'

const NOW = new Date('2026-11-05T23:40:00+02:00')
const API = 'https://www.cherkasyoblenergo.com/api/v1/posts'
const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)

/** "1.1 00:00-02:00, 07:00-10:00" lines, as the posts print them → a gpv start */
const day = (date: string, lines: string): PostEvent =>
  ev({
    kind: 'gpv',
    action: 'start',
    regions: ['cherkasy'],
    date,
    schedule: lines.split('\n').map((l) => {
      const [queue, hours] = l.trim().split(/ (.*)/) as [string, string]
      return { queue, intervals: intervalsOf(hours) }
    }),
  })

// What a correct model answers, transcribed from the fixtures. The site and the channel carry
// the same text; each version is named by its date and the time it went out.
const nov5 = day(
  '2026-11-05',
  `
  1.1 00:00-03:00, 07:00-10:00, 12:00-16:00, 18:00-22:00
  1.2 01:00-03:00, 06:00-10:00, 12:00-16:00, 18:00-22:00
  2.1 02:00-04:00, 08:00-11:00, 13:00-17:00, 19:00-23:00
  2.2 01:00-04:00, 07:00-11:00, 13:00-17:00, 19:00-23:00
  3.1 02:00-05:00, 08:00-12:00, 14:00-18:00, 20:00-24:00
  3.2 03:00-06:00, 08:00-12:00, 14:00-18:00, 20:00-24:00
  4.1 04:00-07:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
  4.2 03:00-06:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
  5.1 00:00-01:00, 04:00-07:00, 10:00-14:00, 16:00-20:00, 23:00-24:00
  5.2 00:00-02:00, 05:00-08:00, 10:00-14:00, 16:00-20:00
  6.1 00:00-01:00, 06:00-09:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  6.2 00:00-02:00, 06:00-09:00, 11:00-15:00, 17:00-21:00
`.trim(),
)
// "17:00 - 21:000" in the source: a model reads 21:00
const nov6 = day(
  '2026-11-06',
  `
  1.1 00:00-02:00, 07:00-10:00, 12:00-16:00, 18:00-22:00
  1.2 01:00-04:00, 07:00-11:00, 13:00-17:00, 19:00-22:00
  2.1 01:00-04:00, 06:00-10:00, 12:00-16:00, 18:00-22:00
  2.2 02:00-05:00, 07:00-11:00, 13:00-17:00, 19:00-22:00
  3.1 02:00-04:00, 08:00-12:00, 14:00-18:00, 20:00-23:00
  3.2 04:00-06:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
  4.1 02:00-04:00, 08:00-12:00, 14:00-18:00, 20:00-23:00
  4.2 04:00-07:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
  5.1 00:00-01:00, 04:00-07:00, 10:00-14:00, 16:00-20:00, 22:00-24:00
  5.2 00:00-02:00, 05:00-09:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  6.1 00:00-01:00, 04:00-07:00, 10:00-14:00, 16:00-20:00, 22:00-24:00
  6.2 00:00-02:00, 06:00-09:00, 11:00-15:00, 17:00-21:000, 23:00-24:00
`
    .trim()
    .replace('21:000', '21:00'),
)
const nov6at0750 = day(
  '2026-11-06',
  `
  1.1 07:00-10:00, 11:30-16:00, 17:30-22:00
  1.2 07:00-11:00, 12:30-17:00, 18:30-22:00
  2.1 06:00-10:30, 12:00-16:30, 18:00-22:00
  2.2 07:00-11:30, 13:00-17:30, 19:00-22:00
  3.1 08:00-12:00, 13:30-18:00, 19:30-23:00
  3.2 08:30-13:00, 14:30-19:00, 20:30-24:00
  4.1 08:00-12:30, 14:00-18:30, 20:00-23:00
  4.2 09:00-13:30, 15:00-19:30, 21:00-24:00
  5.1 09:30-14:00, 15:30-20:00, 21:30-24:00
  5.2 05:00-09:30, 11:00-15:30, 17:00-21:30, 23:00-24:00
  6.1 10:00-14:30, 16:00-20:30, 22:00-24:00
  6.2 06:00-09:00, 10:30-15:00, 16:30-21:00, 23:00-24:00
`.trim(),
)
const nov6at2207 = day(
  '2026-11-06',
  `
  1.2 18:30-23:00
  2.2 20:00-23:00
  3.1 19:30-24:00
  3.2 20:30-24:00
  4.1 21:00-24:00
  4.2 22:00-24:00
  5.1 21:30-24:00
  5.2 23:00-24:00
  6.1 22:00-24:00
  6.2 23:00-24:00
`.trim(),
)
const nov7 = day(
  '2026-11-07',
  `
  1.1 01:00-03:00, 05:00-09:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  1.2 00:00-02:00, 06:00-10:00, 12:00-16:00, 18:00-22:00
  2.1 01:00-03:00, 06:00-09:00, 11:00-15:00, 17:00-21:00
  2.2 00:00-02:00, 06:00-10:00, 12:00-16:00, 18:00-22:00
  3.1 01:00-03:00, 07:00-11:00, 13:00-17:00, 19:00-23:00
  3.2 02:00-04:00, 08:00-12:00, 14:00-18:00, 20:00-22:00
  4.1 03:00-05:00, 07:00-11:00, 13:00-17:00, 19:00-22:00
  4.2 02:00-06:00, 08:00-12:00, 14:00-18:00, 20:00-24:00
  5.1 03:00-05:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
  5.2 00:00-01:00, 05:00-07:00, 10:00-14:00, 16:00-20:00, 22:00-23:00
  6.1 00:00-01:00, 03:00-06:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
  6.2 00:00-01:00, 04:00-07:00, 10:00-14:00, 16:00-20:00, 22:00-24:00
`.trim(),
)
const nov7at2308 = day(
  '2026-11-07',
  `
  1.1 00:00-02:00, 05:00-09:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  1.2 01:00-03:00, 06:00-10:00, 12:00-16:00, 18:00-22:00
  2.1 01:00-03:00, 06:00-09:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  2.2 02:00-04:00, 06:00-10:00, 12:00-16:00, 18:00-22:00
  3.1 01:00-03:00, 07:00-11:00, 13:00-17:00, 19:00-23:00
  3.2 02:00-04:00, 08:00-12:00, 14:00-18:00, 20:00-22:00
  4.1 03:00-05:00, 07:00-11:00, 13:00-17:00, 19:00-22:00
  4.2 03:00-06:00, 08:00-12:00, 14:00-18:00, 20:00-24:00
  5.1 00:00-01:00, 03:00-05:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
  5.2 00:00-02:00, 05:00-07:00, 10:00-14:00, 16:00-20:00, 22:00-23:00
  6.1 00:00-01:00, 04:00-06:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
  6.2 00:00-01:00, 04:00-07:00, 10:00-14:00, 16:00-20:00, 22:00-24:00
`.trim(),
)
const nov7at0300 = day(
  '2026-11-07',
  `
  1.1 04:30-09:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  1.2 01:00-04:00, 05:30-10:00, 12:00-16:00, 18:00-22:00
  2.1 01:00-04:30, 06:00-09:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  2.2 02:00-04:00, 05:30-10:00, 12:00-16:00, 18:00-22:00
  3.1 01:00-05:30, 07:00-11:00, 13:00-17:00, 19:00-23:00
  3.2 02:00-06:00, 08:00-12:00, 14:00-18:00, 20:00-22:00
  4.1 03:00-05:30, 07:00-11:00, 13:00-17:00, 19:00-22:00
  4.2 03:00-06:00, 08:00-12:00, 14:00-18:00, 20:00-24:00
  5.1 03:00-06:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
  5.2 04:00-07:00, 10:00-14:00, 16:00-20:00, 22:00-23:00
  6.1 04:00-06:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
  6.2 03:00-07:00, 10:00-14:00, 16:00-20:00, 22:00-24:00
`.trim(),
)
const nov7at1635 = day(
  '2026-11-07',
  `
  1.1 17:00-21:00, 23:00-24:00
  1.2 17:30-22:00
  2.1 16:30-21:00, 23:00-24:00
  2.2 18:00-22:00
  3.1 13:00-17:30, 19:00-23:00
  3.2 14:00-18:00, 19:30-22:00
  4.1 13:00-17:00, 18:30-22:00
  4.2 14:00-18:30, 20:00-24:00
  5.1 15:00-19:00, 20:30-24:00
  5.2 16:00-20:00, 22:00-23:00
  6.1 15:00-19:30, 21:00-24:00
  6.2 16:00-20:30, 22:00-24:00
`.trim(),
)
const nov7at2117 = day(
  '2026-11-07',
  `
  1.1 23:00-24:00
  1.2 18:00-22:00
  2.1 23:00-24:00
  2.2 18:00-22:00
  3.1 19:00-23:00
  3.2 20:00-24:00
  4.1 19:00-23:00
  4.2 20:00-24:00
  5.1 21:00-24:00
  5.2 22:00-24:00
  6.1 21:00-24:00
  6.2 22:00-24:00
`.trim(),
)
const nov8 = day(
  '2026-11-08',
  `
  1.1 00:00-02:00, 05:00-07:00, 10:00-14:00, 16:00-20:00, 22:00-24:00
  1.2 00:00-03:00, 06:00-08:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  2.1 00:00-02:00, 05:00-08:00, 10:00-14:00, 16:00-20:00, 23:00-24:00
  2.2 00:00-03:00, 05:00-08:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  3.1 07:00-10:00, 12:00-16:00, 18:00-22:00
  3.2 08:00-11:00, 13:00-17:00, 19:00-22:00
  4.1 01:00-03:00, 06:00-10:00, 12:00-16:00, 18:00-22:00
  4.2 02:00-05:00, 07:00-11:00, 13:00-17:00, 19:00-23:00
  5.1 03:00-05:00, 08:00-12:00, 14:00-18:00, 20:00-23:00
  5.2 03:00-06:00, 09:00-13:00, 15:00-19:00, 21:00-23:00
  6.1 02:00-05:00, 08:00-12:00, 14:00-18:00, 20:00-24:00
  6.2 00:00-01:00, 03:00-06:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
`.trim(),
)
const nov8at2327 = day(
  '2026-11-08',
  `
  1.1 00:00-02:00, 05:00-07:00, 10:00-14:00, 16:00-20:00, 22:00-24:00
  1.2 00:00-03:00, 06:00-08:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  2.1 00:00-02:00, 05:00-08:00, 10:00-14:00, 16:00-20:00, 23:00-24:00
  2.2 00:00-03:00, 05:00-08:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  3.1 07:00-10:00, 12:00-16:00, 18:00-22:00
  3.2 08:00-11:00, 13:00-17:00, 19:00-22:00
  4.1 00:00-03:00, 06:00-10:00, 12:00-16:00, 18:00-22:00
  4.2 02:00-05:00, 07:00-11:00, 13:00-17:00, 19:00-23:00
  5.1 00:00-01:00, 03:00-05:00, 08:00-12:00, 14:00-18:00, 20:00-23:00
  5.2 00:00-01:00, 03:00-06:00, 09:00-13:00, 15:00-19:00, 21:00-23:00
  6.1 02:00-05:00, 08:00-12:00, 14:00-18:00, 20:00-24:00
  6.2 00:00-01:00, 03:00-06:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
`.trim(),
)
const nov8at0040 = day(
  '2026-11-08',
  `
  1.1 00:00-02:00, 04:00-08:00, 10:00-14:00, 16:00-20:00, 22:00-24:00
  1.2 00:00-03:00, 05:00-08:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  2.1 00:00-02:00, 04:00-08:00, 10:00-14:00, 16:00-20:00, 23:00-24:00
  2.2 00:00-03:00, 05:00-09:00, 11:00-15:00, 17:00-21:00, 23:00-24:00
  3.1 01:00-04:00, 07:00-10:00, 12:00-16:00, 18:00-22:00
  3.2 01:00-04:00, 08:00-11:00, 13:00-17:00, 19:00-22:00
  4.1 00:00-03:00, 06:00-10:00, 12:00-16:00, 18:00-22:00
  4.2 02:00-05:00, 07:00-11:00, 13:00-17:00, 19:00-23:00
  5.1 00:00-01:00, 03:00-06:00, 08:00-12:00, 14:00-18:00, 20:00-23:00
  5.2 00:00-01:00, 03:00-07:00, 09:00-13:00, 15:00-19:00, 21:00-23:00
  6.1 02:00-05:00, 08:00-12:00, 14:00-18:00, 20:00-24:00
  6.2 00:00-01:00, 03:00-07:00, 09:00-13:00, 15:00-19:00, 21:00-24:00
`.trim(),
)
const nov14 = day(
  '2026-11-14',
  `
  1.1 02:30-04:30, 08:30-10:30, 14:30-17:30, 20:30-22:30
  1.2 03:30-05:30, 09:30-12:30, 15:30-17:30, 20:30-24:00
  2.1 02:30-04:30, 08:30-11:30, 15:30-18:30, 21:30-24:00
  2.2 04:30-06:30, 09:30-12:30, 16:00-18:30, 21:30-24:00
  3.1 04:30-06:30, 10:30-13:30, 16:30-19:30, 21:30-24:00
  3.2 00:00-00:30, 05:30-07:30, 11:30-13:30, 17:30-20:30
  4.1 04:30-07:30, 10:30-13:30, 16:30-19:30, 22:30-24:00
  4.2 00:00-02:30, 06:00-08:30, 12:30-15:30, 17:30-20:30
  5.1 00:30-03:30, 06:30-08:30, 12:30-14:30, 18:30-21:30
  5.2 02:30-04:30, 07:30-09:30, 13:30-15:30, 19:30-22:00
  6.1 00:00-02:30, 06:30-09:30, 13:30-16:30, 18:30-21:30
  6.2 00:00-02:30, 07:30-10:30, 13:30-16:30, 19:30-21:30
`.trim(),
)
const nov15 = day(
  '2026-11-15',
  `
  1.1 08:00-10:00, 18:00-20:00
  1.2 20:00-22:00
  2.1 14:00-16:00
  2.2 14:00-16:00, 20:00-22:00
  3.1 08:00-10:00, 16:00-18:00, 20:00-22:00
  3.2 16:00-18:00
  4.1 10:00-12:00, 16:00-18:00, 20:00-22:00
  4.2 16:00-18:00
  5.1 10:00-12:00, 18:00-20:00, 22:00-24:00
  5.2 12:00-14:00, 18:00-20:00
  6.1 12:00-14:00, 22:00-24:00
  6.2 18:00-20:00
`.trim(),
)
const nov15at1719 = day(
  '2026-11-15',
  `
  1.1 18:00-21:00
  1.2 20:00-22:00
  2.1 19:00-21:00
  2.2 20:00-23:00
  3.1 17:00-18:00, 20:00-23:00
  3.2 17:00-19:00, 21:00-24:00
  4.1 17:00-18:00, 20:00-22:00
  4.2 17:00-18:00, 21:00-24:00
  5.1 17:30-20:00, 22:00-24:00
  5.2 17:30-20:00, 23:00-24:00
  6.1 18:00-20:00, 22:00-24:00
  6.2 18:00-20:00, 23:00-24:00
`.trim(),
)
const nov16 = day(
  '2026-11-16',
  `
  1.1 00:00-02:00, 08:00-10:00, 14:00-16:00, 18:00-20:00
  1.2 02:00-04:00, 08:00-10:00, 14:00-16:00, 19:00-21:00
  2.1 00:00-02:00, 08:00-10:00, 14:00-16:00, 18:00-20:00
  2.2 08:00-10:00, 14:00-17:00, 21:00-23:00
  3.1 04:00-06:00, 10:00-12:00, 14:00-16:00, 20:00-22:00
  3.2 10:00-12:00, 16:00-18:00, 21:00-23:00
  4.1 02:00-04:00, 10:00-12:00, 16:00-18:00, 20:00-22:00
  4.2 04:00-06:00, 10:00-12:00, 16:00-18:00, 21:00-23:00
  5.1 06:00-08:00, 12:00-14:00, 16:00-18:00, 22:00-24:00
  5.2 06:00-08:00, 12:00-14:00, 18:00-21:00, 23:00-24:00
  6.1 06:00-08:00, 12:00-14:00, 17:00-19:00, 23:00-24:00
  6.2 06:00-08:00, 12:00-14:00, 18:00-21:00, 23:00-24:00
`.trim(),
)
const nov17 = day(
  '2026-11-17',
  `
  1.1 01:00-03:00, 08:00-10:00, 13:00-15:00, 18:00-20:00
  1.2 01:00-03:00, 08:00-10:00, 14:00-17:00, 20:00-22:00
  2.1 07:00-09:00, 13:00-15:00, 19:00-21:00
  2.2 07:00-09:00, 14:00-17:00, 19:00-22:00
  3.1 03:00-05:00, 09:00-11:00, 14:00-17:00, 20:00-22:00
  3.2 10:00-12:00, 15:00-16:00, 22:00-24:00
  4.1 03:00-05:00, 09:00-11:00, 15:00-18:00, 20:00-22:00
  4.2 10:00-12:00, 16:00-18:00, 21:00-23:00
  5.1 06:00-08:00, 11:00-13:00, 17:00-19:00, 22:00-24:00
  5.2 06:00-08:00, 12:00-14:00, 17:00-20:00, 23:00-24:00
  6.1 00:00-01:00, 05:00-07:00, 12:00-14:00, 17:00-19:00, 22:00-24:00
  6.2 00:00-01:00, 05:00-07:00, 11:00-13:00, 18:00-20:00
`.trim(),
)

const gav = (extra: Partial<PostEvent> = {}) =>
  ev({ kind: 'gav', action: 'start', regions: ['cherkasy'], ...extra })
const other = ev({ kind: 'other', action: null, regions: [] })

/** By the site post's slug or the Telegram post's number */
const ANSWERS: Record<string, PostEvent[]> = {
  'hrafik-pohodynnykh-vidklyuchen-hpv-na-5-lystopada': [nov5],
  'hrafik-pohodynnykh-vidklyuchen-hpv-na-6-lystopada': [nov6],
  'hrafik-pohodynnykh-vidklyuchen-hpv-na-15-lystopada': [nov15],
  'onovleno-hrafik-pohodynnykh-vidklyuchen-hpv-na-15-lystopada': [nov15at1719],
  'hrafik-pohodynnykh-vidklyuchen-hpv-na-16-lystopada': [nov16],
  // "5 листопада з 10:35 … застосовані графіки аварійних відключень (ГАВ). Також продовжують діяти ГПВ"
  'po-cherkaskiy-oblasti-zastosovani-hrafiky-avariynykh-vidklyuchen-hav-3': [
    gav({ date: '2026-11-05', at: '10:35', gpvApplies: true }),
  ],
  'po-cherkaskiy-oblasti-zastosovani-hrafiky-avariynykh-vidklyuchen-hav-2': [gav()],
  'hotovnist-do-zymy-ta-rozvytok-servisiv-holovni-pidsumky-diyalnosti-at-cherkasyoblenerho-za-9-misyatsiv': [
    other,
  ],
  '1965': [nov6],
  '1966': [nov6at0750],
  '1967': [gav({ date: '2026-11-06', at: '12:04' })],
  '1969': [nov7],
  '1970': [nov6at2207],
  '1971': [nov7at2308],
  '1972': [nov7at0300],
  '1973': [gav({ date: '2026-11-07', at: '06:24' })],
  '1975': [other],
  '1976': [gav({ date: '2026-11-07', at: '13:29', gpvApplies: true })],
  '1977': [nov7at1635],
  '1979': [nov7at2117],
  '1980': [nov8],
  '1981': [nov8at2327],
  '1982': [nov8at0040],
  '2018': [nov14],
  '2020': [nov15],
  '2021': [nov15at1719],
  '2023': [nov16],
  // "в Уманському районі графіки погодинних відключень тимчасово не діють": one district
  '2025': [ev({ kind: 'gpv', action: 'cancel', regions: ['cherkasy'], area: 'Уманський район' })],
  // the ГОП notice
  '2026': [other],
  '2027': [nov17],
  // QUIET: ЦЕК's posts about Dnipro
  '4315': [other],
  '4316': [other],
}

const keyOf = (url: string) =>
  /\/posts\/([^?]+)\?/.exec(url)?.[1] ?? /t\.me\/\w+\/(\d+)$/.exec(url)?.[1] ?? url

/** The model; a post the table doesn't know fails the test loudly */
const answer =
  (extra: Record<string, PostEvent[]> = {}) =>
  (input: PostInput) => {
    const key = keyOf(input.url)
    const a = extra[key] ?? ANSWERS[key]
    if (!a) throw new Error(`no answer for ${input.url}`)
    return a
  }

const TG = 'https://t.me/s/pat_cherkasyoblenergo'
/** A channel page without schedule posts */
const QUIET: Route = { match: TG, body: fixture('telegram/cek_info-4315-4316.trimmed.html') }

const slugRoute = (slug: string, file: string): Route => ({
  match: `${API}/${slug}?`,
  body: fixture(`cherkasy/${file}.json`),
})
const inlinePost = (slug: string, title: string, publishedAt: string, content = '<p>…</p>'): Route => ({
  match: `${API}/${slug}?`,
  body: JSON.stringify({ data: { title, slug, publishedAt, content } }),
})

const POSTS: Route[] = [
  QUIET,
  { match: `${API}/search?`, body: fixture('cherkasy/posts-search-gpv-2026-11-05.json') },
  ...[4, 5, 6].map((d) =>
    slugRoute(`hrafik-pohodynnykh-vidklyuchen-hpv-na-${d}-lystopada`, `post-hpv-na-${d}-lystopada`),
  ),
  slugRoute('po-cherkaskiy-oblasti-zastosovani-hrafiky-avariynykh-vidklyuchen-hav-3', 'post-hav-3'),
  inlinePost(
    'po-cherkaskiy-oblasti-zastosovani-hrafiky-avariynykh-vidklyuchen-hav-2',
    'По Черкаській області застосовані графіки аварійних відключень (ГАВ)',
    '2026-11-04T05:16:00',
  ),
  inlinePost(
    'hotovnist-do-zymy-ta-rozvytok-servisiv-holovni-pidsumky-diyalnosti-at-cherkasyoblenerho-za-9-misyatsiv',
    'Готовність до зими та розвиток сервісів',
    '2026-11-05T16:10:00',
  ),
]

function client(
  routes: Route[] = POSTS,
  now = NOW,
  text: ReturnType<typeof fakeText> | null = fakeText(answer()),
) {
  const { fetch, calls } = mockFetch(routes)
  return {
    client: new OutageClient({
      fetch,
      now: () => now,
      cacheTtlMs: 0,
      providers: [cherkasyProvider()],
      ...(text ? { textProcessor: text } : {}),
    }),
    calls,
  }
}

describe('Cherkasyoblenergo', () => {
  it('reads today and tomorrow, fetching only the posts since yesterday', async () => {
    const text = fakeText(answer())
    const { client: c, calls } = client(POSTS, NOW, text)
    const s = await c.getSchedules('cherkasy')
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
    // the search list plus the five posts of 4.11 and 5.11; the ГАВ notices and the report are
    // read too, and are no schedule
    const site = calls.filter((c) => c.url.startsWith(API))
    expect(site).toHaveLength(6)
    expect(site.some((c) => c.url.includes('na-4-lystopada'))).toBe(false)
    expect(text.calls.filter((c) => c.source.kind === 'site')).toHaveLength(5)
  })

  it('reads the hours of each queue', async () => {
    const s = await client().client.getSchedules('cherkasy')
    const nov6 = (g: string) => s.schedules[g]!.find((d) => d.date === '2026-11-06')!
    expect(nov6('1.1').intervals[0]).toEqual({
      from: '2026-11-06T00:00:00+02:00',
      to: '2026-11-06T02:00:00+02:00',
      kind: 'off',
    })
    expect(hhmm(nov6('1.1'))).toEqual(['00:00-02:00', '07:00-10:00', '12:00-16:00', '18:00-22:00'])
    // "24:00" ends at midnight
    expect(hhmm(nov6('3.2'))).toEqual(['04:00-06:00', '09:00-13:00', '15:00-19:00', '21:00-00:00'])
    expect(nov6('3.2').intervals.at(-1)!.to).toBe('2026-11-07T00:00:00+02:00')
  })

  it('reports the newest publish time in Kyiv time', async () => {
    const s = await client().client.getSchedules('cherkasy')
    // "publishedAt": "2026-11-05T20:25:00" is Kyiv wall-clock time
    expect(s.updatedAt).toBe('2026-11-05T20:25:00+02:00')
  })

  it('hands the processor each post with its title, flattened text and Kyiv time', () => {
    const [p] = cherkasyPosts([JSON.parse(fixture('cherkasy/post-hpv-na-6-lystopada.json')).data])
    expect(p).toMatchObject({
      url: `${API}/hrafik-pohodynnykh-vidklyuchen-hpv-na-6-lystopada?lang=uk`,
      title: 'Графік погодинних відключень (ГПВ) на 6 листопада',
      publishedAt: '2026-11-05T20:25:00+02:00',
      source: { kind: 'site', site: 'https://www.cherkasyoblenergo.com/off' },
    })
    expect(p!.text).toContain('1.1 00:00 - 02:00, 07:00 - 10:00, 12:00 - 16:00, 18:00 - 22:00')
    expect(p!.text).not.toMatch(/<|&nbsp;/)
  })

  it('picks the posts since the start of yesterday, newest first, at most twenty', () => {
    const search = JSON.parse(fixture('cherkasy/posts-search-gpv-2026-11-17T0056.json'))
    // since 14.11 00:00: the post for 14.11 went out on 13.11 23:28
    expect(recentPosts(search, new Date('2026-11-15T21:00:00+02:00'))).toEqual([
      'hrafik-pohodynnykh-vidklyuchen-hpv-na-16-lystopada',
      'onovleno-hrafik-pohodynnykh-vidklyuchen-hpv-na-15-lystopada',
      'hrafik-pohodynnykh-vidklyuchen-hpv-na-15-lystopada',
    ])
    expect(recentPosts(search, new Date('2026-11-17T12:00:00+02:00'))).toEqual([])
    const many = {
      data: {
        content: Array.from({ length: 24 }, (_, i) => ({
          slug: `p${i}`,
          // no publishedAt: the creation time
          createdAt: `2026-11-17T${String(i).padStart(2, '0')}:00:00`,
        })),
      },
    }
    expect(recentPosts(many, new Date('2026-11-17T23:30:00+02:00'))).toEqual(
      Array.from({ length: 20 }, (_, i) => `p${23 - i}`),
    )
  })

  it('returns an empty schedule when no recent post is a schedule', async () => {
    const search = JSON.parse(fixture('cherkasy/posts-search-gpv-2026-11-05.json'))
    search.data.content = search.data.content.filter((p: { title: string }) => !/ГПВ/.test(p.title))
    const s = await client([
      ...POSTS.slice(0, 1),
      { match: `${API}/search?`, body: JSON.stringify(search) },
      ...POSTS.slice(2),
    ]).client.getSchedules('cherkasy')
    // nothing published is not "no outages": the groups stay listed, unknown
    expectUnpublished(s, 12)
    expect(s.updatedAt).toBeNull()
  })

  it('rejects a changed search API', async () => {
    const err = await client([
      { match: TG, status: 404, body: '' },
      { match: `${API}/search?`, body: '{"success":true,"data":[]}' },
    ])
      .client.getSchedules('cherkasy')
      .catch((e) => e)
    expect(err).toBeInstanceOf(OutageError)
    expect(err.code).toBe('parse')
  })

  it('rejects a post without content', async () => {
    const s = await client([
      ...POSTS.filter((r) => !String(r.match).includes('na-6-lystopada')),
      { match: `${API}/hrafik-pohodynnykh-vidklyuchen-hpv-na-6-lystopada?`, body: '{"data":{"title":"x"}}' },
    ]).client.getSchedules('cherkasy')
    expect(s.sources![0]).toMatchObject({
      ok: false,
      error: { code: 'parse', message: expect.stringContaining('no "content"') },
    })
  })

  it('a misread newest schedule post: the day as read before it, flagged (read again on the next poll)', async () => {
    // "24:30" for the post of 5.11 20:25 (tomorrow's schedule)
    const text = fakeText(
      answer({ 'hrafik-pohodynnykh-vidklyuchen-hpv-na-6-lystopada': [day('2026-11-06', '1.1 22:00-24:30')] }),
    )
    const s = await client(POSTS, NOW, text).client.getSchedules('cherkasy')
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: true })
    expect(s.sources![0]!.unread!.map((u) => u.date)).toContain('2026-11-06')
  })

  it('a misread post flags the days it may be about; the day a later post gives stands', async () => {
    const text = fakeText(
      answer({ 'hrafik-pohodynnykh-vidklyuchen-hpv-na-5-lystopada': [day('2026-11-05', '1.1 22:00-24:30')] }),
    )
    const s = await client(POSTS, NOW, text).client.getSchedules('cherkasy')
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: true })
    expect(s.sources![0]!.unread!.map((u) => u.date)).toEqual(['2026-11-05'])
    expect(s.schedules['1.1']!.find((d) => d.date === '2026-11-06')!.status).not.toBe('unknown')
  })

  // a post whose hours are only in a picture (Cherkasy has no picture reader): its day is not
  // known, published as such, so an older version doesn't pass for it
  it('the newest schedule post with its hours only in a picture leaves the day not known', async () => {
    const text = fakeText(
      answer({
        'hrafik-pohodynnykh-vidklyuchen-hpv-na-6-lystopada': [
          ev({ kind: 'gpv', action: 'start', regions: ['cherkasy'], date: '2026-11-06' }),
        ],
      }),
    )
    const s = await client(POSTS, NOW, text).client.getSchedules('cherkasy')
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: true })
    expect(s.schedules['1.1']!.find((d) => d.date === '2026-11-06')!.status).toBe('unknown')
  })

  it('flattens the hand-edited HTML', () => {
    expect(
      flattenPostHtml('<p>1.1&nbsp;<span>00</span><span> :00 - 02:00,&nbsp;</span></p><p>1.2 x</p>'),
    ).toBe('1.1 00:00 - 02:00, \n1.2 x\n')
  })

  it('needs a text processor', async () => {
    await expect(client(POSTS, NOW, null).client.getSchedules('cherkasy')).rejects.toMatchObject({
      code: 'config',
      message: expect.stringContaining('textProcessor'),
    })
  })
})

describe('Cherkasyoblenergo: updates and the Telegram channel', () => {
  const SEARCH: Route = {
    match: `${API}/search?`,
    body: fixture('cherkasy/posts-search-gpv-2026-11-17T0056.json'),
  }
  const NEW: Route = {
    match: TG,
    body: fixture('cherkasy/telegram-pat_cherkasyoblenergo-2018-2027.trimmed.html'),
  }
  const site = (slug: string): Route => ({
    match: `${API}/${slug.includes('onovleno') ? 'onovleno-hrafik-pohodynnykh-vidklyuchen-hpv-na-15-lystopada' : `hrafik-pohodynnykh-vidklyuchen-${slug}`}?`,
    body: fixture(`cherkasy/post-${slug}.json`),
  })

  it('layers an update onto the day instead of replacing it', async () => {
    // 15.11: the first post (14.11 19:42) and "Оновлено …" (15.11 17:19), which lists only
    // the hours from 17:00 on
    const search = (slugs: [string, string][]) => ({
      match: `${API}/search?`,
      body: JSON.stringify({
        data: { content: slugs.map(([slug, publishedAt]) => ({ slug, publishedAt })) },
      }),
    })
    const first: [string, string] = [
      'hrafik-pohodynnykh-vidklyuchen-hpv-na-15-lystopada',
      '2026-11-14T19:42:00',
    ]
    const update: [string, string] = [
      'onovleno-hrafik-pohodynnykh-vidklyuchen-hpv-na-15-lystopada',
      '2026-11-15T17:19:00',
    ]
    const routes = [QUIET, site('hpv-na-15-lystopada'), site('onovleno-hpv-na-15-lystopada')]
    const now = new Date('2026-11-15T18:00:00+02:00')
    const before = await client([search([first]), ...routes], now).client.getSchedules('cherkasy')
    expect(hhmm(before.schedules['1.1']![0]!)).toEqual(['08:00-10:00', '18:00-20:00'])
    const s = await client([search([update, first]), ...routes], now).client.getSchedules('cherkasy')
    // the morning stays, the evening is the update's "1.1 18:00 - 21:00"
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['08:00-10:00', '18:00-21:00'])
    // 3.1: "08:00 - 10:00, 16:00 - 18:00, 20:00 - 22:00" cut at 17:19, then "17:00 - 18:00, 20:00 - 23:00"
    expect(hhmm(s.schedules['3.1']![0]!)).toEqual(['08:00-10:00', '16:00-18:00', '20:00-23:00'])
    expect(s.updatedAt).toBe('2026-11-15T17:19:00+02:00')
  })

  it('takes tomorrow from Telegram while the site has no post for it', async () => {
    // 17.11 00:56: the search has nothing since yesterday; post 2027 (16.11 23:45) has 17.11
    const { client: c, calls } = client([SEARCH, NEW], new Date('2026-11-17T00:56:00+02:00'))
    const s = await c.getSchedules('cherkasy')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual([
      '01:00-03:00',
      '08:00-10:00',
      '13:00-15:00',
      '18:00-20:00',
    ])
    expect(hhmm(s.schedules['1.2']![0]!)).toEqual([
      '01:00-03:00',
      '08:00-10:00',
      '14:00-17:00',
      '20:00-22:00',
    ])
    expect(s.updatedAt).toBe('2026-11-16T23:45:53+02:00')
    expect(s.sources).toMatchObject([
      { id: 'site', ok: true, dates: [] },
      { id: 'telegram:@pat_cherkasyoblenergo', ok: true, dates: ['2026-11-17'] },
    ])
    // one search, one channel page
    expect(calls).toHaveLength(2)
  })

  it('reads both for the same day: the later publication wins, the texts agree', async () => {
    const { client: c } = client(
      [SEARCH, NEW, site('hpv-na-16-lystopada'), site('onovleno-hpv-na-15-lystopada')],
      new Date('2026-11-16T23:50:00+02:00'),
    )
    const s = await c.getSchedules('cherkasy')
    expect(s.schedules['1.1']!.filter((d) => d.date >= '2026-11-16').map((d) => d.date)).toEqual([
      '2026-11-16',
      '2026-11-17',
    ])
    const nov16 = s.schedules['1.1']!.find((d) => d.date === '2026-11-16')!
    expect(hhmm(nov16)).toEqual(['00:00-02:00', '08:00-10:00', '14:00-16:00', '18:00-20:00'])
    // site 15.11 20:58, Telegram 21:06; the ГОП notice (2026) and the district notice (2025)
    // in the channel are not schedules
    expect(s.sources![1]).toMatchObject({
      id: 'telegram:@pat_cherkasyoblenergo',
      ok: true,
      dates: ['2026-11-16', '2026-11-17'],
    })
    expect(s.sources!.some((x) => x.disagrees)).toBe(false)
  })

  // The site fetches posts since yesterday 00:00, so yesterday's first post (the evening before)
  // is outside the window and an update of yesterday stands alone as the whole of it. The
  // channel reader drops yesterday for exactly this reason (`readChannelPosts`); `readSite` in
  // src/providers/cherkasy.ts doesn't.
  it('does not serve yesterday from its afternoon update alone', async () => {
    const { client: c } = client(
      [SEARCH, NEW, site('hpv-na-16-lystopada'), site('onovleno-hpv-na-15-lystopada')],
      new Date('2026-11-16T23:50:00+02:00'),
    )
    const s = await c.getSchedules('cherkasy')
    // 15.11 from "Оновлено … на 15 листопада" (17:19) alone: 1.1 "18:00 - 21:00", the
    // morning's 08:00 - 10:00 lost
    expect(s.schedules['1.1']!.map((d) => d.date)).not.toContain('2026-11-15')
  })

  it('builds a day of five versions from the channel when the site is down', async () => {
    // 07.11: first post 06.11 20:03, updates at 23:08, 03:00, 16:35 and 21:17, each listing
    // only what is still ahead
    const { client: c } = client(
      [
        { match: `${API}/search?`, status: 500, body: '' },
        { match: TG, body: fixture('cherkasy/telegram-pat_cherkasyoblenergo-1965-1982.trimmed.html') },
      ],
      new Date('2026-11-07T23:40:00+02:00'),
    )
    const s = await c.getSchedules('cherkasy')
    const nov7 = (g: string) => hhmm(s.schedules[g]!.find((d) => d.date === '2026-11-07')!)
    expect(nov7('1.1')).toEqual(['00:00-02:00', '04:30-09:00', '11:00-15:00', '17:00-21:00', '23:00-00:00'])
    expect(nov7('2.1')).toEqual(['01:00-04:30', '06:00-09:00', '11:00-15:00', '16:30-21:00', '23:00-00:00'])
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: false, error: { code: 'http' } })
    // yesterday isn't rebuilt from its last update alone
    expect(s.schedules['1.1']!.some((d) => d.date === '2026-11-06')).toBe(false)
  })

  it('fails with the site error when both are down', async () => {
    await expect(
      client([
        { match: `${API}/search?`, status: 500, body: '' },
        { match: TG, status: 500, body: '' },
      ]).client.getSchedules('cherkasy'),
    ).rejects.toMatchObject({ code: 'http', message: expect.stringContaining('cherkasyoblenergo.com') })
  })
})

describe('Cherkasyoblenergo: cancellations', () => {
  const search = {
    data: {
      content: [
        {
          title: 'Скасовано застосування графіків аварійних відключень (ГАВ), діють ГПВ',
          slug: 'skasovano-hav',
          publishedAt: '2026-11-17T11:00:00',
        },
        {
          title: 'Скасовано застосування графіків погодинних відключень (ГПВ)',
          slug: 'skasovano-hpv',
          publishedAt: '2026-11-17T10:00:00',
        },
        {
          title: 'Графік погодинних відключень (ГПВ) на 17 листопада',
          slug: 'hpv-17',
          publishedAt: '2026-11-16T20:00:00',
        },
        {
          title: 'Скасовано застосування графіків погодинних відключень (ГПВ)',
          slug: 'skasovano-hpv-old',
          publishedAt: '2026-11-14T10:00:00',
        },
      ],
    },
  }
  const now = new Date('2026-11-17T12:00:00+02:00')
  const text = () =>
    fakeText(
      answer({
        'skasovano-hav': [ev({ kind: 'gav', action: 'cancel', regions: ['cherkasy'], gpvApplies: true })],
        'skasovano-hpv': [ev({ kind: 'gpv', action: 'cancel', regions: ['cherkasy'], date: '2026-11-17' })],
        'hpv-17': [day('2026-11-17', '1.1 08:00-12:00, 18:00-22:00')],
      }),
    )
  const routes: Route[] = [
    { match: `${API}/search`, body: JSON.stringify(search) },
    inlinePost(
      'skasovano-hav',
      search.data.content[0]!.title,
      '2026-11-17T11:00:00',
      '<p>Скасовано ГАВ, діють ГПВ.</p>',
    ),
    inlinePost(
      'skasovano-hpv',
      search.data.content[1]!.title,
      '2026-11-17T10:00:00',
      '<p>За розпорядженням НЕК «Укренерго» графіки погодинних відключень на 17 листопада скасовано.</p>',
    ),
    inlinePost(
      'hpv-17',
      search.data.content[2]!.title,
      '2026-11-16T20:00:00',
      '<p>1.1 08:00 - 12:00, 18:00 - 22:00</p>',
    ),
    QUIET,
  ]

  it('fetches every recent post, and no old one', async () => {
    const { client: c, calls } = client(routes, now, text())
    await c.getSchedules('cherkasy')
    expect(calls.map((x) => x.url).filter((u) => u.startsWith(API) && !u.includes('/search'))).toEqual([
      `${API}/skasovano-hav?lang=uk`,
      `${API}/skasovano-hpv?lang=uk`,
      `${API}/hpv-17?lang=uk`,
    ])
  })

  it('leaves the day not known once the schedule is called off, merged with Telegram', async () => {
    const s = await client(routes, now, text()).client.getSchedules('cherkasy')
    expect(s.schedules['1.1']).toEqual([{ date: '2026-11-17', status: 'unknown', intervals: [] }])
    expect(s.updatedAt).toBe('2026-11-17T10:00:00+02:00')
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: true, dates: ['2026-11-17'] })
  })
})
