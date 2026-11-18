import { createHash } from 'node:crypto'
import { DEFAULT_MAX_LONG_EDGE } from '../../src/ai/runtime.js'
import { describe, expect, it } from 'vitest'
import { AiRuntime } from '../../src/ai/runtime.js'
import type {
  ImageInput,
  ImageProcessor,
  PostAnalysis,
  PostInput,
  TextProcessor,
} from '../../src/ai/types.js'
import { OutageClient } from '../../src/client.js'
import { parseTelegramPreview, type TelegramPost } from '../../src/emergency/telegram.js'
import { assessFreshness } from '../../src/freshness.js'
import { Http } from '../../src/http.js'
import { compactImage } from '../../src/image/compact.js'
import { readPicturePosts } from '../../src/providers/picture-posts.js'
import { STANDARD_GROUPS } from '../../src/schedule.js'
import type { DaySchedule, RegionSchedule } from '../../src/types.js'
import {
  ev,
  fakeImage,
  fakeText,
  fixture,
  fixtureBytes,
  gpvSchedule,
  intervalsOf,
  mockFetch,
  type Route,
} from '../helpers.js'

// posters with the times read off them by hand: the 1200 px site originals, and the 471 px
// Telegram copies of the posters of 26.10–16.11 (tg-<post>)
const labels = JSON.parse(fixture('chernihiv/posters/labels.json')) as Record<
  string,
  { date: string; cards: string[]; unreadable?: string }
>

const hhmm = (d: DaySchedule) =>
  d.intervals
    .map(
      (i) =>
        // "~": a `maybe` interval
        `${i.kind === 'maybe' ? '~' : ''}${i.from.slice(11, 16)}-${i.to.slice(0, 10) > d.date ? '00:00' : i.to.slice(11, 16)}`,
    )
    .join(' ')

// --- what a model reads ---

const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
let byDigest: Map<string, string> | null = null
/** The labelled poster a picture is, by its compacted bytes (what the image processor gets) */
function posterOf(input: ImageInput): string | undefined {
  byDigest ??= new Map(
    Object.keys(labels)
      .filter((n) => !labels[n]!.unreadable)
      .map((n) => [
        digest(
          compactImage(fixtureBytes(`chernihiv/posters/${n}`), { maxLongEdge: DEFAULT_MAX_LONG_EDGE }).bytes,
        ),
        n,
      ]),
  )
  return byDigest.get(digest(input.bytes))
}

/** The twelve cards of each labelled poster; any other picture (banners, photos) isn't a schedule */
const posters = (opts: { check?: (input: ImageInput) => boolean } = {}) =>
  fakeImage((input) => {
    const name = posterOf(input)
    if (!name) return undefined
    const { date, cards } = labels[name]!
    return {
      date,
      schedule: STANDARD_GROUPS.map((queue, i) => ({
        queue,
        intervals: intervalsOf(
          cards[i]!.split(' ')
            .map((c) => c.replace(/-00:00$/, '-24:00'))
            .join(', '),
        ),
      })),
    }
  }, opts)

const gpv = (e: Partial<Parameters<typeof ev>[0]>) =>
  ev({ kind: 'gpv', action: 'start', regions: ['chernihiv'], ...e })
/** "N листопада в області діятиме Графік погодинних відключень (ГПВ)", the poster attached */
const poster = (date: string | null): Partial<PostAnalysis> => ({
  photosAreSchedules: true,
  events: [gpv({ date })],
})
/** A correction to some queues: hours when both ends are given, otherwise not known */
const change = (date: string, hours: Record<string, string | null>, at: string | null = null) => [
  gpv({ action: 'change', date, at, schedule: gpvSchedule(hours, Object.keys(hours)) }),
]
const unknown = (...queues: string[]) => Object.fromEntries(queues.map((q) => [q, null]))

/** The channel's posts, by id */
const POSTS: Record<number, Partial<PostAnalysis> | ReturnType<typeof change>> = {
  5631: poster('2026-11-02'),
  // "у Ніжинському і Прилуцькому районах застосовано 10 черг … ГАВ"
  5633: [
    ev({
      kind: 'gav',
      action: 'start',
      regions: ['chernihiv'],
      area: 'Ніжинський і Прилуцький райони',
      queueCount: 10,
    }),
  ],
  // "З 11:00 починається відключення для черги 6/2"
  5635: change('2026-11-02', unknown('6.2'), '11:00'),
  // "До 14:00 продовжується … 4/1", "З 14:00 починається … 5/1", "До 17:00 продовжується … 6/1",
  // "З 17:00 починається … 4/2": no line gives both ends
  5636: change('2026-11-02', unknown('4.1', '5.1', '6.1', '4.2')),
  // "З 13:30 починається відключення для черг 5/1 та 5/2"
  5637: change('2026-11-02', unknown('5.1', '5.2'), '13:30'),
  // "сьогодні маємо значні зміни у Графіку погодинних відключень (ГПВ)☝️, перевірте свій!"
  5638: poster(null),
  5709: poster('2026-11-14'),
  // "З 12:00 починається відключення для черг 1/1 та 1/2"
  5710: change('2026-11-14', unknown('1.1', '1.2'), '12:00'),
  // "До 17:00 продовжується … 4/1 та 4/2", "З 17:00 починається … 3/1 та 3/2", "До 20:00 … 6/1 та 6/2"
  5711: change('2026-11-14', unknown('4.1', '4.2', '3.1', '3.2', '6.1', '6.2')),
  // "До 22:00 продовжується … 3/2", "З 20:00 починається … 5/2", "З 22:00 відключаються черги 4/1 та 4/2"
  5712: change('2026-11-14', unknown('3.2', '5.2', '4.1', '4.2')),
  5714: poster('2026-11-15'),
  // "До 01:00 продовжується відключення для черг 5/1 та 5/2"
  5716: change('2026-11-15', unknown('5.1', '5.2')),
  // "З 6:00 до 8:00 додатково відключаються черги 1/1 та 1/2"
  5717: [
    gpv({
      action: 'change',
      date: '2026-11-15',
      at: '06:00',
      additive: true,
      schedule: gpvSchedule({ '1.1': '06:00-08:00', '1.2': '06:00-08:00' }, ['1.1', '1.2']),
    }),
  ],
  5718: poster('2026-11-16'),
  // "З 07:15 починається відключення для черг 5/1 та 5/2"
  5720: change('2026-11-16', unknown('5.1', '5.2'), '07:15'),
  // "З 10:10 починається відключення для черг 2/1 та 2/2"
  5721: change('2026-11-16', unknown('2.1', '2.2'), '10:10'),
  // "До 15:00 продовжується відключення для черг 6/1 та 6/2"
  5722: change('2026-11-16', unknown('6.1', '6.2')),
  5723: poster('2026-11-17'),
}
const postId = (input: PostInput) => Number(input.url.split('/').at(-1))
const posts = (
  extra: (input: PostInput) => Partial<PostAnalysis> | ReturnType<typeof change> | undefined = () =>
    undefined,
) => fakeText((input) => extra(input) ?? POSTS[postId(input)])

// --- fetches ---

const SITE_16 = {
  match: 'schedule_groups.jpg',
  body: fixtureBytes('chernihiv/posters/site-2026-11-16.jpg'),
  headers: { 'Last-Modified': 'Mon, 16 Nov 2026 06:05:33 GMT' },
}
const BANNER = fixtureBytes('chernihiv/not-schedules/tg-5720.jpg')

/**
 * The channel as saved (posts `range`), the pictures of the posts in `pictures` (a poster file,
 * or a status when the CDN link is dead), a stock banner for every other one.
 */
function channel(range: string, pictures: Record<number, string | number>, last = Infinity): Route[] {
  const saved = fixture(`chernihiv/telegram-chernigivoblenergo-${range}.trimmed.html`)
  // the page as it was when `last` was the newest post
  const later = [
    ...saved.matchAll(/<div class="tgme_widget_message_wrap\b[^>]*>\s*<div[^>]*data-post="[^"/]+\/(\d+)"/g),
  ].find((m) => Number(m[1]) > last)
  const html = later ? `${saved.slice(0, later.index)}</section>` : saved
  const list = parseTelegramPreview(html, { withPhotoOnly: true })
  return [
    ...Object.entries(pictures).flatMap(([id, picture]): Route[] => {
      const match = list.find((p) => p.id === Number(id))?.photos[0]
      if (!match) return []
      return typeof picture === 'number'
        ? [{ match, body: 'Not Found', status: picture }]
        : [{ match, body: fixtureBytes(`chernihiv/posters/${picture}`) }]
    }),
    { match: 'telesco.pe/file/', body: BANNER },
    // nothing older than the saved posts
    { match: '?before=', body: '<section class="tgme_channel_history js-message_history"></section>' },
    { match: 't.me/s/chernigivoblenergo', body: html },
  ]
}

function reader(
  at: string,
  routes: Route[],
  p: { text?: TextProcessor | null; image?: ImageProcessor | null } = {},
) {
  const { fetch, calls } = mockFetch(routes)
  const text = p.text === null ? undefined : (p.text ?? posts())
  const image = p.image === null ? undefined : (p.image ?? posters())
  const client = new OutageClient({
    fetch,
    now: () => new Date(at),
    cacheTtlMs: 0,
    textProcessor: text,
    imageProcessor: image,
  })
  return { client, calls, text, image }
}
const read = (at: string, routes: Route[], p?: Parameters<typeof reader>[2]) =>
  reader(at, routes, p).client.getSchedules('chernihiv')
const day = (s: RegionSchedule, group: string, date: string) => {
  const d = s.schedules[group]!.find((d) => d.date === date)
  return d ? (d.status === 'unknown' ? 'unknown' : hhmm(d)) : undefined
}
const dates = (s: RegionSchedule) => s.schedules['1.1']!.map((d) => d.date)
const source = (s: RegionSchedule, id: string) => s.sources!.find((x) => x.id === id)!
const TG = 'telegram:@chernigivoblenergo'
const EVENING = channel('5717-5723', { 5718: 'tg-5718.jpg', 5723: 'tg-5723.jpg' })
const SITE_DOWN = { match: 'schedule_groups.jpg', body: 'Bad gateway', status: 502 }

describe('Chernihivoblenergo: site and Telegram together', () => {
  it('evening: the site has today, Telegram has today and tomorrow', async () => {
    const s = await read('2026-11-16T23:30:00+02:00', [SITE_16, ...EVENING])
    expect(dates(s)).toEqual(['2026-11-16', '2026-11-17'])
    expect(s.groups).toEqual(STANDARD_GROUPS)
    // tomorrow: the poster of 23:18, which the site won't have until the morning
    expect(day(s, '1.1', '2026-11-17')).toBe('03:00-06:00 13:00-17:00')
    expect(day(s, '4.2', '2026-11-17')).toBe('00:00-03:00 09:30-13:00 20:30-22:00')
    // today: the channel changed it at 12:15 ("До 15:00 продовжується … 6/1 та 6/2"), so its
    // version counts, and an end without a start isn't known
    expect(day(s, '6.1', '2026-11-16')).toBe('unknown')
    expect(day(s, '1.1', '2026-11-16')).toBe('13:00-16:30 20:00-23:30')
    expect(s.updatedAt).toBe('2026-11-16T23:18:48+02:00')
    expect(source(s, 'site')).toMatchObject({
      ok: true,
      dates: [],
      // the file uploaded at 08:05 is the poster of post 5718: published when that was
      updatedAt: '2026-11-15T20:32:02+02:00',
    })
    // the queues the channel no longer knows aren't a disagreement: it publishes no hours for them
    expect(source(s, 'site').disagrees).toBeUndefined()
    expect(source(s, TG)).toMatchObject({
      ok: true,
      dates: ['2026-11-16', '2026-11-17'],
      url: 'https://t.me/chernigivoblenergo/5723',
    })
  })

  it('reads only the pictures of posts that announce a poster, with their captions', async () => {
    const { client, calls, text, image } = reader('2026-11-16T23:30:00+02:00', [SITE_16, ...EVENING])
    await client.getSchedules('chernihiv')
    // every post of the window through the text processor, once
    expect((text as ReturnType<typeof posts>).calls.map(postId)).toEqual([5718, 5720, 5721, 5722, 5723])
    // the banners of the change posts aren't fetched
    expect(calls.filter((c) => c.url.includes('telesco.pe'))).toHaveLength(2)
    const reads = (image as ReturnType<typeof posters>).calls
    expect(reads.map((x) => x.url)).toEqual([
      'https://chernihivoblenergo.com.ua/files/other/schedule_groups.jpg',
      'https://t.me/chernigivoblenergo/5718',
      'https://t.me/chernigivoblenergo/5723',
    ])
    expect(reads[2]!.caption).toMatch(/^За вказівкою НЕК "Укренерго", 17 листопада/)
    expect(reads[0]!.caption).toBeNull()
  })

  it('a change in words that gives no end leaves its queues unknown; the others keep the poster', async () => {
    // 16.11 10:30: "З 07:15 починається відключення для черг 5/1 та 5/2", "З 10:10 … 2/1 та 2/2"
    const s = await read('2026-11-16T10:30:00+02:00', [
      SITE_16,
      ...channel('5717-5723', { 5718: 'tg-5718.jpg' }, 5721),
    ])
    expect(dates(s)).toEqual(['2026-11-16'])
    // the power went off at 07:15 and may be back any time: neither the poster's hours (an old
    // schedule under the time of the change) nor an end nobody gave
    for (const g of ['5.1', '5.2', '2.1', '2.2']) expect(day(s, g, '2026-11-16'), g).toBe('unknown')
    expect(day(s, '6.1', '2026-11-16')).toBe('00:00-02:30 09:30-13:00 20:00-22:00')
    expect(s.updatedAt).toBe('2026-11-16T10:06:15+02:00')
    expect(source(s, TG).dates).toEqual(['2026-11-16'])
    // the site still has the poster, which the channel's queues it does know agree with
    expect(source(s, 'site')).toMatchObject({ ok: true, dates: [], updatedAt: '2026-11-15T20:32:02+02:00' })
    expect(source(s, 'site').disagrees).toBeUndefined()
    // the unknown queues show as a partly published day
    expect(
      assessFreshness(s, { now: new Date('2026-11-16T10:30:00+02:00') }).issues.map((i) => [
        i.code,
        i.message,
      ]),
    ).toEqual([['partial', '2026-11-16 is published for 8 of 12 groups']])

    // before the first change post the poster stands for every queue
    const early = await read('2026-11-16T07:00:00+02:00', [
      SITE_16,
      ...channel('5717-5723', { 5718: 'tg-5718.jpg' }, 5719),
    ])
    expect(day(early, '5.1', '2026-11-16')).toBe('09:30-13:00 16:30-20:00')
    expect(day(early, '2.1', '2026-11-16')).toBe('02:30-06:00 13:00-16:30 23:30-00:00')
    expect(source(early, 'site').disagrees).toBeUndefined()
  })

  it('after midnight the site still shows yesterday: today comes from Telegram alone', async () => {
    const s = await read('2026-11-17T07:00:00+02:00', [SITE_16, ...EVENING])
    expect(dates(s)).toEqual(['2026-11-17'])
    expect(day(s, '5.2', '2026-11-17')).toBe('06:00-09:30 14:00-20:30')
    expect(s.updatedAt).toBe('2026-11-16T23:18:48+02:00')
    expect(source(s, 'site')).toMatchObject({ ok: true, dates: [], updatedAt: null })
    expect(source(s, TG).dates).toEqual(['2026-11-17'])
  })

  it('morning: the upload of the evening poster is that poster, not a newer publication', async () => {
    const site = {
      match: 'schedule_groups.jpg',
      body: fixtureBytes('chernihiv/posters/tg-5723.jpg'),
      headers: { 'Last-Modified': 'Tue, 17 Nov 2026 06:10:00 GMT' },
    }
    const s = await read('2026-11-17T09:00:00+02:00', [site, ...EVENING])
    expect(dates(s)).toEqual(['2026-11-17'])
    // the time of post 5723, not of the upload at 08:10; a tie goes to the site
    expect(s.updatedAt).toBe('2026-11-16T23:18:48+02:00')
    expect(source(s, 'site')).toMatchObject({ ok: true, dates: ['2026-11-17'] })
    expect(source(s, TG)).toMatchObject({ ok: true, dates: [], updatedAt: '2026-11-16T23:18:48+02:00' })
    expect(source(s, TG).disagrees).toBeUndefined()
  })

  it("the morning upload doesn't undo a change the channel made overnight", async () => {
    // 15.11 00:31: "З 6:00 до 8:00 додатково відключаються черги 1/1 та 1/2"; at 07:30 the site
    // gets the evening poster (post 5714) as it was, without that outage
    const routes = channel('5705-5717', { 5709: 'tg-5709.jpg', 5714: 'tg-5714.jpg' })
    const uploaded = {
      match: 'schedule_groups.jpg',
      body: fixtureBytes('chernihiv/posters/tg-5714.jpg'),
      headers: { 'Last-Modified': 'Sun, 15 Nov 2026 05:30:00 GMT' },
    }
    const s = await read('2026-11-15T07:35:00+02:00', [uploaded, ...routes])
    expect(day(s, '1.1', '2026-11-15')).toBe('06:00-08:00 16:00-19:30')
    expect(s.updatedAt).toBe('2026-11-15T00:31:39+02:00')
    expect(source(s, TG)).toMatchObject({ ok: true, dates: ['2026-11-15'] })
    expect(source(s, 'site')).toMatchObject({
      ok: true,
      dates: [],
      updatedAt: '2026-11-14T20:49:41+02:00',
      disagrees: true,
    })

    // the channel can't be read: the file has only its upload time, and is all there is
    const alone = await read('2026-11-15T07:35:00+02:00', [
      uploaded,
      { match: 't.me/s/chernigivoblenergo', body: 'Bad gateway', status: 502 },
    ])
    expect(day(alone, '1.1', '2026-11-15')).toBe('16:00-19:30')
    expect(alone.updatedAt).toBe('2026-11-15T07:30:00+02:00')
  })

  it('site down: Telegram alone gives both days', async () => {
    const s = await read('2026-11-16T23:30:00+02:00', [SITE_DOWN, ...EVENING])
    expect(dates(s)).toEqual(['2026-11-16', '2026-11-17'])
    expect(day(s, '6.2', '2026-11-17')).toBe('06:00-09:30 17:00-20:30')
    expect(source(s, 'site')).toMatchObject({ ok: false, error: { code: 'http' } })
    expect(source(s, TG).ok).toBe(true)
  })

  it('Telegram down: the site alone gives its day', async () => {
    const s = await read('2026-11-16T23:30:00+02:00', [
      SITE_16,
      { match: 't.me/s/', body: 'Bad gateway', status: 502 },
    ])
    expect(dates(s)).toEqual(['2026-11-16'])
    expect(day(s, '6.1', '2026-11-16')).toBe('00:00-02:30 09:30-13:00 20:00-22:00')
    expect(s.updatedAt).toBe('2026-11-16T08:05:33+02:00')
    expect(source(s, TG)).toMatchObject({ ok: false, error: { code: 'http' } })
  })

  it('both down: an error', async () => {
    await expect(
      read('2026-11-16T23:30:00+02:00', [{ match: /./, body: 'Bad gateway', status: 502 }]),
    ).rejects.toMatchObject({ code: 'http' })
  })

  it("a dead link to the newest poster doesn't make the older one look current", async () => {
    const s = await read('2026-11-16T23:30:00+02:00', [
      SITE_16,
      ...channel('5717-5723', { 5718: 'tg-5718.jpg', 5723: 404 }),
    ])
    // which day the lost poster is for can't be known: the channel gives nothing at all
    expect(source(s, TG)).toMatchObject({ ok: false, dates: [] })
    expect(dates(s)).toEqual(['2026-11-16'])
    expect(source(s, 'site').dates).toEqual(['2026-11-16'])
  })

  it('a schedule post whose picture is something else is an error too', async () => {
    const s = await read('2026-11-16T23:30:00+02:00', [
      SITE_16,
      ...channel('5717-5723', { 5718: 'tg-5718.jpg' }),
    ])
    // the day it is about is not known, and the channel says why
    expect(source(s, TG).unread).toEqual([
      { date: '2026-11-17', message: expect.stringMatching(/announces a schedule picture/) },
    ])
    expect(s.schedules['1.1']!.find((d) => d.date === '2026-11-17')!.status).toBe('unknown')
  })

  it('an unreadable poster that a later one of the same day replaced is skipped', async () => {
    // the evening poster of 5631 is a banner now; the re-issue of 14:48 reads, and with nothing
    // read before it, it is the whole day it draws
    const s = await read('2026-11-02T15:00:00+02:00', [
      SITE_DOWN,
      ...channel('5631-5638', { 5638: 'tg-5638.jpg' }),
    ])
    expect(source(s, TG)).toMatchObject({ ok: true, dates: ['2026-11-02'] })
    expect(source(s, TG).unread).toBeUndefined()
    expect(day(s, '1.1', '2026-11-02')).toBe('14:30-16:00 19:00-00:00')
  })

  it('the picture decides the day, and has to fit the post', async () => {
    // the poster for 16.11 under the post that announces 17.11
    const s = await read('2026-11-16T23:30:00+02:00', [
      SITE_16,
      ...channel('5717-5723', { 5718: 'tg-5718.jpg', 5723: 'tg-5718.jpg' }),
    ])
    expect(source(s, TG).unread![0]!.message).toMatch(
      /the picture reads 2026-11-16, its post says 2026-11-17/,
    )
  })

  it("fails the channel when its newest post about a day can't be read, also when tomorrow's poster came after", async () => {
    const misread = (id: number) =>
      posts((input) => (postId(input) === id ? [gpv({ date: '2026-11-17', at: '25:00' })] : undefined))
    const s = await read('2026-11-16T23:30:00+02:00', [SITE_16, ...EVENING], { text: misread(5723) })
    // the days it may be about (its own and the next) are not known, the channel says why
    expect(source(s, TG)).toMatchObject({ ok: true })
    expect(source(s, TG).unread!.map((u) => u.date)).toEqual(['2026-11-16', '2026-11-17'])
    expect(day(s, '1.1', '2026-11-17')).toBe('unknown')
    // 5721 is a correction for the 16th (2.1, 2.2 from 10:10): tomorrow's poster 5723 says nothing
    // about today, and nothing after 5721 gave the 16th whole, so the 16th can't be shown
    const older = await read('2026-11-16T23:30:00+02:00', [SITE_16, ...EVENING], { text: misread(5721) })
    expect(source(older, TG).unread!.map((u) => u.date)).toContain('2026-11-16')
  })

  it('"ОНОВЛЕНИЙ": the re-issued poster replaces the rest of its day only', async () => {
    const pictures = { 5631: 'tg-5631.jpg', 5638: 'tg-5638.jpg' }
    const s = await read('2026-11-02T15:00:00+02:00', [SITE_DOWN, ...channel('5631-5638', pictures)])
    expect(dates(s)).toEqual(['2026-11-02'])
    expect(s.updatedAt).toBe('2026-11-02T14:48:35+02:00')
    // posted at 14:48: before that the evening poster, after it the new one
    expect(day(s, '1.1', '2026-11-02')).toBe('12:00-16:00 19:00-00:00') // 12:00-15:30 | 14:30-16:00 19:00-00:00
    expect(day(s, '3.2', '2026-11-02')).toBe('06:00-09:00 19:00-00:00') // 15:30-19:00 is gone
    expect(day(s, '2.1', '2026-11-02')).toBe('09:00-12:00 16:00-21:00')

    // an hour before the re-issue: the evening poster, and the queues the changes left without
    // both ends not known
    const before = await read('2026-11-02T13:40:00+02:00', [
      SITE_DOWN,
      ...channel('5631-5638', pictures, 5636),
    ])
    expect(before.updatedAt).toBe('2026-11-02T11:20:53+02:00')
    for (const g of ['4.1', '4.2', '5.1', '6.1', '6.2'])
      expect(day(before, g, '2026-11-02'), g).toBe('unknown')
    expect(day(before, '5.2', '2026-11-02')).toBe('06:00-09:00 15:30-19:00')
    expect(day(before, '1.1', '2026-11-02')).toBe('12:00-15:30 19:00-22:30')
  })

  it('a re-issue over a queue a change left unknown does not drop its morning', async () => {
    const s = await read('2026-11-02T15:00:00+02:00', [
      SITE_DOWN,
      ...channel('5631-5638', { 5631: 'tg-5631.jpg', 5638: 'tg-5638.jpg' }),
    ])
    expect(day(s, '5.1', '2026-11-02')).toMatch(/^unknown$|^06:00-09:00/)
  })

  it('changes in words: added where exact, the queues not known where not', async () => {
    const pictures = { 5709: 'tg-5709.jpg', 5714: 'tg-5714.jpg' }
    const s = await read('2026-11-14T18:30:00+02:00', [SITE_DOWN, ...channel('5705-5717', pictures, 5712)])
    expect(dates(s)).toEqual(['2026-11-14'])
    expect(s.updatedAt).toBe('2026-11-14T17:59:16+02:00')
    // 11:55 "З 12:00 …", 12:02 "До 17:00 …", "З 17:00 …", "До 20:00 …", 17:59 "До 22:00 …", "З 20:00 …", "З 22:00 …"
    expect(s.groups.filter((g) => day(s, g, '2026-11-14') === 'unknown')).toEqual([
      '1.1',
      '1.2',
      '3.1',
      '3.2',
      '4.1',
      '4.2',
      '5.2',
      '6.1',
      '6.2',
    ])
    // 5/1, which no post names, keeps the poster
    expect(day(s, '5.1', '2026-11-14')).toBe('11:30-15:00 22:00-00:00')
    const noon = await read('2026-11-14T12:30:00+02:00', [SITE_DOWN, ...channel('5705-5717', pictures, 5711)])
    expect(day(noon, '4.1', '2026-11-14')).toBe('unknown')
    expect(day(noon, '5.2', '2026-11-14')).toBe('11:30-15:00 22:00-00:00')

    const next = await read('2026-11-15T01:00:00+02:00', [SITE_DOWN, ...channel('5705-5717', pictures)])
    expect(dates(next)).toEqual(['2026-11-15'])
    expect(next.updatedAt).toBe('2026-11-15T00:31:39+02:00')
    // 00:31 "З 6:00 до 8:00 додатково відключаються черги 1/1 та 1/2": added to the poster
    expect(day(next, '1.1', '2026-11-15')).toBe('06:00-08:00 16:00-19:30')
    expect(day(next, '1.2', '2026-11-15')).toBe('06:00-08:00 16:00-19:30')
    // 00:11 "До 01:00 продовжується відключення для черг 5/1 та 5/2": an outage the poster of
    // the 15th doesn't have, from a start nobody gave
    expect(day(next, '5.1', '2026-11-15')).toBe('unknown')
    expect(day(next, '2.1', '2026-11-15')).toBe('08:00-10:00 19:30-22:00')
  })

  it('fetches the site poster and takes the update time from Last-Modified', async () => {
    const { client } = reader('2026-11-06T12:00:00+02:00', [
      {
        match: 'schedule_groups.jpg',
        body: fixtureBytes('chernihiv/posters/2026-11-06.jpg'),
        headers: { 'Last-Modified': 'Fri, 06 Nov 2026 06:11:42 GMT' },
      },
      { match: 't.me/s/', body: 'Bad gateway', status: 502 },
    ])
    const s = await client.getSchedule('chernihiv', '6.2')
    expect(s.updatedAt).toBe('2026-11-06T08:11:42+02:00')
    expect(hhmm(s.days[0]!)).toBe('06:00-09:30 13:00-20:00 23:30-00:00')
    expect((await client.healthCheck({ regions: ['chernihiv'] })).regions[0]!.status).toBe('ok')
  })

  it('refuses a site poster whose date is not current, or a file that is no poster', async () => {
    const tgDown = { match: 't.me/s/', body: 'Bad gateway', status: 502 }
    const old = await read('2026-11-06T12:00:00+02:00', [
      { match: 'schedule_groups.jpg', body: fixtureBytes('chernihiv/posters/2026-10-06-tg.jpg') },
      tgDown,
    ]).catch((e) => e)
    // the reading of 06.10 is too far from the file to be validated at all, or not current
    expect(old).toMatchObject({ code: 'parse' })
    const other = await read('2026-11-06T12:00:00+02:00', [
      { match: 'schedule_groups.jpg', body: fixtureBytes('image/sample-444.jpg') },
      tgDown,
    ]).catch((e) => e)
    expect(other).toMatchObject({ code: 'parse', message: expect.stringMatching(/not a schedule poster/) })
  })

  it('without an image processor nothing can be read: `config`', async () => {
    for (const p of [{ image: null }, { text: null, image: null }]) {
      const s = read('2026-11-16T23:30:00+02:00', [SITE_16, ...EVENING], p)
      await expect(s, JSON.stringify(p)).rejects.toMatchObject({ code: 'config' })
    }
  })

  it('without a text processor the site poster still answers; the channel is `config`', async () => {
    const s = await read('2026-11-16T23:30:00+02:00', [SITE_16, ...EVENING], { text: null })
    expect(dates(s)).toEqual(['2026-11-16'])
    expect(day(s, '6.1', '2026-11-16')).toBe('00:00-02:30 09:30-13:00 20:00-22:00')
    // no channel to tell the file's poster by: only its upload time
    expect(s.updatedAt).toBe('2026-11-16T08:05:33+02:00')
    expect(source(s, TG)).toMatchObject({ ok: false, error: { code: 'config' } })
  })
})

describe('Chernihivoblenergo: pictures of the channel', () => {
  const NOW = new Date('2026-11-16T12:00:00+02:00')
  const post = (id: number, at: string, text: string, photos = 1): TelegramPost => ({
    channel: 'chernigivoblenergo',
    id,
    url: `https://t.me/chernigivoblenergo/${id}`,
    at,
    text,
    edited: false,
    replyTo: null,
    photos: Array.from({ length: photos }, (_, i) => `https://cdn4.telesco.pe/file/${id}-${i}.jpg`),
  })
  const OPTS = { groups: STANDARD_GROUPS, updates: 'layer' } as const
  /** `readPicturePosts` as the channel reader runs it, photo K of post N served from `files['N-K']` or `files[N]` */
  function picturePosts(
    list: TelegramPost[],
    files: Record<string, Uint8Array>,
    text: TextProcessor,
    image: ImageProcessor = posters(),
    now = NOW,
  ) {
    const { fetch, calls } = mockFetch(
      Object.entries(files)
        .sort(([a], [b]) => b.length - a.length)
        .map(([id, body]) => ({ match: id.includes('-') ? `/file/${id}.` : `/file/${id}-`, body })),
    )
    const ctx = {
      http: new Http({ fetch }),
      now: () => now,
      ai: new AiRuntime({ textProcessor: text, imageProcessor: image }),
    }
    return { result: readPicturePosts(ctx, 'chernihiv', list, OPTS), calls }
  }

  it("skips pictures that aren't schedules, and fails a post that says its picture is one", async () => {
    // banners, photographs, a digest; 5596 is a portrait infographic, 5617 an explainer about the queues
    for (const id of [5596, 5617, 5642, 5665, 5704, 5705, 5720]) {
      const photo = fixtureBytes(`chernihiv/not-schedules/tg-${id}.jpg`)
      const news = picturePosts([post(1, '2026-11-16T07:14:00+02:00', 'Новини')], { 1: photo }, posts())
      expect((await news.result).days.size).toBe(0)
      // a news post's picture isn't even fetched
      expect(news.calls).toHaveLength(0)
      const announced = picturePosts(
        [
          post(
            1,
            '2026-11-16T07:14:00+02:00',
            '17 листопада в області діятиме Графік погодинних відключень (ГПВ)',
          ),
        ],
        { 1: photo },
        posts(() => poster('2026-11-17')),
      )
      // the day it announces is not known, never "no outages" or an older poster
      expect((await announced.result).days.get('2026-11-17')!.unread, String(id)).toMatchObject({
        code: 'parse',
      })
    }
  })

  it('checks a bare photo cheaply first and reads it in full only when it looks like a schedule', async () => {
    // the cheap check sees a 256 px copy: told apart by the post here
    const image = posters({ check: (input) => input.url.endsWith('/2') })
    const banner = picturePosts(
      [post(1, '2026-11-15T20:00:00+02:00', '')],
      { 1: fixtureBytes('chernihiv/not-schedules/tg-5705.jpg') },
      posts(),
      image,
    )
    expect((await banner.result).days.size).toBe(0)
    expect(image.checks).toHaveLength(1)
    expect(image.calls).toHaveLength(0)
    // a bare poster: its own date decides
    const bare = picturePosts(
      [post(2, '2026-11-15T20:32:00+02:00', '')],
      { 2: fixtureBytes('chernihiv/posters/tg-5718.jpg') },
      posts(),
      image,
    )
    const r = await bare.result
    expect([...r.days.keys()]).toEqual(['2026-11-16'])
    expect(image.calls).toHaveLength(1)
    expect(image.checks[1]!.width).toBeLessThanOrEqual(256)
  })

  it('a re-issued poster with no earlier one to lay it on stands alone', async () => {
    // 26.10.2026 08:57, under a "маємо зміни … на 26 жовтня. Перевірте свій графік!" caption
    const { result } = picturePosts(
      [
        post(
          5594,
          '2026-10-26T08:57:00+02:00',
          'За вказівкою НЕК "Укренерго", маємо зміни у Графіку погодинних відключень (ГПВ) на 26 жовтня ☝️.\n\n🔊 Перевірте свій графік!',
        ),
      ],
      { 5594: fixtureBytes('chernihiv/posters/tg-5594.jpg') },
      posts(() => poster('2026-10-26')),
      undefined,
      new Date('2026-10-26T09:30:00+02:00'),
    )
    const r = await result
    expect(r.pictures['2026-10-26']).toHaveLength(1)
    expect(r.days.get('2026-10-26')!.groups['3.1']).toEqual([
      { start: 480, end: 570, kind: 'off' },
      { start: 900, end: 1260, kind: 'off' },
    ])
  })

  it('an album may split the queues; together they must give all twelve', async () => {
    const half = (from: number) =>
      fakeImage((input) => {
        const queues = input.index === 0 ? STANDARD_GROUPS.slice(0, 6) : STANDARD_GROUPS.slice(6)
        return {
          date: '2026-11-17',
          schedule: queues.map((queue) => ({
            queue,
            intervals: intervalsOf(`${String(from).padStart(2, '0')}:00-12:00`),
          })),
        }
      })
    const caption = '17 листопада в області діятиме Графік погодинних відключень (ГПВ)'
    const two = picturePosts(
      [post(1, '2026-11-16T20:00:00+02:00', caption, 2)],
      {
        '1-0': fixtureBytes('chernihiv/posters/tg-5723.jpg'),
        '1-1': fixtureBytes('chernihiv/posters/tg-5718.jpg'),
      },
      posts(() => poster('2026-11-17')),
      half(8),
    )
    const r = await two.result
    expect(Object.keys(r.days.get('2026-11-17')!.groups)).toHaveLength(12)
    // the second picture missing: six queues are not a day
    const one = picturePosts(
      [post(1, '2026-11-16T20:00:00+02:00', caption, 1)],
      { 1: fixtureBytes('chernihiv/posters/tg-5723.jpg') },
      posts(() => poster('2026-11-17')),
      half(8),
    )
    expect((await one.result).days.get('2026-11-17')!.unread).toMatchObject({ code: 'parse' })
  })

  it('an unreadable re-issue is not excused by a later poster of another day', async () => {
    const caption = (n: number) =>
      `За вказівкою НЕК "Укренерго", ${n} листопада в області діятиме Графік погодинних відключень (ГПВ) ☝️.`
    const reissue =
      'Оскільки сьогодні маємо значні зміни у Графіку погодинних відключень (ГПВ)☝️, перевірте свій!'
    const { result } = picturePosts(
      [
        post(5709, '2026-11-13T21:43:05+02:00', caption(14)),
        post(9001, '2026-11-14T15:00:00+02:00', reissue),
        post(5714, '2026-11-14T20:49:41+02:00', caption(15)),
      ],
      {
        5709: fixtureBytes('chernihiv/posters/tg-5709.jpg'),
        9001: fixtureBytes('chernihiv/not-schedules/tg-5705.jpg'),
        5714: fixtureBytes('chernihiv/posters/tg-5714.jpg'),
      },
      posts((input) => (postId(input) === 9001 ? poster(null) : POSTS[postId(input)])),
      undefined,
      new Date('2026-11-14T21:00:00+02:00'),
    )
    const r = await result
    expect(r.days.get('2026-11-14')!.unread).toMatchObject({ code: 'parse' })
    expect(r.days.get('2026-11-15')!.unread).toBeUndefined()
  })
})
