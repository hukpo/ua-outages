import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { OutageError } from '../../src/errors.js'
import {
  cherkasyProvider,
  flattenPostHtml,
  parseCherkasyPosts,
  pickSchedulePosts,
} from '../../src/providers/cherkasy.js'
import type { DaySchedule } from '../../src/types.js'
import { expectUnpublished, fixture, mockFetch, type Route } from '../helpers.js'

const NOW = new Date('2026-11-05T23:40:00+02:00')
const API = 'https://www.cherkasyoblenergo.com/api/v1/posts'
const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)
const post = (name: string) => JSON.parse(fixture(`cherkasy/${name}.json`)).data

const TG = 'https://t.me/s/pat_cherkasyoblenergo'
/** A channel page without schedule posts */
const QUIET: Route = { match: TG, body: fixture('telegram/cek_info-4315-4316.trimmed.html') }

const POSTS: Route[] = [
  QUIET,
  { match: `${API}/search?`, body: fixture('cherkasy/posts-search-gpv-2026-11-05.json') },
  ...[4, 5, 6].map((d) => ({
    match: `${API}/hrafik-pohodynnykh-vidklyuchen-hpv-na-${d}-lystopada?`,
    body: fixture(`cherkasy/post-hpv-na-${d}-lystopada.json`),
  })),
  {
    match: `${API}/onovleno-hrafik-pohodynnykh-vidklyuchen-hpv-na-1-lystopada?`,
    body: fixture('cherkasy/post-onovleno-hpv-na-1-lystopada.json'),
  },
]

function client(routes: Route[] = POSTS, now = NOW) {
  const { fetch, calls } = mockFetch(routes)
  return {
    client: new OutageClient({ fetch, now: () => now, cacheTtlMs: 0, providers: [cherkasyProvider()] }),
    calls,
  }
}

describe('Cherkasyoblenergo', () => {
  it('reads today and tomorrow, fetching only those posts', async () => {
    const { client: c, calls } = client()
    const s = await c.getSchedules('cherkasy')
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
    // the search list plus one post per day (each published the evening before: the whole
    // day); emergency (ГАВ) notices are never fetched
    const site = calls.filter((c) => c.url.startsWith(API))
    expect(site).toHaveLength(3)
    expect(site.some((c) => c.url.includes('hav'))).toBe(false)
  })

  it('parses group lines split across inline tags', async () => {
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
    // a stray "0" after "21:00" in the source doesn't break the line
    expect(hhmm(nov6('6.2'))).toEqual([
      '00:00-02:00',
      '06:00-09:00',
      '11:00-15:00',
      '17:00-21:00',
      '23:00-00:00',
    ])
  })

  it('reports the newest publish time in Kyiv time', async () => {
    const s = await client().client.getSchedules('cherkasy')
    // "publishedAt": "2026-11-05T20:25:00" is Kyiv wall-clock time
    expect(s.updatedAt).toBe('2026-11-05T20:25:00+02:00')
  })

  it("fetches a day's update and the post it updates, dated by title rather than slug", () => {
    const search = JSON.parse(fixture('cherkasy/posts-search-gpv-2026-11-05.json'))
    // "onovleno-…-na-1-lystopada" is "Оновлено графік … на 3 листопада", published 03.11 02:50:
    // it lists the hours from then on, so the first post for 3.11 is needed too
    expect(pickSchedulePosts(search, new Date('2026-11-03T12:00:00+02:00'))).toEqual([
      'hrafik-pohodynnykh-vidklyuchen-hpv-na-5-lystopada',
      'hrafik-pohodynnykh-vidklyuchen-hpv-na-4-lystopada',
      'onovleno-hrafik-pohodynnykh-vidklyuchen-hpv-na-1-lystopada',
      'hrafik-pohodynnykh-vidklyuchen-hpv-na-3-lystopada',
    ])
  })

  it('ignores posts without group windows', () => {
    const s = parseCherkasyPosts([post('post-hav-3'), post('post-hpv-na-6-lystopada')], NOW)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-06'])
  })

  it('returns an empty schedule when no schedule posts are recent', async () => {
    const search = JSON.parse(fixture('cherkasy/posts-search-gpv-2026-11-05.json'))
    search.data.content = search.data.content.filter((p: { title: string }) => !/ГПВ/.test(p.title))
    const s = await client([
      QUIET,
      { match: `${API}/search?`, body: JSON.stringify(search) },
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

  it('rejects schedule posts it cannot read', () => {
    const p = { ...post('post-hpv-na-6-lystopada'), content: '<p><img src="/uploads/hpv.png"></p>' }
    expect(() => parseCherkasyPosts([p], NOW)).toThrow(OutageError)
    expect(() => parseCherkasyPosts([p], NOW)).toThrow(/no group lines/)
  })

  it('flattens the hand-edited HTML', () => {
    expect(
      flattenPostHtml('<p>1.1&nbsp;<span>00</span><span> :00 - 02:00,&nbsp;</span></p><p>1.2 x</p>'),
    ).toBe('1.1 00:00 - 02:00, \n1.2 x\n')
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
    match: `${API}/${slug.includes('onovleno') ? '' : 'hrafik-pohodynnykh-vidklyuchen-'}${slug}?`,
    body: fixture(`cherkasy/post-${slug}.json`),
  })

  it('layers an update onto the day instead of replacing it', () => {
    // 15.11: the first post (14.11 19:42) and "Оновлено …" (15.11 17:19), which lists only
    // the hours from 17:00 on
    const first = post('post-hpv-na-15-lystopada')
    const update = post('post-onovleno-hpv-na-15-lystopada')
    const now = new Date('2026-11-15T18:00:00+02:00')
    const before = parseCherkasyPosts([first], now)
    const s = parseCherkasyPosts([update, first], now)
    expect(hhmm(before.schedules['1.1']![0]!)).toEqual(['08:00-10:00', '18:00-20:00'])
    // the morning stays, the evening is the update's "1.1 18:00 - 21:00"
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['08:00-10:00', '18:00-21:00'])
    expect(s.updatedAt).toBe('2026-11-15T17:19:00+02:00')
    // the update alone would lose the morning
    expect(hhmm(parseCherkasyPosts([update], now).schedules['1.1']![0]!)).toEqual(['18:00-21:00'])
  })

  it('takes tomorrow from Telegram while the site has no post for it', async () => {
    // 17.11 00:56: the search has nothing for 17.11; post 2027 (16.11 23:45) has it
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
      [SEARCH, NEW, site('hpv-na-16-lystopada')],
      new Date('2026-11-16T23:50:00+02:00'),
    )
    const s = await c.getSchedules('cherkasy')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17'])
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual([
      '00:00-02:00',
      '08:00-10:00',
      '14:00-16:00',
      '18:00-20:00',
    ])
    // site 15.11 20:58, Telegram 21:06; the ГОП notice (2026) and the district notice (2025)
    // in the channel are not schedules
    expect(s.sources).toMatchObject([
      { id: 'site', ok: true, dates: [], updatedAt: '2026-11-15T20:58:00+02:00' },
      { id: 'telegram:@pat_cherkasyoblenergo', ok: true, dates: ['2026-11-16', '2026-11-17'] },
    ])
    expect(s.sources!.some((x) => x.disagrees)).toBe(false)
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

  it('fetches a cancellation whose title names no day, and not the emergency one or an old one', () => {
    expect(pickSchedulePosts(search, now)).toEqual(['skasovano-hpv', 'hpv-17'])
  })

  it('leaves the day not known once the schedule is called off, on the site and merged with Telegram', async () => {
    const posts = [
      {
        title: 'Скасовано застосування графіків погодинних відключень (ГПВ)',
        content:
          '<p>За розпорядженням НЕК «Укренерго» графіки погодинних відключень на 17 листопада скасовано.</p>',
        publishedAt: '2026-11-17T10:00:00',
      },
      {
        title: 'Графік погодинних відключень (ГПВ) на 17 листопада',
        content: '<p>1.1 08:00 - 12:00, 18:00 - 22:00</p>',
        publishedAt: '2026-11-16T20:00:00',
      },
    ]
    expect(parseCherkasyPosts(posts, now).schedules['1.1']).toEqual([
      { date: '2026-11-17', status: 'unknown', intervals: [] },
    ])
    const { fetch } = mockFetch([
      { match: `${API}/search`, body: JSON.stringify(search) },
      { match: `${API}/skasovano-hpv?`, body: JSON.stringify({ data: posts[0] }) },
      { match: `${API}/hpv-17?`, body: JSON.stringify({ data: posts[1] }) },
      QUIET,
    ])
    const s = await new OutageClient({
      fetch,
      now: () => now,
      cacheTtlMs: 0,
      providers: [cherkasyProvider()],
    }).getSchedules('cherkasy')
    expect(s.schedules['1.1']).toEqual([{ date: '2026-11-17', status: 'unknown', intervals: [] }])
    expect(s.updatedAt).toBe('2026-11-17T10:00:00+02:00')
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: true, dates: ['2026-11-17'] })
  })
})
