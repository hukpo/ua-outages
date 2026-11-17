import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { kharkivProvider } from '../../src/providers/kharkiv.js'
import type { DaySchedule } from '../../src/types.js'
import { fixture, mockFetch, type Route } from '../helpers.js'

// the night the research measured: the site had no post for 17.11, Telegram had it since 23:02
const NOW = new Date('2026-11-17T00:25:00+02:00')
const WWW = 'https://www.oblenergo.kharkiv.ua/uk/jsonapi'
const APEX = 'https://oblenergo.kharkiv.ua/uk/jsonapi'
const SITE = fixture('kharkiv/jsonapi-newsforlenta-2026-11-17T0025.json')
const TELEGRAM: Route = {
  match: 'https://t.me/s/kharkivenergy',
  body: fixture('kharkiv/telegram-kharkivenergy-2367-2376.trimmed.html'),
}
const BAD_HOST: Omit<Route, 'match'> = {
  status: 400,
  body: 'The provided host name is not valid for this server.',
}
const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)

function client(routes: Route[], now = NOW) {
  const { fetch, calls } = mockFetch(routes)
  return {
    client: new OutageClient({ fetch, now: () => now, cacheTtlMs: 0, providers: [kharkivProvider()] }),
    calls,
  }
}

describe('Kharkivoblenergo: site and Telegram', () => {
  it('takes tomorrow from Telegram while the site has no post for it', async () => {
    const s = await client([{ match: WWW, body: SITE }, TELEGRAM]).client.getSchedules('kharkiv')
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17'])
    // "1.1 00:00-01:30; 08:30-12:00; 19:00-22:30" of post 2376
    expect(hhmm(s.schedules['1.1']![1]!)).toEqual(['00:00-01:30', '08:30-12:00', '19:00-22:30'])
    expect(hhmm(s.schedules['6.2']![1]!)).toEqual(['05:00-08:30', '16:00-19:00', '22:30-00:00'])
    // the post time of 2376
    expect(s.updatedAt).toBe('2026-11-16T23:02:44+02:00')
    expect(s.sources).toMatchObject([
      // the site post was last edited 15.11 21:16, after the Telegram post of 21:11
      { id: 'site', ok: true, dates: ['2026-11-16'], updatedAt: '2026-11-15T21:16:41+02:00' },
      { id: 'telegram:@kharkivenergy', ok: true, dates: ['2026-11-17'] },
    ])
    expect(s.sources!.some((x) => x.disagrees)).toBe(false)
  })

  it('reads the same text from both: no disagreement, emergency posts ignored', async () => {
    // the window also holds "УВАГА! ЗАСТОСОВАНО ГРАФІКИ АВАРІЙНИХ…" (2368) and an explainer
    // about ГАВ (2370)
    const s = await client(
      [{ match: WWW, body: SITE }, TELEGRAM],
      new Date('2026-11-16T23:30:00+02:00'),
    ).client.getSchedules('kharkiv')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-15', '2026-11-16', '2026-11-17'])
    expect(hhmm(s.schedules['1.1']![1]!)).toEqual(['01:00-04:30', '11:30-15:00', '22:00-00:00'])
    expect(s.sources!.map((x) => [x.ok, x.disagrees])).toEqual([
      [true, undefined],
      [true, undefined],
    ])
  })

  it('falls back to the bare host when www refuses', async () => {
    const { client: c, calls } = client([{ match: WWW, ...BAD_HOST }, { match: APEX, body: SITE }, TELEGRAM])
    const s = await c.getSchedules('kharkiv')
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: true, dates: ['2026-11-16'] })
    const site = calls.map((x) => x.url).filter((u) => u.includes('jsonapi'))
    expect(site.map((u) => new URL(u).host)).toEqual(['www.oblenergo.kharkiv.ua', 'oblenergo.kharkiv.ua'])
  })

  it('still answers from Telegram when the site is down on both hosts', async () => {
    const s = await client([
      { match: WWW, ...BAD_HOST },
      { match: APEX, ...BAD_HOST },
      TELEGRAM,
    ]).client.getSchedules('kharkiv')
    expect(s.schedules['3.2']!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: false, error: { code: 'http' } })
    expect(s.sources![1]).toMatchObject({ ok: true, dates: ['2026-11-17'] })
  })

  it('still answers from the site when Telegram is down, without tomorrow', async () => {
    const s = await client([
      { match: WWW, body: SITE },
      { match: 'https://t.me/s/', status: 500, body: '' },
    ]).client.getSchedules('kharkiv')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-16'])
    expect(s.sources![1]).toMatchObject({ ok: false })
  })

  it('fails with the site error when both are down', async () => {
    await expect(
      client([
        { match: WWW, ...BAD_HOST },
        { match: APEX, ...BAD_HOST },
        { match: 'https://t.me/s/', status: 500, body: '' },
      ]).client.getSchedules('kharkiv'),
    ).rejects.toMatchObject({ code: 'http', message: expect.stringContaining('oblenergo.kharkiv.ua') })
  })

  it('keeps the groups listed and unknown when neither has a schedule', async () => {
    const s = await client(
      [
        { match: WWW, body: '{"data":[]}' },
        { match: 'https://t.me/s/', body: fixture('telegram/cek_info-4315-4316.trimmed.html') },
      ],
      new Date('2026-11-16T12:00:00+02:00'),
    ).client.getSchedules('kharkiv')
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']).toEqual([{ date: '2026-11-16', status: 'unknown', intervals: [] }])
    expect(s.updatedAt).toBeNull()
  })

  it('fails the channel when the pages read do not reach back to the evening post', async () => {
    // a busy day: two pages of posts, all of them from today, and more behind them
    const post = (id: number, at: string, text: string) =>
      `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="kharkivenergy/${id}">` +
      `<div class="tgme_widget_message_text js-message_text" dir="auto">${text.replace(/\n/g, '<br/>')}</div>` +
      `<span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/kharkivenergy/${id}"><time datetime="${at}" class="time">00:00</time></a></span></div></div>`
    const s = await client(
      [
        { match: WWW, body: SITE },
        {
          match: 'kharkivenergy?before=',
          body: post(2390, '2026-11-17T08:00:00+02:00', 'Енергетики працюють над відновленням.'),
        },
        {
          match: 'https://t.me/s/kharkivenergy',
          body: post(
            2400,
            '2026-11-17T15:00:00+02:00',
            'Оновлено графіки погодинних відключень (ГПВ) на 17 листопада:\n1.1 19:00-22:30',
          ),
        },
      ],
      new Date('2026-11-17T15:30:00+02:00'),
    ).client.getSchedules('kharkiv')
    expect(s.sources![1]).toMatchObject({
      ok: false,
      error: { code: 'parse', message: expect.stringContaining("couldn't all be read") },
    })
    // not the afternoon update alone as the whole of today
    expect(s.sources![1]!.dates).toEqual([])
  })
})
