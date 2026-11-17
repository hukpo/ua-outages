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
import { fixture, mockFetch, type Route } from '../helpers.js'

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
})
