import { describe, expect, it } from 'vitest'
import { siteInput, type Analyzed } from '../../src/ai/posts.js'
import type { PostEvent } from '../../src/ai/types.js'
import {
  daysToSource,
  layerPublications,
  postsToDays,
  postsToSchedule,
  statedTime,
} from '../../src/providers/posts.js'
import type { DaySchedule, RegionId } from '../../src/types.js'
import { ev, gpvSchedule } from '../helpers.js'

const NOW = new Date('2026-11-05T23:40:00+02:00')
const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)

/** A post already read: its time and the events the model found in it */
const post = (
  publishedAt: string,
  events: PostEvent[],
  { region = 'kharkiv' as RegionId, statedAt = null as string | null } = {},
): Analyzed => ({
  input: siteInput(
    { site: 'example.ua', title: null, text: `${publishedAt} ${events.length}`, publishedAt },
    region,
  ),
  analysis: { events, photosAreSchedules: false, statedAt },
  error: null,
})

/** A ГПВ schedule listing only the queues in `hours` */
const gpv = (
  date: string | null,
  hours: Record<string, string | null>,
  extra: Partial<PostEvent> & { regions?: string[] } = {},
): PostEvent =>
  ev({
    kind: 'gpv',
    action: 'start',
    regions: ['kharkiv'],
    date,
    schedule: gpvSchedule(hours, Object.keys(hours)),
    ...extra,
  })

const cancel = (date: string | null, extra: Partial<PostEvent> = {}): PostEvent =>
  ev({ kind: 'gpv', action: 'cancel', regions: ['kharkiv'], date, ...extra })

const schedule = (region: RegionId, posts: Analyzed[], now: Date, opts = {}) =>
  postsToSchedule(region, postsToDays(posts, region, now, opts), now, opts)

describe('schedule posts', () => {
  it('keeps the newest post per date and ignores posts without schedules and days long gone', () => {
    const s = schedule(
      'kharkiv',
      [
        post('2026-11-05T18:00:00Z', [gpv('2026-11-06', { '1.1': '08:00-10:00' })]),
        post('2026-11-05T20:00:00Z', [gpv('2026-11-06', { '1.1': '09:00-10:00' })]),
        // an explainer
        post('2026-11-05T21:00:00Z', [ev({ kind: 'other', action: null, regions: ['kharkiv'] })]),
        post('2026-10-31T18:00:00Z', [gpv('2026-11-01', { '1.1': '08:00-10:00' })]),
      ],
      NOW,
    )
    expect(s.schedules['1.1']!.map((d) => [d.date, ...hhmm(d)])).toEqual([['2026-11-06', '09:00-10:00']])
    expect(s.updatedAt).toBe('2026-11-05T22:00:00+02:00')
  })

  it('marks a group missing from one day as unknown', () => {
    const s = schedule(
      'kharkiv',
      [
        post('2026-11-04T18:00:00Z', [gpv('2026-11-05', { '1.1': '08:00-10:00', '1.2': '10:00-12:00' })]),
        post('2026-11-05T18:00:00Z', [gpv('2026-11-06', { '1.1': '08:00-10:00' })]),
      ],
      NOW,
    )
    expect(s.schedules['1.2']!.map((d) => d.status)).toEqual(['scheduled', 'unknown'])
  })

  it("lists the region's groups as unknown when no post has a schedule", () => {
    const s = postsToSchedule('kharkiv', new Map(), NOW, { groups: ['1.1', '1.2'] })
    expect(s.groups).toEqual(['1.1', '1.2'])
    expect(s.schedules['1.1']![0]).toMatchObject({ status: 'unknown', intervals: [] })
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
    expect(cancelled).toMatchObject({ groups: {}, cancelled: true })
  })

  it('adds a correction to the groups it names and keeps the rest', () => {
    // "з 6:00 до 8:00 додатково відключаються 1.1"; "до 17:00 продовжується для 1.2" (no start)
    const { groups } = layerPublications([
      { from: 0, groups: { '1.1': [off(10, 14)], '1.2': [off(14, 16)], '2.1': [off(1, 2)] } },
      { from: 0, add: true, groups: { '1.1': [off(6, 8)], '1.2': null } },
    ])
    expect(groups).toEqual({ '1.1': [off(10, 14), off(6, 8)], '1.2': null, '2.1': [off(1, 2)] })
    // nothing to correct on a cancelled day
    expect(
      layerPublications([
        { from: 0, groups: {}, cancelled: true },
        { from: 0, add: true, groups: { '1.1': [off(6, 8)] } },
      ]),
    ).toMatchObject({ groups: {}, cancelled: true })
  })

  it('without a whole day to build on, a correction or a window leaves its groups not known', () => {
    // ЦЕК 4378 alone: "+ 3.1, 3.2" with nothing before it
    const add = layerPublications([{ from: 0, add: true, groups: { '3.1': [off(16, 18)] } }], 'none')
    expect(add).toMatchObject({ groups: { '3.1': null }, based: false })
    // a window "з 16:39 до 22:00" with no day before it: the hours after 22:00 aren't known
    const window = layerPublications([{ from: 999, to: 1320, groups: { '1.1': [off(19, 22)] } }], 'none')
    expect(window).toMatchObject({ groups: { '1.1': null }, based: false })
    // the rest of the day from 17:00: known from then
    const rest = layerPublications([{ from: 1020, groups: { '1.1': [off(18, 20)] } }], 'none')
    expect(rest).toMatchObject({ groups: { '1.1': [off(18, 20)] }, based: false })
    expect(layerPublications([{ from: 0, groups: { '1.1': [] } }]).based).toBe(true)
  })

  it('layers by post time: a post at 17:26 about today replaces only what is ahead', () => {
    const posts = [
      post('2026-11-14T19:42:00+02:00', [
        gpv(
          '2026-11-15',
          { '1.1': '08:00-10:00, 18:00-20:00', '1.2': '09:00-11:00' },
          { regions: ['cherkasy'] },
        ),
      ]),
      post('2026-11-15T17:26:00+02:00', [gpv(null, { '1.1': '18:00-21:00' }, { regions: ['cherkasy'] })]),
    ]
    const now = new Date('2026-11-15T18:00:00+02:00')
    const s = schedule('cherkasy', posts, now, { updates: 'layer' })
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['08:00-10:00', '18:00-21:00'])
    expect(hhmm(s.schedules['1.2']![0]!)).toEqual(['09:00-11:00'])
    expect(s.updatedAt).toBe('2026-11-15T17:26:00+02:00')
    // the default still takes the newest post as the whole day
    const replaced = schedule('cherkasy', posts, now)
    expect(hhmm(replaced.schedules['1.1']![0]!)).toEqual(['18:00-21:00'])
  })

  it('layers from the time the post states ("оновлено з 15:00"), not from its own time', () => {
    const s = schedule(
      'cherkasy',
      [
        post('2026-11-14T19:42:00+02:00', [
          gpv('2026-11-15', { '1.1': '08:00-10:00, 14:00-17:00' }, { regions: ['cherkasy'] }),
        ]),
        // posted at 14:40, effective from 15:00
        post('2026-11-15T14:40:00+02:00', [
          gpv('2026-11-15', { '1.1': '19:00-21:00' }, { regions: ['cherkasy'], at: '15:00' }),
        ]),
      ],
      new Date('2026-11-15T16:00:00+02:00'),
      { updates: 'layer' },
    )
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['08:00-10:00', '14:00-15:00', '19:00-21:00'])
  })

  it('takes a post made the day before as the whole day, layered or not', () => {
    const s = schedule(
      'cherkasy',
      [
        post('2026-11-16T23:45:00+02:00', [
          gpv('2026-11-17', { '1.1': '08:00-10:00, 18:00-20:00' }, { regions: ['cherkasy'] }),
        ]),
        // tomorrow's schedule, posted at 22:05 today: not an update of today
        post('2026-11-17T22:05:00+02:00', [
          gpv('2026-11-18', { '1.1': '00:00-04:00, 12:00-16:00' }, { regions: ['cherkasy'] }),
        ]),
      ],
      new Date('2026-11-17T22:10:00+02:00'),
      { updates: 'layer' },
    )
    expect(s.schedules['1.1']!.map((d) => [d.date, ...hhmm(d)])).toEqual([
      ['2026-11-17', '08:00-10:00', '18:00-20:00'],
      ['2026-11-18', '00:00-04:00', '12:00-16:00'],
    ])
  })

  it('an update that names some groups only leaves the rest of the others not known, unless only groups with outages are listed', () => {
    const posts = (region: RegionId) => [
      post(
        '2026-11-16T23:45:00+02:00',
        [
          gpv(
            '2026-11-17',
            { '1.1': '08:00-10:00, 18:00-20:00', '2.1': '07:00-09:00, 19:00-21:00', '3.1': '03:00-05:00' },
            { regions: [region] },
          ),
        ],
        { region },
      ),
      post(
        '2026-11-17T15:00:00+02:00',
        [gpv('2026-11-17', { '1.1': '16:00-20:00' }, { regions: [region] })],
        {
          region,
        },
      ),
    ]
    const now = new Date('2026-11-17T15:30:00+02:00')
    // the operator lists all its groups in every post: this one is about 1.1 alone
    const all = schedule('cherkasy', posts('cherkasy'), now, { updates: 'layer' })
    expect(hhmm(all.schedules['1.1']![0]!)).toEqual(['08:00-10:00', '16:00-20:00'])
    expect(all.schedules['2.1']![0]).toEqual({ date: '2026-11-17', status: 'unknown', intervals: [] })
    // nothing of 3.1 was left for after 15:00: its day stands
    expect(hhmm(all.schedules['3.1']![0]!)).toEqual(['03:00-05:00'])
    // the operator lists only the groups that have outages: 2.1 has none any more
    const some = schedule('khmelnytskyi', posts('khmelnytskyi'), now, { updates: 'layer', omitted: 'none' })
    expect(hhmm(some.schedules['2.1']![0]!)).toEqual(['07:00-09:00'])
    expect(some.schedules['2.1']![0]!.status).toBe('scheduled')
  })

  it('applies a gpv change as an addition to the groups it names', () => {
    const s = schedule(
      'kharkiv',
      [
        post('2026-11-15T20:00:00+02:00', [
          gpv('2026-11-16', { '1.1': '10:00-14:00', '1.2': '14:00-16:00' }),
        ]),
        post('2026-11-16T05:30:00+02:00', [
          ev({
            kind: 'gpv',
            action: 'change',
            regions: ['kharkiv'],
            schedule: [{ queue: '1.1', intervals: [{ from: '06:00', to: '08:00', kind: 'off' }] }],
          }),
        ]),
      ],
      new Date('2026-11-16T06:00:00+02:00'),
    )
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['06:00-08:00', '10:00-14:00'])
    expect(hhmm(s.schedules['1.2']![0]!)).toEqual(['14:00-16:00'])
  })
})

describe('which day a post is about, and which events count', () => {
  const days = (posts: Analyzed[], now = new Date('2026-11-16T12:30:00+02:00'), opts = {}) =>
    postsToDays(posts, 'kharkiv', now, opts)

  it("dates an event without a date by the post's own Kyiv day", () => {
    // 22:30Z on the 16th is 00:30 on the 17th in Kyiv
    expect([...days([post('2026-11-16T22:30:00Z', [gpv(null, { '1.1': '01:00-03:00' })])]).keys()]).toEqual([
      '2026-11-17',
    ])
  })

  it('splits a post about two days', () => {
    const d = days([
      post('2026-11-15T20:00:00+02:00', [
        gpv('2026-11-16', { '1.1': '08:00-10:00', '1.2': '09:00-11:00' }),
        gpv('2026-11-17', { '1.1': '18:00-20:00' }),
      ]),
    ])
    expect([...d.keys()]).toEqual(['2026-11-16', '2026-11-17'])
    expect(d.get('2026-11-16')!.groups['1.1']).toEqual([{ start: 480, end: 600, kind: 'off' }])
    expect(d.get('2026-11-17')!.groups['1.1']).toEqual([{ start: 1080, end: 1200, kind: 'off' }])
  })

  it("ignores emergency events, other regions, a town's own schedule and a start without hours", () => {
    const d = days([
      post('2026-11-16T12:11:00+02:00', [
        ev({ kind: 'gav', action: 'start', regions: ['kharkiv'], queues: ['1', '2'] }),
        gpv('2026-11-16', { '1.1': '12:00-16:00' }, { regions: ['poltava'] }),
        gpv('2026-11-16', { '1': '12:00-16:00' }, { area: 'м. Павлоград' }),
        // the hours are in the post's picture
        ev({ kind: 'gpv', action: 'start', regions: ['kharkiv'], date: '2026-11-16' }),
      ]),
    ])
    expect(d.size).toBe(0)
  })

  it('turns a cancelled day into unknown: neither the old hours nor "no outages"', () => {
    const posts = [
      post('2026-11-15T20:00:00+02:00', [gpv('2026-11-16', { '1.1': '08:00-10:00', '1.2': '09:00-11:00' })]),
      post('2026-11-16T07:00:00+02:00', [cancel('2026-11-16')]),
    ]
    const now = new Date('2026-11-16T08:00:00+02:00')
    const s = schedule('kharkiv', posts, now, { omitted: 'none' })
    expect(s.schedules['1.1']).toEqual([{ date: '2026-11-16', status: 'unknown', intervals: [] }])
    expect(s.schedules['1.2']).toEqual([{ date: '2026-11-16', status: 'unknown', intervals: [] }])
    // a newer schedule for the day stands again
    const again = schedule(
      'kharkiv',
      [...posts, post('2026-11-16T09:00:00+02:00', [gpv('2026-11-16', { '1.1': '18:00-20:00' })])],
      now,
      { omitted: 'none' },
    )
    expect(hhmm(again.schedules['1.1']![0]!)).toEqual(['18:00-20:00'])
  })

  it('leaves a group named without hours ("графік уточнюється") unknown', () => {
    const s = schedule(
      'kharkiv',
      [post('2026-11-15T20:00:00+02:00', [gpv('2026-11-16', { '1.1': '08:00-10:00', '1.2': null })])],
      new Date('2026-11-15T21:00:00+02:00'),
      { omitted: 'none' },
    )
    expect(s.schedules['1.2']).toEqual([{ date: '2026-11-16', status: 'unknown', intervals: [] }])
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['08:00-10:00'])
  })

  it('skips a post that could not be read', () => {
    const bad: Analyzed = { ...post('2026-11-16T09:00:00+02:00', []), analysis: null }
    const d = days([bad, post('2026-11-15T20:00:00+02:00', [gpv('2026-11-16', { '1.1': '08:00-10:00' })])])
    expect(d.get('2026-11-16')!.groups['1.1']).toEqual([{ start: 480, end: 600, kind: 'off' }])
  })

  it('ranks timeless posts (a site page) by their order, newest first', () => {
    // a site page shows dates only: every post reads as midnight
    const d = days(
      [
        post('2026-11-16T00:00:00+02:00', [gpv('2026-11-16', { '1.1': '18:00-20:00' })]),
        post('2026-11-16T00:00:00+02:00', [gpv('2026-11-16', { '1.1': '08:00-10:00' })]),
      ],
      new Date('2026-11-16T12:00:00+02:00'),
      { timeless: true, updates: 'layer' },
    )
    // the first is the newest and, without a time of its own, the whole day
    expect(d.get('2026-11-16')).toMatchObject({
      post: 0,
      groups: { '1.1': [{ start: 1080, end: 1200, kind: 'off' }] },
    })
    expect(d.get('2026-11-16')!.at).toBeNaN()
  })

  it('hands a cancelled day to mergeSources as a publication of its own', () => {
    const d = days(
      [
        post('2026-11-15T20:00:00+02:00', [gpv('2026-11-16', { '1.1': '08:00-10:00' })]),
        post('2026-11-16T07:00:00+02:00', [cancel('2026-11-16')]),
      ],
      new Date('2026-11-16T08:00:00+02:00'),
    )
    expect(daysToSource(d).days['2026-11-16']).toEqual({
      schedules: { '1.1': { date: '2026-11-16', status: 'unknown', intervals: [] } },
      cancelled: true,
      publishedAt: '2026-11-16T07:00:00+02:00',
    })
  })
})

describe('statedTime', () => {
  const analysis = (events: PostEvent[], statedAt: string | null = null) => ({
    events,
    photosAreSchedules: false,
    statedAt,
  })
  const now = new Date('2026-11-05T23:40:00+02:00')

  it('takes "(оновлено 21:25)" on the day the post is about', () => {
    expect(
      statedTime(
        analysis([gpv('2026-11-05', { '1.1': '08:00-10:00' })], '21:25'),
        'kharkiv',
        '2026-11-05',
        now,
      ),
    ).toBe('2026-11-05T21:25:00+02:00')
  })

  it("takes the evening before for tomorrow's schedule stated tonight", () => {
    expect(
      statedTime(
        analysis([gpv('2026-11-06', { '1.1': '08:00-10:00' })], '21:25'),
        'kharkiv',
        '2026-11-06',
        now,
      ),
    ).toBe('2026-11-05T21:25:00+02:00')
  })

  it('takes an update\'s "з 15:00" once it has come, and nothing ahead of now', () => {
    const a = analysis([gpv('2026-11-05', { '1.1': '18:00-20:00' }, { at: '15:00' })], '14:40')
    expect(statedTime(a, 'kharkiv', '2026-11-05', now)).toBe('2026-11-05T15:00:00+02:00')
    expect(statedTime(a, 'kharkiv', '2026-11-05', new Date('2026-11-05T14:45:00+02:00'))).toBeNull()
  })

  it('says nothing when the post states no time', () => {
    expect(
      statedTime(analysis([gpv('2026-11-05', { '1.1': '08:00-10:00' })]), 'kharkiv', '2026-11-05', now),
    ).toBeNull()
  })
})

describe('review fixes: cancellations until further notice, ties', () => {
  it('"ГПВ скасовано до окремого розпорядження" also withdraws a list already out for tomorrow', () => {
    const now = new Date('2026-11-18T15:00:00+02:00')
    const s = schedule(
      'kharkiv',
      [
        post('2026-11-18T08:00:00+02:00', [gpv('2026-11-19', { '1.1': '08:00-12:00' })]),
        post('2026-11-18T14:00:00+02:00', [
          ev({ kind: 'gpv', action: 'cancel', regions: ['kharkiv'], untilFurtherNotice: true }),
        ]),
      ],
      now,
    )
    const tomorrow = s.schedules['1.1']!.find((d) => d.date === '2026-11-19')
    expect(tomorrow?.status).toBe('unknown')
  })

  it('two Telegram posts in the same second: the later message wins', () => {
    const tg = (id: number, events: PostEvent[]): Analyzed => ({
      input: {
        url: `https://t.me/kharkivenergy/${id}`,
        source: { kind: 'telegram', channel: 'kharkivenergy' },
        publishedAt: '2026-11-18T10:00:00+02:00',
        edited: false,
        title: null,
        text: String(id),
        replyTo: null,
        photoCount: 0,
        regions: [],
      },
      analysis: { events, photosAreSchedules: false, statedAt: null },
      error: null,
    })
    const now = new Date('2026-11-18T11:00:00+02:00')
    // oldest first, as a channel is read: the list, then its cancellation
    const s = schedule(
      'kharkiv',
      [
        tg(100, [gpv('2026-11-19', { '1.1': '08:00-12:00' })]),
        tg(101, [ev({ kind: 'gpv', action: 'cancel', regions: ['kharkiv'], date: '2026-11-19' })]),
      ],
      now,
    )
    expect(s.schedules['1.1']!.find((d) => d.date === '2026-11-19')?.status).toBe('unknown')
  })
})
