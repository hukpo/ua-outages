import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import {
  announcements,
  khmelnytskyiProvider,
  newsLinks,
  parseEmergencyQueues,
  parseQueues,
  textSchedules,
} from '../../src/providers/khmelnytskyi.js'
import type { DaySchedule } from '../../src/types.js'
import { expectUnpublished, fixture, mockFetch, type Route } from '../helpers.js'

const SITE = 'https://hoe.com.ua'

function client(queues = 'khmelnytskyi/shutdown-queues-280957-house-2.html') {
  const { fetch, calls } = mockFetch([
    // the fixture was captured for the term "Хмел"
    { match: `${SITE}/settlements/?term=`, body: fixture('khmelnytskyi/address-1-settlements.json') },
    { match: `${SITE}/streets/26499?term=`, body: fixture('khmelnytskyi/address-2-streets.json') },
    { match: `${SITE}/houses/280957`, body: fixture('khmelnytskyi/address-3-houses.json') },
    { match: `${SITE}/shutdown-queues`, method: 'POST', body: fixture(queues) },
  ])
  return {
    client: new OutageClient({
      fetch,
      now: () => new Date('2026-11-05T23:50:00+02:00'),
      cacheTtlMs: 0,
      providers: [khmelnytskyiProvider()],
    }),
    calls,
  }
}

describe('Khmelnytskoblenergo', () => {
  it('walks settlement → street → house → subgroup', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('khmelnytskyi', {
      city: 'Хмельницький',
      street: 'вул. Проскурівська',
      house: '2',
    })
    expect(m).toEqual({
      region: 'khmelnytskyi',
      group: '6.1',
      address: { city: 'м. Хмельницький', street: 'вул. Проскурівська', house: '2' },
      // the second alert: "(ГАВ) ваша адреса відноситься до черги: <strong>3</strong>"
      emergency: { gav: ['3'] },
    })
    expect(
      calls.every(
        (x) => (x.init!.headers as Record<string, string>)['X-Requested-With'] === 'XMLHttpRequest',
      ),
    ).toBe(true)
    // the server searches by substring and has no "вул." in its names
    expect(decodeURIComponent(calls[1]!.url)).toBe(`${SITE}/streets/26499?term=проскурівська`)
    expect(String(calls.at(-1)!.init!.body)).toBe('streetId=280957&house=2')
  })

  it('returns every subgroup of a building with several connections', async () => {
    const m = await client('khmelnytskyi/address-5-queues.html').client.findGroup('khmelnytskyi', {
      city: 'Хмельницький',
      street: 'Проскурівська',
      house: '1',
    })
    expect(m).toMatchObject({ group: '1.1', otherGroups: ['3.1', '4.1', '6.1', '6.2'] })
    // "8, 8, 3": one per connection, de-duplicated and sorted
    expect(m.emergency).toEqual({ gav: ['3', '8'] })
  })

  it('leaves the ГАВ queue out when the operator gives none', () => {
    const html = fixture('khmelnytskyi/shutdown-queues-empty-gav.html')
    expect(parseQueues(html)).toEqual(['6.2'])
    expect(parseEmergencyQueues(html)).toBeUndefined()
  })

  it('splits the settlement name from its community', async () => {
    const cities = await client().client.searchCities('khmelnytskyi', 'Хмелівка')
    expect(cities).toEqual([
      { id: '26030', name: 'с. Хмелівка', district: 'Городоцька громада', score: 1 },
      { id: '26772', name: 'с. Хмелівка', district: 'Михайлюцька громада', score: 1 },
    ])
    await expect(
      client().client.findGroup('khmelnytskyi', { city: 'Хмелівка', street: 'Проскурівська', house: '1' }),
    ).rejects.toThrow(/matches several/)
  })

  it('rejects a changed format', () => {
    expect(() => parseQueues('<!DOCTYPE html><html><title>Помилка</title></html>')).toThrow(
      expect.objectContaining({ code: 'parse' }),
    )
  })
})

describe('Khmelnytskoblenergo: page, news post and Telegram', () => {
  const K = 'khmelnytskyi/'
  const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)
  // 17.11 00:28: three blocks, all for 16.11
  const PAGE: Route = {
    match: '/page/pogodinni-vidkljuchennja',
    body: fixture(K + 'page-2026-11-17T0028.fragment.html'),
  }
  const ARCHIVE: Route = { match: '/page/arhiv', body: fixture(K + 'archive-2026.html') }
  const LIST: Route = {
    match: '/post/novini-kompaniji',
    body: fixture(K + 'news-list-2026-11-17T0045.fragment.html'),
  }
  const NEWS: Route[] = [16, 17].map((d) => ({
    match: `/post/prognoz-gpv-na-${d}-listopada.html`,
    body: fixture(`${K}news-prognoz-gpv-na-${d}-listopada.fragment.html`),
  }))
  const CHANNEL: Route = {
    match: 't.me/s/khmelnytskoblenergo',
    body: fixture(K + 'telegram-khmelnytskoblenergo-1888-1896.trimmed.html'),
  }
  const down = (match: string): Route => ({ match, status: 500, body: '' })
  const NIGHT = new Date('2026-11-17T00:34:00+02:00')

  function schedules(routes: Route[], now = NIGHT) {
    const { fetch, calls } = mockFetch(routes)
    const c = new OutageClient({ fetch, now: () => now, cacheTtlMs: 0, providers: [khmelnytskyiProvider()] })
    return c.getSchedules('khmelnytskyi').then((s) => ({ s, calls }))
  }

  it('has today from Telegram and the news post while the page still shows yesterday', async () => {
    const { s, calls } = await schedules([PAGE, ARCHIVE, LIST, ...NEWS, CHANNEL])
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17'])
    // post 1896, "17.11.2026 р.": "Підчерга 1.1 – 14:00-18:00; 22:00-24:00."
    expect(hhmm(s.schedules['1.1']![1]!)).toEqual(['14:00-18:00', '22:00-00:00'])
    expect(hhmm(s.schedules['3.2']![1]!)).toEqual(['10:00-14:00', '22:00-00:00'])
    expect(s.updatedAt).toBe('2026-11-16T22:55:52+02:00')
    expect(s.sources).toMatchObject([
      { id: 'site', ok: true, dates: ['2026-11-16'], updatedAt: '2026-11-16T15:00:00+02:00' },
      // the same text as Telegram for 17.11, but a first announcement carries no time
      { id: 'news', ok: true, dates: [], updatedAt: null },
      { id: 'telegram:@khmelnytskoblenergo', ok: true, dates: ['2026-11-17'] },
    ])
    expect(s.sources!.some((x) => x.disagrees)).toBe(false)
    // page, archive, news list, one news post (today's), one channel page
    expect(calls).toHaveLength(5)
  })

  it('layers "оновлено з 15:00" onto the day instead of losing the morning', async () => {
    const { s } = await schedules([PAGE, ARCHIVE, LIST, ...NEWS, CHANNEL])
    const nov16 = (g: string) => hhmm(s.schedules[g]![0]!)
    // first: 1.1 10:00-14:00; 20:00-24:00. The update lists only "Підчерга 1.1 – 20:00-24:00."
    expect(nov16('1.1')).toEqual(['10:00-14:00', '20:00-00:00'])
    // the 23:00 update of the evening before is the whole day (it added 03:00-06:00) …
    expect(nov16('2.1')).toEqual(['03:00-06:00', '14:00-18:00', '22:00-00:00'])
    // … and the 15:00 one replaced 5.1's 16:00-20:00 with 18:00-20:00
    expect(nov16('5.1')).toEqual(['06:00-10:00', '18:00-20:00'])
    expect(nov16('6.1')).toEqual(['06:00-10:00', '15:00-18:00'])
    // the top block alone, as it was read before
    const top = announcements(PAGE.body as string, NIGHT)[0]!
    expect(top.body).toContain('оновлено з 15:00, 16.11.2026')
  })

  it('reads the same day the same way from each of the three', async () => {
    const at = new Date('2026-11-16T23:30:00+02:00')
    const site = await schedules([PAGE, ARCHIVE, down('/post/'), down('t.me')], at)
    const news = await schedules([down('/page/'), LIST, ...NEWS, down('t.me')], at)
    const tg = await schedules([down('hoe.com.ua'), CHANNEL], at)
    const nov16 = (r: typeof site) =>
      r.s.groups.map((g) => hhmm(r.s.schedules[g]!.find((d) => d.date === '2026-11-16')!))
    expect(nov16(news)).toEqual(nov16(site))
    // Telegram: 1892 (20:17), 1893 (23:09, the evening before) and 1894 (14:51, "оновлено з 15:00")
    expect(nov16(tg)).toEqual(nov16(site))
    expect(site.s.sources!.map((x) => x.ok)).toEqual([true, false, false])
    expect(news.s.sources!.map((x) => x.ok)).toEqual([false, true, false])
    expect(news.s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17'])
    expect(news.s.updatedAt).toBe('2026-11-16T15:00:00+02:00')
    expect(tg.s.sources![0]).toMatchObject({ ok: false, error: { code: 'http' } })
  })

  it('applies "(16:00)" and "(з 17:30)" updates of a Telegram day in turn', async () => {
    // 15.11: first post lists 8 subgroups; 1890 "(16:00)" moves 3.2 to 17:00-19:00 and adds
    // 3.1; 1891 "(з 17:30)" adds 22:00-24:00 and queue 2
    const { s } = await schedules([down('hoe.com.ua'), CHANNEL], new Date('2026-11-15T18:00:00+02:00'))
    const nov15 = (g: string) => s.schedules[g]!.find((d) => d.date === '2026-11-15')!
    expect(hhmm(nov15('3.2'))).toEqual(['17:00-19:00', '22:00-00:00'])
    expect(hhmm(nov15('2.1'))).toEqual(['19:00-22:00'])
    expect(hhmm(nov15('6.1'))).toEqual(['17:30-19:00', '22:00-00:00'])
    expect(nov15('1.1').status).toBe('scheduled')
  })

  it('finds the day posts in the news list by title, whatever the slug', () => {
    const list = LIST.body as string
    expect(newsLinks(list, NIGHT)).toEqual([
      { path: '/post/prognoz-gpv-na-17-listopada.html', date: '2026-11-17' },
    ])
    // "Погодинні відключення на 15 листопада (ОНОВЛЕНО, 17:10)"; "#ПитанняВідповідь. Графіки
    // погодинних відключень (ГПВ)" has no date and is no schedule
    expect(newsLinks(list, new Date('2026-11-14T22:00:00+02:00'))).toEqual([
      { path: '/post/prognoz-gpv-na-16-listopada.html', date: '2026-11-16' },
      { path: '/post/pogodinni-vidkljuchennja-na-15-listopada.html', date: '2026-11-15' },
      { path: '/post/prognoz-gpv-na-14-listopada.html', date: '2026-11-14' },
    ])
    expect(() => newsLinks('<html></html>', NIGHT)).toThrow(expect.objectContaining({ code: 'parse' }))
  })

  it('fails with the page error when all three are down, and rejects an unreadable block', async () => {
    await expect(schedules([down('hoe.com.ua'), down('t.me')])).rejects.toMatchObject({ code: 'http' })
    const broken = '<div class="post"><p>ГПВ на 16 листопада</p><p>Підчерга А – зранку</p><hr /></div>'
    expect(() => textSchedules(broken, NIGHT, '2026-11-16')).toThrow(/no subgroups read/)
  })

  /** A preview page of made-up posts; the first is days old, so the window is read whole */
  const channel = (posts: { id: number; at: string; text: string }[]): Route => ({
    match: 't.me/s/khmelnytskoblenergo',
    body: [{ id: 1800, at: '2026-11-10T10:00:00+00:00', text: 'Шановні споживачі!' }, ...posts]
      .map(
        (p) =>
          `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="khmelnytskoblenergo/${p.id}">` +
          `<div class="tgme_widget_message_text js-message_text" dir="auto">${p.text.replace(/\n/g, '<br/>')}</div>` +
          `<span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/khmelnytskoblenergo/${p.id}"><time datetime="${p.at}" class="time">00:00</time></a></span></div></div>`,
      )
      .join('\n'),
  })
  const sitePage = (...blocks: string[]): Route => ({
    match: '/page/pogodinni-vidkljuchennja',
    body: `<div class="post">${blocks.join('<hr />')}<hr /></div><p>Перевірити чергу</p>`,
  })

  it('"(оновлено з 18:00, …)" read at 17:10 is no time of publication: a newer Telegram post wins', async () => {
    const now = new Date('2026-11-17T17:10:00+02:00')
    const PAGE_18 = sitePage(
      '<p>Оновлено графік погодинних відключень (ГПВ) на 17 листопада (оновлено з 18:00, 17.11.2026).</p><p>Підчерга 1.1 – 18:00-22:00.</p>',
    )
    // 17:05, after the page's announcement: the outage moves to 19:00-21:00
    const newer = channel([
      {
        id: 1900,
        at: '2026-11-17T15:05:00+00:00',
        text: 'Графік погодинних відключень на 17.11.2026 р. (оновлено з 19:00)\nПідчерга 1.1 – 19:00-21:00.',
      },
    ])
    const { s } = await schedules([PAGE_18, ARCHIVE, down('/post/'), newer], now)
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['19:00-21:00'])
    expect(s.updatedAt).toBe('2026-11-17T17:05:00+02:00')
    expect(s.sources).toMatchObject([
      { id: 'site', dates: [], updatedAt: null, disagrees: true },
      { id: 'news', ok: false },
      { id: 'telegram:@khmelnytskoblenergo', dates: ['2026-11-17'] },
    ])

    // alone, the page still gives the day, and no `updatedAt` from the future
    const alone = await schedules([PAGE_18, ARCHIVE, down('/post/'), down('t.me')], now)
    expect(hhmm(alone.s.schedules['1.1']![0]!)).toEqual(['18:00-22:00'])
    expect(alone.s.updatedAt).toBeNull()
    // once 18:00 has passed the stamp is a time again
    const later = await schedules(
      [PAGE_18, ARCHIVE, down('/post/'), down('t.me')],
      new Date('2026-11-17T18:20:00+02:00'),
    )
    expect(later.s.updatedAt).toBe('2026-11-17T18:00:00+02:00')
  })

  it('a cancellation on the page reaches the reader although it names no subgroup', async () => {
    const now = new Date('2026-11-17T10:00:00+02:00')
    const first =
      '<p>Графік погодинних відключень (ГПВ) на 17 листопада.</p><p>Підчерга 1.1 – 14:00-18:00.<br />Підчерга 2.1 – 18:00-22:00.</p>'
    const cancel = '<p>Графік погодинних відключень на 17 листопада скасовано.</p>'
    const before = await schedules([sitePage(first), ARCHIVE, down('/post/'), down('t.me')], now)
    expect(hhmm(before.s.schedules['1.1']![0]!)).toEqual(['14:00-18:00'])

    const { s } = await schedules([sitePage(cancel, first), ARCHIVE, down('/post/'), down('t.me')], now)
    // neither the old hours nor "no outages"
    expectUnpublished(s, 12)
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: true, dates: ['2026-11-17'] })
    expect(announcements(sitePage(cancel, first).body as string, now)).toHaveLength(2)

    // a schedule published after the cancellation stands again
    const again = await schedules(
      [sitePage(first, cancel, first), ARCHIVE, down('/post/'), down('t.me')],
      now,
    )
    expect(hhmm(again.s.schedules['1.1']![0]!)).toEqual(['14:00-18:00'])
    // text without a date is about no day: the schedule under it stays
    const standing = '<p>Графіки погодинних відключень застосовуються за розпорядженням НЕК «Укренерго».</p>'
    expect(announcements(sitePage(standing, first).body as string, now)).toHaveLength(1)
  })

  it('nothing published on any of the three: twelve subgroups, today unknown, never `groups: []`', async () => {
    const now = new Date('2026-11-20T12:00:00+02:00')
    const { s } = await schedules([sitePage(), ARCHIVE, LIST, channel([])], now)
    expect(s.sources!.map((x) => [x.ok, x.dates])).toEqual([
      [true, []],
      [true, []],
      [true, []],
    ])
    expectUnpublished(s, 12)
    expect(s.schedules['6.2']).toEqual([{ date: '2026-11-20', status: 'unknown', intervals: [] }])
  })
})
