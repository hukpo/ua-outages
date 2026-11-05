import { describe, expect, it } from 'vitest'
import { parseKharkiv } from '../../src/providers/kharkiv.js'
import { postsToSchedule } from '../../src/providers/posts.js'
import { parseZoe } from '../../src/providers/zaporizhzhia.js'
import type { DaySchedule } from '../../src/types.js'
import { fixture } from '../helpers.js'

const NOW = new Date('2026-11-05T23:40:00+02:00')
const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)

describe('schedule posts', () => {
  it('keeps the newest post per date and ignores posts without group lines', () => {
    const s = postsToSchedule(
      'kharkiv',
      [
        { title: 'ГПВ на 6 листопада', body: '1.1 08:00-10:00', publishedAt: '2026-11-05T18:00:00Z' },
        { title: 'ГПВ на 6 листопада (оновлено)', body: '1.1 09:00-10:00', publishedAt: '2026-11-05T20:00:00Z' },
        { title: 'Як зрозуміти графік', body: 'Черга — це група адрес', publishedAt: '2026-11-05T21:00:00Z' },
        { title: 'ГПВ на 1 листопада', body: '1.1 08:00-10:00', publishedAt: '2026-10-31T18:00:00Z' },
      ],
      NOW,
    )
    expect(s.schedules['1.1']!.map((d) => [d.date, ...hhmm(d)])).toEqual([['2026-11-06', '09:00-10:00']])
    expect(s.updatedAt).toBe('2026-11-05T22:00:00+02:00')
  })

  it('marks a group missing from one day as unknown', () => {
    const s = postsToSchedule(
      'kharkiv',
      [
        { title: '5 листопада', body: '1.1 08:00-10:00<br>1.2 10:00-12:00', publishedAt: '2026-11-04T18:00:00Z' },
        { title: '6 листопада', body: '1.1 08:00-10:00', publishedAt: '2026-11-05T18:00:00Z' },
      ],
      NOW,
    )
    expect(s.schedules['1.2']!.map((d) => d.status)).toEqual(['scheduled', 'unknown'])
  })
})

describe('Kharkivoblenergo', () => {
  const s = parseKharkiv(JSON.parse(fixture('kharkiv/jsonapi-newsforlenta-gpv-2026-11-05.json')), NOW)

  it('reads yesterday, today and tomorrow from the posts', () => {
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06'])
    expect(s.groups).toHaveLength(12)
  })

  it('parses the group lines', () => {
    expect(hhmm(s.schedules['1.1']!.at(-1)!)).toEqual(['00:00-03:00', '08:00-13:30', '17:00-00:00'])
    expect(hhmm(s.schedules['5.1']!.at(-1)!)).toEqual(['06:30-10:00', '13:30-20:30'])
  })

  it('rejects a changed API', () => {
    expect(() => parseKharkiv({} as never, NOW)).toThrow(/no "data"/)
  })
})

describe('Zaporizhzhiaoblenergo', () => {
  const s = parseZoe(fixture('zaporizhzhia/outage-page-2026-11-05.html'), NOW)

  it('uses the latest correction for a day', () => {
    const nov5 = s.schedules['3.1']!.find((d) => d.date === '2026-11-05')!
    // "(оновлено 21:25)" moved the evening outage end from 22:30 to 22:00
    expect(hhmm(nov5)).toEqual(['00:00-05:00', '09:00-14:00', '18:00-22:00'])
  })

  it('reads tomorrow', () => {
    const nov6 = s.schedules['1.1']!.find((d) => d.date === '2026-11-06')!
    expect(hhmm(nov6)).toEqual(['12:00-17:00', '21:00-00:00'])
  })

  it('does not invent an update time', () => {
    expect(s.updatedAt).toBeNull()
  })

  it('rejects a page without posts', () => {
    expect(() => parseZoe('<html></html>', NOW)).toThrow(/no posts/)
  })
})
