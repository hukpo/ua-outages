import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { assessFreshness } from '../../src/freshness.js'
import { parseTelegramPreview, type TelegramPost } from '../../src/emergency/telegram.js'
import { STANDARD_GROUPS } from '../../src/image/table.js'
import { readCardPoster } from '../../src/image/cards.js'
import { POSTER_MODEL } from '../../src/image/digit-model.js'
import { decodeJpeg } from '../../src/image/jpeg.js'
import {
  CHERNIHIV_POSTER,
  chernihivChannelDays,
  parseChernihivPoster,
  posterDay,
} from '../../src/providers/chernihiv.js'
import type { DaySchedule, RegionSchedule } from '../../src/types.js'
import { fixture, fixtureBytes, mockFetch, type Route } from '../helpers.js'

// posters with the times read off them by hand (scripts/train-digits.ts uses the same set): the
// 1200 px site originals of 06, 07 and 16.11, a downscaled copy of 05.11, ~530 px Telegram copies
// of the October layout, and the 471 px Telegram copies of the posters of 26.10–16.11 (tg-<post>)
const labels = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/chernihiv/posters/labels.json', import.meta.url)), 'utf8'),
) as Record<string, { date: string; cards: string[]; unreadable?: string }>

const noonOf = (date: string) => new Date(`${date}T12:00:00+02:00`)
const hhmm = (d: DaySchedule) =>
  d.intervals
    .map(
      (i) =>
        // "~": a `maybe` interval
        `${i.kind === 'maybe' ? '~' : ''}${i.from.slice(11, 16)}-${i.to.slice(0, 10) > d.date ? '00:00' : i.to.slice(11, 16)}`,
    )
    .join(' ')

describe('Chernihivoblenergo poster', () => {
  // a silent misread is the one thing a poster must never give: exactly the label, or a `parse` error
  it.each(Object.entries(labels))('reads %s', (file, want) => {
    if (want.unreadable) {
      expect(() =>
        parseChernihivPoster(fixtureBytes(`chernihiv/posters/${file}`), noonOf(want.date)),
      ).toThrow(expect.objectContaining({ code: 'parse' }))
      return
    }
    const s = parseChernihivPoster(fixtureBytes(`chernihiv/posters/${file}`), noonOf(want.date))
    expect(s.groups).toEqual(STANDARD_GROUPS)
    STANDARD_GROUPS.forEach((g, i) => {
      const day = s.schedules[g]![0]!
      expect(day.date).toBe(want.date)
      expect(hhmm(day), `${g}`).toBe(want.cards[i])
    })
  })

  it('marks "відключень не прогнозується" cards as no outages', () => {
    const s = parseChernihivPoster(fixtureBytes('chernihiv/posters/2026-10-06-tg.jpg'), noonOf('2026-10-06'))
    expect(s.schedules['2.1']![0]).toMatchObject({ status: 'no-outages', intervals: [] })
    expect(s.schedules['1.1']![0]!.status).toBe('scheduled')
  })

  it('sees the "ОНОВЛЕНИЙ" stamp next to a date it could not read for sure', () => {
    // the bold date font alone doesn't read these thin dates with confidence
    const bold = { ...POSTER_MODEL, dates: { bold: POSTER_MODEL.dates.bold! } }
    const read = (file: string) =>
      readCardPoster(decodeJpeg(fixtureBytes(`chernihiv/posters/${file}`)), CHERNIHIV_POSTER, bold)
    // the re-issue of 02.11 14:48, and the evening poster it replaced
    expect(read('tg-5638.jpg')).toMatchObject({ date: null, stamped: true })
    expect(read('tg-5631.jpg')).toMatchObject({ date: null, stamped: false })
  })

  it('refuses a poster whose date is not current', () => {
    expect(() =>
      parseChernihivPoster(fixtureBytes('chernihiv/posters/2026-10-06-tg.jpg'), noonOf('2026-11-06')),
    ).toThrow(/no current date/)
  })

  it('refuses an image that is not the card poster', () => {
    expect(() => parseChernihivPoster(fixtureBytes('image/sample-444.jpg'), noonOf('2026-11-06'))).toThrow(
      expect.objectContaining({ code: 'parse' }),
    )
  })

  it('rejects every picture of the channel that is not a schedule', () => {
    const post = (text: string): TelegramPost => ({
      channel: 'chernigivoblenergo',
      id: 1,
      url: 'https://t.me/chernigivoblenergo/1',
      at: '2026-11-16T07:14:00+02:00',
      text,
      edited: false,
      photos: ['https://cdn4.telesco.pe/file/x.jpg'],
    })
    // banners, photographs, a digest; 5596 is a portrait infographic, 5617 an explainer about the queues
    for (const id of [5596, 5617, 5642, 5665, 5704, 5705, 5720]) {
      const photos = [fixtureBytes(`chernihiv/not-schedules/tg-${id}.jpg`)]
      expect(chernihivChannelDays([{ post: post('Новини'), photos }], '2026-11-16').days).toEqual({})
      // … and when the post says it is the schedule, that is an error, not silence
      expect(() =>
        chernihivChannelDays(
          [{ post: post('17 листопада в області діятиме Графік погодинних відключень (ГПВ)'), photos }],
          '2026-11-16',
        ),
      ).toThrow(expect.objectContaining({ code: 'parse' }))
    }
  })
})

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
  const posts = parseTelegramPreview(html, { withPhotoOnly: true })
  return [
    ...Object.entries(pictures).flatMap(([id, picture]): Route[] => {
      const match = posts.find((p) => p.id === Number(id))?.photos[0]
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

const read = (at: string, routes: Route[]) =>
  new OutageClient({ fetch: mockFetch(routes).fetch, now: () => new Date(at), cacheTtlMs: 0 }).getSchedules(
    'chernihiv',
  )
const day = (s: RegionSchedule, group: string, date: string) => {
  const d = s.schedules[group]!.find((d) => d.date === date)
  return d ? (d.status === 'unknown' ? 'unknown' : hhmm(d)) : undefined
}
const dates = (s: RegionSchedule) => s.schedules['1.1']!.map((d) => d.date)
const source = (s: RegionSchedule, id: string) => s.sources!.find((x) => x.id === id)!
const TG = 'telegram:@chernigivoblenergo'
const EVENING = channel('5717-5723', { 5718: 'tg-5718.jpg', 5723: 'tg-5723.jpg' })

describe('Chernihivoblenergo: site and Telegram together', () => {
  it('evening: the site has today, Telegram has today and tomorrow', async () => {
    const s = await read('2026-11-16T23:30:00+02:00', [SITE_16, ...EVENING])
    expect(dates(s)).toEqual(['2026-11-16', '2026-11-17'])
    expect(s.groups).toEqual(STANDARD_GROUPS)
    // tomorrow: the poster of 23:18, which the site won't have until the morning
    expect(day(s, '1.1', '2026-11-17')).toBe('03:00-06:00 13:00-17:00')
    expect(day(s, '4.2', '2026-11-17')).toBe('00:00-03:00 09:30-13:00 20:30-22:00')
    // today: the channel changed it at 12:15, so its version counts
    expect(day(s, '6.1', '2026-11-16')).toBe('00:00-02:30 09:30-15:00 20:00-22:00')
    expect(day(s, '1.1', '2026-11-16')).toBe('13:00-16:30 20:00-23:30')
    expect(s.updatedAt).toBe('2026-11-16T23:18:48+02:00')
    expect(source(s, 'site')).toMatchObject({
      ok: true,
      dates: [],
      // the file uploaded at 08:05 is the poster of post 5718: published when that was
      updatedAt: '2026-11-15T20:32:02+02:00',
      disagrees: true,
    })
    expect(source(s, TG)).toMatchObject({
      ok: true,
      dates: ['2026-11-16', '2026-11-17'],
      url: 'https://t.me/chernigivoblenergo/5723',
    })
  })

  it('a change in words that gives no end: from its start to the next outage of the poster "maybe"', async () => {
    // 16.11 10:30: "З 07:15 починається відключення для черг 5/1 та 5/2", "З 10:10 … 2/1 та 2/2"
    const s = await read('2026-11-16T10:30:00+02:00', [
      SITE_16,
      ...channel('5717-5723', { 5718: 'tg-5718.jpg' }, 5721),
    ])
    expect(dates(s)).toEqual(['2026-11-16'])
    // no end is given: the power went off at 07:15 and may be back any time before the poster's
    // 09:30. Neither the poster's hours alone (an old schedule under the time of the change) nor
    // an outage to 09:30 (an end nobody gave)
    expect(day(s, '5.1', '2026-11-16')).toBe('~07:15-09:30 09:30-13:00 16:30-20:00')
    expect(day(s, '5.2', '2026-11-16')).toBe('~07:15-09:30 09:30-13:00 20:00-23:30')
    expect(day(s, '2.1', '2026-11-16')).toBe('02:30-06:00 ~10:10-13:00 13:00-16:30 23:30-00:00')
    expect(day(s, '2.2', '2026-11-16')).toBe('02:30-06:00 ~10:10-13:00 13:00-16:30 23:30-00:00')
    expect(s.schedules['5.1']![0]!.intervals[0]).toEqual({
      from: '2026-11-16T07:15:00+02:00',
      to: '2026-11-16T09:30:00+02:00',
      kind: 'maybe',
    })
    // the queues the posts don't name keep the poster's hours
    expect(day(s, '6.1', '2026-11-16')).toBe('00:00-02:30 09:30-13:00 20:00-22:00')
    expect(s.updatedAt).toBe('2026-11-16T10:06:15+02:00')
    expect(source(s, TG).dates).toEqual(['2026-11-16'])
    // the site still has the poster without the changes
    expect(source(s, 'site').disagrees).toBe(true)
    expect(
      assessFreshness(s, { now: new Date('2026-11-16T10:30:00+02:00') }).issues.map((i) => i.code),
    ).toEqual(['sources-disagree'])

    // before the first change post the poster stands for every queue
    const early = await read('2026-11-16T07:00:00+02:00', [
      SITE_16,
      ...channel('5717-5723', { 5718: 'tg-5718.jpg' }, 5719),
    ])
    expect(day(early, '5.1', '2026-11-16')).toBe('09:30-13:00 16:30-20:00')
    expect(day(early, '2.1', '2026-11-16')).toBe('02:30-06:00 13:00-16:30 23:30-00:00')
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
    const s = await read('2026-11-16T23:30:00+02:00', [
      { match: 'schedule_groups.jpg', body: 'Bad gateway', status: 502 },
      ...EVENING,
    ])
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
    expect(source(s, TG)).toMatchObject({ ok: false, dates: [], error: { code: 'parse' } })
    expect(source(s, TG).error!.message).toMatch(/couldn't be loaded/)
    expect(dates(s)).toEqual(['2026-11-16'])
    expect(source(s, 'site').dates).toEqual(['2026-11-16'])
  })

  it('a schedule post whose picture is something else is an error too', async () => {
    const s = await read('2026-11-16T23:30:00+02:00', [
      SITE_16,
      ...channel('5717-5723', { 5718: 'tg-5718.jpg' }),
    ])
    expect(source(s, TG).error).toMatchObject({ code: 'parse' })
    expect(source(s, TG).error!.message).toMatch(/not the poster of twelve cards/)
  })

  it('the header decides the day, and has to fit the post', async () => {
    // the poster for 16.11 under the post that announces 17.11
    const s = await read('2026-11-16T23:30:00+02:00', [
      SITE_16,
      ...channel('5717-5723', { 5718: 'tg-5718.jpg', 5723: 'tg-5718.jpg' }),
    ])
    expect(source(s, TG).error!.message).toMatch(/the header reads 2026-11-16, the post says "17 листопада"/)
  })

  it('"ОНОВЛЕНИЙ": the re-issued poster replaces the rest of its day only', async () => {
    const pictures = { 5631: 'tg-5631.jpg', 5638: 'tg-5638.jpg' }
    const s = await read('2026-11-02T15:00:00+02:00', [
      { match: 'schedule_groups.jpg', body: 'Bad gateway', status: 502 },
      ...channel('5631-5638', pictures),
    ])
    expect(dates(s)).toEqual(['2026-11-02'])
    expect(s.updatedAt).toBe('2026-11-02T14:48:35+02:00')
    // posted at 14:48, its cards begin at 14:30: before that the evening poster, after it the new one
    expect(day(s, '1.1', '2026-11-02')).toBe('12:00-16:00 19:00-00:00') // 12:00-15:30 | 14:30-16:00 19:00-00:00
    expect(day(s, '3.2', '2026-11-02')).toBe('06:00-09:00 19:00-00:00') // 15:30-19:00 is gone
    // 13:49 "З 13:30 починається відключення для черг 5/1 та 5/2", 11:05 "З 11:00 … 6/2": what
    // the change posts said before 14:30 isn't undone by the re-issue
    expect(day(s, '5.1', '2026-11-02')).toBe('06:00-09:00 ~13:30-14:30 14:30-19:00')
    expect(day(s, '5.2', '2026-11-02')).toBe('06:00-09:00 ~13:30-14:30 14:30-19:00')
    expect(day(s, '6.2', '2026-11-02')).toBe('~11:00-12:00 12:00-16:00 19:00-22:30')
    // "До 14:00 продовжується відключення для черги 4/1" at 11:20 had moved its end from 12:00
    expect(day(s, '4.1', '2026-11-02')).toBe('09:00-14:00 16:00-19:00')
    expect(day(s, '2.1', '2026-11-02')).toBe('09:00-12:00 16:00-21:00')

    // an hour before the re-issue: the evening poster with the changes that are exact
    const before = await read('2026-11-02T13:40:00+02:00', [
      { match: 'schedule_groups.jpg', body: 'Bad gateway', status: 502 },
      ...channel('5631-5638', pictures, 5636),
    ])
    expect(before.updatedAt).toBe('2026-11-02T11:20:53+02:00')
    expect(day(before, '4.1', '2026-11-02')).toBe('09:00-14:00 19:00-22:30')
    // "До 17:00 продовжується відключення для черги 6/1": the outage that was to begin at 12:00
    expect(day(before, '6.1', '2026-11-02')).toBe('12:00-17:00 22:30-00:00')
    // "З 11:00 починається відключення для черги 6/2", "З 14:00 … 5/1", "З 17:00 … 4/2": no end,
    // so "maybe" up to the poster's next outage, until the re-issued poster (above) says more
    expect(day(before, '6.2', '2026-11-02')).toBe('~11:00-12:00 12:00-15:30 22:30-00:00')
    expect(day(before, '5.1', '2026-11-02')).toBe('06:00-09:00 ~14:00-15:30 15:30-19:00')
    expect(day(before, '4.2', '2026-11-02')).toBe('09:00-12:00 ~17:00-19:00 19:00-22:30')
    expect(day(before, '5.2', '2026-11-02')).toBe('06:00-09:00 15:30-19:00')
  })

  it('changes in words: applied only where they are exact', async () => {
    const down = { match: 'schedule_groups.jpg', body: 'Bad gateway', status: 502 }
    const pictures = { 5709: 'tg-5709.jpg', 5714: 'tg-5714.jpg' }
    const s = await read('2026-11-14T18:30:00+02:00', [down, ...channel('5705-5717', pictures, 5712)])
    expect(dates(s)).toEqual(['2026-11-14'])
    expect(s.updatedAt).toBe('2026-11-14T17:59:16+02:00')
    // 12:02 "До 17:00 продовжується відключення для черг 4/1 та 4/2", "До 20:00 … 6/1 та 6/2"
    expect(day(s, '6.2', '2026-11-14')).toBe('05:00-08:00 15:00-20:00')
    // … then 17:59 "З 22:00 відключаються черги 4/1 та 4/2": no end, and no outage after it
    expect(day(s, '4.1', '2026-11-14')).toBe('01:30-05:00 11:30-17:00 ~22:00-00:00')
    expect(day(s, '4.2', '2026-11-14')).toBe('01:30-05:00 11:30-17:00 ~22:00-00:00')
    const noon = await read('2026-11-14T12:30:00+02:00', [down, ...channel('5705-5717', pictures, 5711)])
    expect(day(noon, '4.1', '2026-11-14')).toBe('01:30-05:00 11:30-17:00')
    expect(day(noon, '4.2', '2026-11-14')).toBe('01:30-05:00 11:30-17:00')
    // 11:55 "З 12:00 починається відключення для черг 1/1 та 1/2": until when isn't said
    expect(day(s, '1.1', '2026-11-14')).toBe('~12:00-15:00 15:00-18:30')
    // 12:02 "З 17:00 починається … 3/1 та 3/2", then 17:59 "До 22:00 продовжується … 3/2": the
    // outage running at 17:59 is the one that began at 17:00, and now it has an end
    expect(day(s, '3.1', '2026-11-14')).toBe('08:00-11:30 ~17:00-18:30 18:30-22:00')
    expect(day(s, '3.2', '2026-11-14')).toBe('08:00-11:30 17:00-22:00')
    // 17:59 "З 20:00 починається відключення для черги 5/2": 5/1, which no post names, stays
    expect(day(s, '5.2', '2026-11-14')).toBe('11:30-15:00 ~20:00-22:00 22:00-00:00')
    expect(day(s, '5.1', '2026-11-14')).toBe('11:30-15:00 22:00-00:00')
    expect(s.groups.filter((g) => day(s, g, '2026-11-14') === 'unknown')).toEqual([])

    const next = await read('2026-11-15T01:00:00+02:00', [down, ...channel('5705-5717', pictures)])
    expect(dates(next)).toEqual(['2026-11-15'])
    expect(next.updatedAt).toBe('2026-11-15T00:31:39+02:00')
    // 00:31 "З 6:00 до 8:00 додатково відключаються черги 1/1 та 1/2"
    expect(day(next, '1.1', '2026-11-15')).toBe('06:00-08:00 16:00-19:30')
    expect(day(next, '1.2', '2026-11-15')).toBe('06:00-08:00 16:00-19:30')
    // 00:11 "До 01:00 продовжується відключення для черг 5/1 та 5/2": an outage the poster of
    // the 15th doesn't have (it ran over from the 14th) is going on now, till 01:00
    expect(day(next, '5.1', '2026-11-15')).toBe('00:11-01:00 16:00-19:30')
    expect(day(next, '5.2', '2026-11-15')).toBe('00:11-01:00 16:00-19:30')
  })

  it('a re-issued poster with no earlier one to lay it on stands alone', () => {
    // 26.10.2026 08:57, under a "маємо зміни … на 26 жовтня. Перевірте свій графік!" caption
    const r = chernihivChannelDays(
      [
        {
          post: {
            channel: 'chernigivoblenergo',
            id: 5594,
            url: 'https://t.me/chernigivoblenergo/5594',
            at: '2026-10-26T08:57:00+02:00',
            text: 'За вказівкою НЕК "Укренерго", маємо зміни у Графіку погодинних відключень (ГПВ) на 26 жовтня ☝️.\n\n🔊 Перевірте свій графік!',
            edited: false,
            photos: ['x'],
          },
          photos: [fixtureBytes('chernihiv/posters/tg-5594.jpg')],
        },
      ],
      '2026-10-26',
    )
    expect(r.days['2026-10-26']!.publishedAt).toBe('2026-10-26T08:57:00+02:00')
    // it lists the day from 08:00 on: what was before isn't known here, and isn't made up
    expect(hhmm(r.days['2026-10-26']!.schedules['3.1']!)).toBe('08:00-09:30 15:00-21:00')
  })

  it('a header date read without confidence counts only when the caption names the same day', () => {
    const url = 'https://t.me/chernigivoblenergo/1'
    const ahead = { url, text: '18 листопада в області діятиме Графік погодинних відключень (ГПВ) ☝️.' }
    const unsure = { date: null, dateGuess: '2026-11-18' }
    expect(posterDay(unsure, ahead, '2026-11-17')).toBe('2026-11-18')
    // the guess is another day than the caption's, or there is no caption to confirm it
    expect(() => posterDay({ date: null, dateGuess: '2026-11-16' }, ahead, '2026-11-17')).toThrow(/no date/)
    expect(() => posterDay(unsure, { url, text: '' }, '2026-11-17')).toThrow(/no date/)
    // a confident header against the caption, or far from the post
    expect(() => posterDay({ date: '2026-11-17', dateGuess: '2026-11-17' }, ahead, '2026-11-17')).toThrow(
      /the header reads 2026-11-17, the post says "18 листопада"/,
    )
    expect(() => posterDay({ date: '2026-11-19', dateGuess: null }, { url, text: '' }, '2026-11-17')).toThrow(
      /fits a post of 2026-11-17/,
    )
    // the re-issue of the day: "сьогодні"
    const again = {
      url,
      text: 'Оскільки сьогодні маємо значні зміни у Графіку погодинних відключень (ГПВ)☝️, перевірте свій!',
    }
    expect(posterDay({ date: null, dateGuess: '2026-11-17' }, again, '2026-11-17')).toBe('2026-11-17')
    expect(() => posterDay({ date: '2026-11-18', dateGuess: null }, again, '2026-11-17')).toThrow(
      /the post says today/,
    )
  })

  it('changes posted the evening before: a "продовжується" after a start without an end is not applied', () => {
    const post = (id: number, at: string, text: string): TelegramPost => ({
      channel: 'chernigivoblenergo',
      id,
      url: `https://t.me/chernigivoblenergo/${id}`,
      at,
      text,
      edited: false,
      photos: id === 5650 ? ['x'] : [],
    })
    const change = (id: number, at: string, line: string) => ({
      post: post(
        id,
        at,
        `📊 За вказівкою НЕК "Укренерго", маємо зміни у Графіку погодинних відключень (ГПВ) на 4 листопада ☝️.\n\n🕗 ${line}`,
      ),
      photos: [],
    })
    const r = chernihivChannelDays(
      [
        {
          post: post(
            5650,
            '2026-11-03T20:34:00+02:00',
            'За вказівкою НЕК "Укренерго", 4 листопада в області діятиме Графік погодинних відключень (ГПВ) ☝️.',
          ),
          photos: [fixtureBytes('chernihiv/posters/tg-5650.jpg')],
        },
        change(5651, '2026-11-03T21:00:00+02:00', 'З 21:00 починається відключення для черги 3/2.'),
        change(5652, '2026-11-03T21:10:00+02:00', 'До 23:00 продовжується відключення для черги 3/2.'),
      ],
      '2026-11-03',
    )
    // not the poster's 13:00-20:00 drawn on to 23:00 (an outage 20:00-21:00 nobody announced)
    expect(r.days['2026-11-04']!.schedules['3.2']).toEqual({
      date: '2026-11-04',
      status: 'unknown',
      intervals: [],
    })
  })

  it('a change for two days at once is applied to neither, and leaves the queues it names unknown', () => {
    const post = (id: number, at: string, text: string): TelegramPost => ({
      channel: 'chernigivoblenergo',
      id,
      url: `https://t.me/chernigivoblenergo/${id}`,
      at,
      text,
      edited: false,
      photos: id === 5650 ? ['x'] : [],
    })
    const r = chernihivChannelDays(
      [
        {
          post: post(
            5650,
            '2026-11-03T20:34:00+02:00',
            'За вказівкою НЕК "Укренерго", 4 листопада в області діятиме Графік погодинних відключень (ГПВ) ☝️.',
          ),
          photos: [fixtureBytes('chernihiv/posters/tg-5650.jpg')],
        },
        {
          post: post(
            5652,
            '2026-11-03T23:05:00+02:00',
            '📊 За вказівкою НЕК "Укренерго", маємо зміни у Графіку погодинних відключень (ГПВ) на 3 та 4 листопада ☝️.\n\n🕗 З 23:30 починається відключення для черги 6/1.\n🕗 До 3:00 продовжується, відключення для, черг 5/1 та 5/2.\n🕗 До 6:00 продовжується відключення для черг 2/1, 2/2 та 6/2.',
          ),
          photos: [],
        },
      ],
      '2026-11-03',
    )
    expect(Object.keys(r.days)).toEqual(['2026-11-04'])
    expect(r.days['2026-11-04']!.publishedAt).toBe('2026-11-03T23:05:00+02:00')
    // which line is for which day isn't said: the poster's "00:00-03:00 09:30-16:30 20:00-00:00"
    // for 2/1 may or may not have become "…-06:00"
    const nov4 = r.days['2026-11-04']!.schedules
    for (const g of ['2.1', '2.2', '5.1', '5.2', '6.1', '6.2'])
      expect(nov4[g], g).toEqual({ date: '2026-11-04', status: 'unknown', intervals: [] })
    for (const g of ['1.1', '1.2', '3.1', '3.2', '4.1', '4.2']) expect(nov4[g]!.status, g).not.toBe('unknown')
    expect(r.url).toBe('https://t.me/chernigivoblenergo/5652')
  })

  it('a start without an end: "maybe" up to the next outage, and what later posts do to it', () => {
    // the poster of 04.11.2026 (tg-5650.jpg), then change posts of that day made up from the
    // channel's wording
    const post = (id: number, at: string, text: string): TelegramPost => ({
      channel: 'chernigivoblenergo',
      id,
      url: `https://t.me/chernigivoblenergo/${id}`,
      at,
      text,
      edited: false,
      photos: id === 5650 ? ['x'] : [],
    })
    const change = (id: number, at: string, ...lines: string[]) => ({
      post: post(
        id,
        at,
        `📊 За вказівкою НЕК "Укренерго", маємо зміни у Графіку погодинних відключень (ГПВ) на 4 листопада ☝️.\n\n${lines.map((l) => `🕗 ${l}`).join('\n')}`,
      ),
      photos: [],
    })
    const poster = {
      post: post(
        5650,
        '2026-11-03T20:34:00+02:00',
        'За вказівкою НЕК "Укренерго", 4 листопада в області діятиме Графік погодинних відключень (ГПВ) ☝️.',
      ),
      photos: [fixtureBytes('chernihiv/posters/tg-5650.jpg')],
    }
    const nov4 = (...changes: ReturnType<typeof change>[]) => {
      const r = chernihivChannelDays([poster, ...changes], '2026-11-04')
      const d = r.days['2026-11-04']!.schedules
      return (g: string) => (d[g]!.status === 'unknown' ? 'unknown' : hhmm(d[g]!))
    }
    const before = nov4()
    expect(before('2.1')).toBe('00:00-03:00 09:30-16:30 20:00-00:00')
    expect(before('3.1')).toBe('03:00-09:30 13:00-20:00 23:30-00:00')
    expect(before('3.2')).toBe('03:00-09:30 13:00-20:00')
    expect(before('6.1')).toBe('03:00-06:00 09:30-16:30 20:00-00:00')

    // no outage of the poster after it: "maybe" to midnight
    expect(
      nov4(change(5660, '2026-11-04T20:55:00+02:00', 'З 21:00 починається відключення для черги 3/2.'))(
        '3.2',
      ),
    ).toBe('03:00-09:30 13:00-20:00 ~21:00-00:00')
    // a start inside an outage the poster already has says something the poster can't: unknown
    expect(
      nov4(change(5660, '2026-11-04T09:55:00+02:00', 'З 10:00 починається відключення для черги 2/1.'))(
        '2.1',
      ),
    ).toBe('unknown')
    // "продовжується" while a started outage runs: that one ends then, and was off from its start
    const ended = nov4(
      change(5660, '2026-11-04T20:55:00+02:00', 'З 21:00 починається відключення для черги 3/1.'),
      change(5661, '2026-11-04T22:00:00+02:00', 'До 23:00 продовжується відключення для черги 3/1.'),
    )
    expect(ended('3.1')).toBe('03:00-09:30 13:00-20:00 21:00-23:00 23:30-00:00')
    // … an end already past is no reading of it
    expect(
      nov4(
        change(5660, '2026-11-04T20:55:00+02:00', 'З 21:00 починається відключення для черги 3/1.'),
        change(5661, '2026-11-04T22:30:00+02:00', 'До 22:00 продовжується відключення для черги 3/1.'),
      )('3.1'),
    ).toBe('unknown')
    // a second start inside the "maybe" of the first: the power came back in between, when isn't said
    expect(
      nov4(
        change(5660, '2026-11-04T16:55:00+02:00', 'З 17:00 починається відключення для черги 6/1.'),
        change(5661, '2026-11-04T17:55:00+02:00', 'З 18:00 починається відключення для черги 6/1.'),
      )('6.1'),
    ).toBe('unknown')
    // the same start posted twice is one outage, and one "продовжується" ends it
    expect(
      nov4(
        change(5660, '2026-11-04T20:55:00+02:00', 'З 21:00 починається відключення для черги 3/2.'),
        change(5661, '2026-11-04T20:58:00+02:00', 'З 21:00 починається відключення для черги 3/2.'),
        change(5662, '2026-11-04T21:30:00+02:00', 'До 23:00 продовжується відключення для черги 3/2.'),
      )('3.2'),
    ).toBe('03:00-09:30 13:00-20:00 21:00-23:00')
    // a "продовжується" with a started stretch still ahead: which outage goes on isn't said
    expect(
      nov4(
        change(5660, '2026-11-04T18:00:00+02:00', 'З 21:00 починається відключення для черги 3/2.'),
        change(5661, '2026-11-04T19:00:00+02:00', 'До 23:00 продовжується відключення для черги 3/2.'),
      )('3.2'),
    ).toBe('unknown')
    // an exact outage without "додатково" is the same exact outage
    expect(
      nov4(change(5660, '2026-11-04T09:00:00+02:00', 'З 21:00 до 22:00 відключаються черги 3/2.'))('3.2'),
    ).toBe('03:00-09:30 13:00-20:00 21:00-22:00')
    // the other queues of those posts keep the poster
    expect(ended('3.2')).toBe('03:00-09:30 13:00-20:00')
  })

  it('fetches the site poster and takes the update time from Last-Modified', async () => {
    const { fetch } = mockFetch([
      {
        match: 'schedule_groups.jpg',
        body: fixtureBytes('chernihiv/posters/2026-11-06.jpg'),
        headers: { 'Last-Modified': 'Fri, 06 Nov 2026 06:11:42 GMT' },
      },
      { match: 't.me/s/', body: 'Bad gateway', status: 502 },
    ])
    const c = new OutageClient({ fetch, now: () => noonOf('2026-11-06'), cacheTtlMs: 0 })
    const s = await c.getSchedule('chernihiv', '6.2')
    expect(s.updatedAt).toBe('2026-11-06T08:11:42+02:00')
    expect(hhmm(s.days[0]!)).toBe('06:00-09:30 13:00-20:00 23:30-00:00')
    expect((await c.healthCheck({ regions: ['chernihiv'] })).regions[0]!.status).toBe('ok')
  })
})
