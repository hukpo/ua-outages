import { describe, expect, it } from 'vitest'
import { parseKharkiv } from '../../src/providers/kharkiv.js'
import { daysToSource, layerPublications, postsToDays, postsToSchedule } from '../../src/providers/posts.js'
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
        {
          title: 'ГПВ на 6 листопада (оновлено)',
          body: '1.1 09:00-10:00',
          publishedAt: '2026-11-05T20:00:00Z',
        },
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
        {
          title: '5 листопада',
          body: '1.1 08:00-10:00<br>1.2 10:00-12:00',
          publishedAt: '2026-11-04T18:00:00Z',
        },
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

  it('reports the operator\'s own "(оновлено HH:MM)", not the fetch time', () => {
    // "ОНОВЛЕНО ГПВ НА 5 ЛИСТОПАДА … (оновлено 21:25)"; the first post for 6.11 carries no time
    expect(s.updatedAt).toBe('2026-11-05T21:25:00+02:00')
  })

  it('rejects a page without posts', () => {
    expect(() => parseZoe('<html></html>', NOW)).toThrow(/no posts/)
  })

  it('reads a group left out of a post as no outages, not unknown', () => {
    // the 18:21 correction for Nov 14 lists only six groups; 1.1 had 23:30–24:00 before it
    const s = parseZoe(
      fixture('zaporizhzhia/outage-page-2026-11-14.html'),
      new Date('2026-11-14T23:30:00+02:00'),
    )
    expect(s.groups).toHaveLength(12)
    const nov14 = (g: string) => s.schedules[g]!.find((d) => d.date === '2026-11-14')!
    expect(nov14('1.1')).toMatchObject({ status: 'scheduled', intervals: [] })
    expect(hhmm(nov14('3.1'))).toEqual(['00:00-01:00', '15:30-19:00'])
    // and on Nov 15, where 2.2 isn't listed
    const nov15 = s.schedules['2.2']!.find((d) => d.date === '2026-11-15')!
    expect(nov15).toMatchObject({ status: 'scheduled', intervals: [] })
    expect(
      Object.values(s.schedules)
        .flat()
        .some((d) => d.status === 'unknown'),
    ).toBe(false)
  })
})

describe('updates that list only the hours ahead', () => {
  const off = (start: number, end: number) => ({ start: start * 60, end: end * 60, kind: 'off' as const })

  it('keeps the earlier outages before the update takes effect and replaces the rest', () => {
    const { groups } = layerPublications([
      {
        from: 0,
        groups: { '1.1': [off(10, 14), off(20, 24)], '5.1': [off(6, 10), off(16, 20)], '2.1': [off(1, 2)] },
      },
      // "оновлено з 15:00": 1.1 listed again, 5.1 changed, 2.1 not listed (nothing more today)
      { from: 15 * 60, groups: { '1.1': [off(20, 24)], '5.1': [off(18, 20)], '6.1': [off(15, 18)] } },
    ])
    expect(groups['1.1']).toEqual([off(10, 14), off(20, 24)])
    // 16:00-20:00 was replaced by 18:00-20:00
    expect(groups['5.1']).toEqual([off(6, 10), off(18, 20)])
    expect(groups['2.1']).toEqual([off(1, 2)])
    // not in the first publication: only what the update says
    expect(groups['6.1']).toEqual([off(15, 18)])
  })

  it('cuts an outage in progress at the update and lets a re-listed one merge', () => {
    const { groups } = layerPublications([
      { from: 0, groups: { '4.1': [off(14, 18)], '4.2': [off(14, 18)] } },
      { from: 15 * 60, groups: { '4.1': [off(14, 19)] } },
    ])
    expect(groups['4.1']).toEqual([off(14, 15), off(14, 19)])
    expect(groups['4.2']).toEqual([off(14, 15)])
  })

  it('takes a publication made before the day as the whole day', () => {
    const { groups } = layerPublications([
      { from: 0, groups: { '1.1': [off(10, 14)], '1.2': [off(1, 2)] } },
      { from: 0, groups: { '1.1': [off(3, 6)] } },
    ])
    expect(groups).toEqual({ '1.1': [off(3, 6)] })
  })

  it('leaves a group named without times, and a cancelled day, not known', () => {
    expect(
      layerPublications([
        { from: 0, groups: { '1.1': [off(10, 14)] } },
        { from: 600, groups: { '1.1': null } },
      ]).groups,
    ).toEqual({ '1.1': null })
    const cancelled = layerPublications([
      { from: 0, groups: { '1.1': [off(10, 14)] } },
      { from: 600, groups: {}, cancelled: true },
    ])
    expect(cancelled).toEqual({ groups: {}, cancelled: true })
  })

  it('layers by post time: a post at 17:26 about today replaces only what is ahead', () => {
    const s = postsToSchedule(
      'cherkasy',
      [
        {
          title: 'ГПВ на 15 листопада',
          body: '1.1 08:00 - 10:00, 18:00 - 20:00\n1.2 09:00 - 11:00',
          publishedAt: '2026-11-14T19:42:00+02:00',
        },
        {
          title: 'Оновлено ГПВ на 15 листопада',
          body: '1.1 18:00 - 21:00',
          publishedAt: '2026-11-15T17:26:00+02:00',
        },
      ],
      new Date('2026-11-15T18:00:00+02:00'),
      { updates: 'layer' },
    )
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['08:00-10:00', '18:00-21:00'])
    expect(hhmm(s.schedules['1.2']![0]!)).toEqual(['09:00-11:00'])
    expect(s.updatedAt).toBe('2026-11-15T17:26:00+02:00')
    // the default still takes the newest post as the whole day
    const replaced = postsToSchedule(
      'cherkasy',
      [
        {
          title: 'ГПВ на 15 листопада',
          body: '1.1 08:00 - 10:00, 18:00 - 20:00',
          publishedAt: '2026-11-14T19:42:00+02:00',
        },
        {
          title: 'Оновлено ГПВ на 15 листопада',
          body: '1.1 18:00 - 21:00',
          publishedAt: '2026-11-15T17:26:00+02:00',
        },
      ],
      new Date('2026-11-15T18:00:00+02:00'),
    )
    expect(hhmm(replaced.schedules['1.1']![0]!)).toEqual(['18:00-21:00'])
  })
})

describe('which day a post is about, and which posts are schedules', () => {
  const day = (body: string, publishedAt: string, title = '') => [
    ...postsToDays([{ title, body, publishedAt }], new Date(publishedAt)).keys(),
  ]

  it('takes the date from the text, not from the post time', () => {
    // posted at 23:45 about tomorrow; at 00:20 about the day that has just begun
    expect(
      day(
        '17 листопада з 00:00 до 24:00 будуть застосовані ГПВ.\n1.1 01:00 - 03:00',
        '2026-11-16T23:45:53+02:00',
      ),
    ).toEqual(['2026-11-17'])
    expect(day('Оновлено ГПВ на 17 листопада\n1.1 01:00 - 03:00', '2026-11-17T00:20:00+02:00')).toEqual([
      '2026-11-17',
    ])
  })

  it('reads "сьогодні" and "завтра" from the post\'s own time when no date is given', () => {
    expect(day('Оновлено графік на сьогодні:\n1.1 01:00 - 03:00', '2026-11-17T00:20:00+02:00')).toEqual([
      '2026-11-17',
    ])
    expect(day('Завтра діятимуть ГПВ:\n1.1 01:00 - 03:00', '2026-11-16T23:45:00+02:00')).toEqual([
      '2026-11-17',
    ])
    // a date beside the word wins
    expect(day('ГПВ на сьогодні, 15 листопада:\n1.1 01:00 - 03:00', '2026-11-15T17:38:00+02:00')).toEqual([
      '2026-11-15',
    ])
    // no date and no such word: the post time alone never dates a schedule
    expect(day('Графік:\n1.1 01:00 - 03:00', '2026-11-16T23:45:00+02:00')).toEqual([])
  })

  it('crosses the year', () => {
    expect(day('ГПВ на 1 січня\n1.1 01:00 - 03:00', '2026-12-31T21:00:00+02:00')).toEqual(['2027-01-01'])
    expect(day('Завтра діятимуть ГПВ\n1.1 01:00 - 03:00', '2026-12-31T21:00:00+02:00')).toEqual([
      '2027-01-01',
    ])
    expect(day('Оновлено ГПВ на 31 грудня\n1.1 22:00 - 24:00', '2027-01-01T00:05:00+02:00')).toEqual([
      '2026-12-31',
    ])
  })

  it('splits a post about two days and never joins their hours', () => {
    const body =
      'ГПВ на 16 листопада:\n1.1 08:00-10:00\n1.2 09:00-11:00\nГПВ на 17 листопада:\n1.1 18:00-20:00'
    const days = postsToDays(
      [{ title: '', body, publishedAt: '2026-11-15T20:00:00+02:00' }],
      new Date('2026-11-15T21:00:00+02:00'),
    )
    expect([...days.keys()]).toEqual(['2026-11-16', '2026-11-17'])
    expect(days.get('2026-11-16')!.groups['1.1']).toEqual([{ start: 480, end: 600, kind: 'off' }])
    expect(days.get('2026-11-17')!.groups['1.1']).toEqual([{ start: 1080, end: 1200, kind: 'off' }])
    // two sets of hours for one group under one date: which is meant can't be told
    const twice = postsToDays(
      [
        {
          title: 'ГПВ на 16 листопада',
          body: '1.1 08:00-10:00\nЗавтра:\n1.1 18:00-20:00',
          publishedAt: '2026-11-15T20:00:00+02:00',
        },
      ],
      new Date('2026-11-15T21:00:00+02:00'),
    )
    expect(twice.get('2026-11-16')!.groups['1.1']).toBeNull()
  })

  it('ignores emergency notices even when they list queues and hours', () => {
    expect(
      day(
        '16 листопада з 12:04 застосовані графіки аварійних відключень (ГАВ).\nЧерги 1.1, 1.2 з 12:00 до 16:00',
        '2026-11-16T12:11:00+02:00',
      ),
    ).toEqual([])
    // but not a schedule post that mentions them
    expect(
      day(
        'ГАВ скасовано. Графік погодинних відключень на 16 листопада:\n1.1 12:00-16:00',
        '2026-11-16T12:11:00+02:00',
      ),
    ).toEqual(['2026-11-16'])
  })

  it('turns a cancelled day into unknown: neither the old hours nor "no outages"', () => {
    const posts = [
      {
        title: 'ГПВ на 16 листопада',
        body: '1.1 08:00-10:00\n1.2 09:00-11:00',
        publishedAt: '2026-11-15T20:00:00+02:00',
      },
      {
        title: '',
        body: 'Графіки погодинних відключень на 16 листопада скасовано.',
        publishedAt: '2026-11-16T07:00:00+02:00',
      },
    ]
    const s = postsToSchedule('kharkiv', posts, new Date('2026-11-16T08:00:00+02:00'), { omitted: 'none' })
    expect(s.schedules['1.1']).toEqual([{ date: '2026-11-16', status: 'unknown', intervals: [] }])
    expect(s.schedules['1.2']).toEqual([{ date: '2026-11-16', status: 'unknown', intervals: [] }])
    // what is not a cancellation of the day: ГАВ lifted, a district, a condition
    for (const body of [
      'Аварійні обмеження електропостачання скасовані! Продовжують діяти графіки погодинних відключень на 16 листопада.',
      'Графіки аварійних відключень (ГАВ) 16 листопада будуть скасовані після стабілізації ситуації.',
      'В Уманському районі графіки погодинних відключень тимчасово не діють.',
    ]) {
      const kept = postsToSchedule(
        'kharkiv',
        [posts[0]!, { title: '', body, publishedAt: '2026-11-16T07:00:00+02:00' }],
        new Date('2026-11-16T08:00:00+02:00'),
      )
      expect(hhmm(kept.schedules['1.1']![0]!)).toEqual(['08:00-10:00'])
    }
  })

  it('leaves "графік уточнюється" unknown', () => {
    const s = postsToSchedule(
      'kharkiv',
      [
        {
          title: 'ГПВ на 16 листопада',
          body: '1.1 08:00-10:00\n1.2: графік уточнюється',
          publishedAt: '2026-11-15T20:00:00+02:00',
        },
      ],
      new Date('2026-11-15T21:00:00+02:00'),
      { omitted: 'none' },
    )
    expect(s.schedules['1.2']).toEqual([{ date: '2026-11-16', status: 'unknown', intervals: [] }])
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['08:00-10:00'])
  })

  it('takes the day the schedule is for, not the day it was said on', () => {
    const base = {
      title: 'Графік погодинних відключень (ГПВ) на 17 листопада',
      body: '1.1 08:00 - 10:00, 18:00 - 20:00\n2.1 07:00 - 09:00, 19:00 - 21:00',
      publishedAt: '2026-11-16T23:45:00+02:00',
    }
    const s = postsToSchedule(
      'cherkasy',
      [
        base,
        {
          title: '',
          body: 'Станом на 22:00 17 листопада оновлено графік погодинних відключень (ГПВ) на 18 листопада:\n1.1 00:00 - 04:00, 12:00 - 16:00',
          publishedAt: '2026-11-17T22:05:00+02:00',
        },
      ],
      new Date('2026-11-17T22:10:00+02:00'),
      { updates: 'layer' },
    )
    expect(s.schedules['1.1']!.map((d) => [d.date, ...hhmm(d)])).toEqual([
      ['2026-11-17', '08:00-10:00', '18:00-20:00'],
      ['2026-11-18', '00:00-04:00', '12:00-16:00'],
    ])
    // "(оновлено о 23:00, 15.11.2026)" after the day's own date is a stamp, not a second day
    const stamped = postsToDays(
      [
        {
          title: '',
          body: 'Оновлено графік погодинних відключень на 16 листопада (оновлено о 23:00, 15.11.2026)\n1.1 08:00-10:00',
          publishedAt: '',
        },
      ],
      new Date('2026-11-15T23:30:00+02:00'),
    )
    expect([...stamped.keys()]).toEqual(['2026-11-16'])
  })

  it('gives no day to a post that names two and does not say which the schedule is for', () => {
    const now = new Date('2026-11-17T16:00:00+02:00')
    for (const body of [
      // two dates, neither after "на"
      '17 листопада та 18 листопада діятимуть графіки погодинних відключень:\n1.1 18:00-22:00',
      // "сьогодні" and "завтра" in the opening, no date
      'Оновлений ГПВ на сьогодні. Графік на завтра оприлюднимо ввечері.\n1.1 18:00-22:00',
    ])
      expect(
        postsToDays([{ title: '', body, publishedAt: '2026-11-17T15:00:00+02:00' }], now).size,
        body,
      ).toBe(0)
    // one of the words alone still dates the post
    const tomorrow = postsToDays(
      [{ title: '', body: 'ГПВ на завтра:\n1.1 18:00-22:00', publishedAt: '2026-11-17T15:00:00+02:00' }],
      now,
    )
    expect([...tomorrow.keys()]).toEqual(['2026-11-18'])
  })

  it('an update that names some groups only leaves the rest of the others not known, unless only groups with outages are listed', () => {
    const posts = [
      {
        title: 'Графік погодинних відключень (ГПВ) на 17 листопада',
        body: '1.1 08:00 - 10:00, 18:00 - 20:00\n2.1 07:00 - 09:00, 19:00 - 21:00\n3.1 03:00 - 05:00',
        publishedAt: '2026-11-16T23:45:00+02:00',
      },
      {
        title: 'Оновлення графіка погодинних відключень (ГПВ) на 17 листопада',
        body: 'Зміни для черги 1.1:\n1.1 16:00 - 20:00',
        publishedAt: '2026-11-17T15:00:00+02:00',
      },
    ]
    const now = new Date('2026-11-17T15:30:00+02:00')
    // the operator lists all its groups in every post: this one is about 1.1 alone
    const all = postsToSchedule('cherkasy', posts, now, { updates: 'layer' })
    expect(hhmm(all.schedules['1.1']![0]!)).toEqual(['08:00-10:00', '16:00-20:00'])
    expect(all.schedules['2.1']![0]).toEqual({ date: '2026-11-17', status: 'unknown', intervals: [] })
    // nothing of 3.1 was left for after 15:00: its day stands
    expect(hhmm(all.schedules['3.1']![0]!)).toEqual(['03:00-05:00'])
    // the operator lists only the groups that have outages: 2.1 has none any more
    const some = postsToSchedule('khmelnytskyi', posts, now, { updates: 'layer', omitted: 'none' })
    expect(hhmm(some.schedules['2.1']![0]!)).toEqual(['07:00-09:00'])
    expect(some.schedules['2.1']![0]!.status).toBe('scheduled')
  })

  it('reads a table row by row', () => {
    const days = postsToDays(
      [
        {
          title: 'ГПВ на 17 листопада',
          body: '<table><tr><td>1.1</td><td>07:00-10:00</td></tr><tr><td>1.2</td><td>10:00-13:00</td></tr></table>',
          publishedAt: '2026-11-16T20:00:00+02:00',
        },
      ],
      new Date('2026-11-16T21:00:00+02:00'),
    )
    expect(days.get('2026-11-17')!.groups).toEqual({
      '1.1': [{ start: 420, end: 600, kind: 'off' }],
      '1.2': [{ start: 600, end: 780, kind: 'off' }],
    })
  })

  it('hands a cancelled day to mergeSources as a publication of its own', () => {
    const days = postsToDays(
      [
        { title: 'ГПВ на 16 листопада', body: '1.1 08:00-10:00', publishedAt: '2026-11-15T20:00:00+02:00' },
        {
          title: '',
          body: 'Графіки погодинних відключень на 16 листопада скасовано.',
          publishedAt: '2026-11-16T07:00:00+02:00',
        },
      ],
      new Date('2026-11-16T08:00:00+02:00'),
    )
    expect(daysToSource(days).days['2026-11-16']).toEqual({
      schedules: { '1.1': { date: '2026-11-16', status: 'unknown', intervals: [] } },
      cancelled: true,
      publishedAt: '2026-11-16T07:00:00+02:00',
    })
  })
})
