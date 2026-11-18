import { describe, expect, it } from 'vitest'
import type { PostEvent, PostInput } from '../../src/ai/types.js'
import { OutageClient } from '../../src/client.js'
import { kharkivPosts, kharkivProvider } from '../../src/providers/kharkiv.js'
import type { DaySchedule } from '../../src/types.js'
import { ev, fakeText, fixture, intervalsOf, mockFetch, type Route } from '../helpers.js'

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

/** "1.1 01:00-04:30; 11:30-15:00" lines, as the posts print them → a gpv start */
const day = (date: string, lines: string, at: string | null = null): PostEvent =>
  ev({
    kind: 'gpv',
    action: 'start',
    regions: ['kharkiv'],
    date,
    at,
    schedule: lines
      .trim()
      .split('\n')
      .map((l) => {
        const [queue, hours] = l.trim().split(/ (.*)/) as [string, string]
        return { queue, intervals: intervalsOf(hours.replaceAll(';', ',')) }
      }),
  })

/**
 * What a correct model answers for each post of the fixtures, keyed by the day the post opens
 * with. The site articles and the channel posts carry the same text.
 */
const SCHEDULES: Record<string, PostEvent> = {
  '14 листопада, з 00:00': day(
    '2026-11-14',
    `1.1 07:00-10:30; 16:00-21:00
     1.2 07:00-10:30; 16:00-21:00
     2.1 07:00-10:30; 17:30-21:00
     2.2 07:00-10:30; 14:00-16:00; 17:30-21:00
     3.1 00:00-03:30; 10:30-14:00; 21:00-24:00
     3.2 00:00-03:30; 10:30-14:00; 21:00-24:00
     4.1 00:00-03:30; 10:30-14:00; 17:30-24:00
     4.2 00:00-03:30; 07:00-14:00; 17:30-24:00
     5.1 03:30-07:00; 14:00-17:30
     5.2 03:30-07:00; 14:00-17:30
     6.1 03:30-07:00; 14:00-17:30; 21:00-22:00
     6.2 03:30-07:00; 10:30-17:30; 21:00-22:00`,
  ),
  '15 листопада, з 08:00': day(
    '2026-11-15',
    `1.1 16:00-18:00
     1.2 14:30-18:00
     2.1 14:30-18:00
     2.2 14:30-18:00
     3.1 08:00-11:00; 18:00-22:00
     3.2 18:00-22:00
     4.1 08:00-11:00; 18:00-22:00
     4.2 08:00-11:00; 18:00-22:00
     5.1 11:00-14:30
     5.2 22:00-24:00
     6.1 11:00-14:30; 22:00-24:00
     6.2 11:00-14:30; 22:00-24:00`,
    '08:00',
  ),
  '16 листопада, з 00:00': day(
    '2026-11-16',
    `1.1 01:00-04:30; 11:30-15:00; 22:00-24:00
     1.2 01:00-04:30; 11:30-15:00; 22:00-24:00
     2.1 01:00-04:30; 11:30-15:00; 18:30-24:00
     2.2 01:00-04:30; 08:00-15:00; 18:30-24:00
     3.1 04:30-08:00; 15:00-18:30
     3.2 04:30-08:00; 15:00-18:30
     4.1 04:30-08:00; 11:30-18:30
     4.2 04:30-08:00; 15:00-18:30
     5.1 00:00-01:00; 08:00-11:30; 18:30-22:00
     5.2 00:00-01:00; 08:00-11:30; 18:30-22:00
     6.1 00:00-01:00; 08:00-11:30; 15:00-22:00
     6.2 00:00-01:00; 06:00-11:30; 16:00-22:00`,
  ),
  '17 листопада, з 00:00': day(
    '2026-11-17',
    `1.1 00:00-01:30; 08:30-12:00; 19:00-22:30
     1.2 00:00-01:30; 06:00-12:00; 19:00-22:30
     2.1 00:00-01:30; 08:30-12:00; 16:00-22:30
     2.2 00:00-01:30; 08:30-12:00; 16:00-22:30
     3.1 01:30-05:00; 08:30-15:30; 19:00-24:00
     3.2 01:30-05:00; 12:00-15:30; 19:00-24:00
     4.1 01:30-05:00; 12:00-15:30; 22:30-24:00
     4.2 01:30-05:00; 12:00-15:30; 22:00-24:00
     5.1 05:00-08:30; 12:00-19:00
     5.2 05:00-08:30; 16:00-19:00
     6.1 05:00-08:30; 16:00-19:00
     6.2 05:00-08:30; 16:00-19:00; 22:30-24:00`,
  ),
}

function answer(input: PostInput): PostEvent[] {
  const key = Object.keys(SCHEDULES).find((k) => input.text.includes(k))
  if (key) return [SCHEDULES[key]!]
  // 2368: "ЗАСТОСОВАНО ГРАФІКИ АВАРІЙНИХ ВІДКЛЮЧЕНЬ"
  if (input.text.includes('ЗАСТОСОВАНО ГРАФІКИ АВАРІЙНИХ'))
    return [ev({ kind: 'gav', action: 'start', regions: ['kharkiv'], allQueues: false })]
  // explainers
  return [ev({ kind: 'other', action: null, regions: [] })]
}

function client(routes: Route[], now = NOW, text: ReturnType<typeof fakeText> | null = fakeText(answer)) {
  const { fetch, calls } = mockFetch(routes)
  return {
    client: new OutageClient({
      fetch,
      now: () => now,
      cacheTtlMs: 0,
      providers: [kharkivProvider()],
      ...(text ? { textProcessor: text } : {}),
    }),
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

  it('hands the processor each article with its title, text and time of last edit', async () => {
    const posts = kharkivPosts(JSON.parse(SITE))
    expect(posts).toHaveLength(4)
    expect(posts[0]).toMatchObject({
      source: { kind: 'site', site: 'https://www.oblenergo.kharkiv.ua/uk' },
      title: expect.stringContaining('16 листопада діятимуть'),
      text: expect.stringContaining('1.1 01:00-04:30; 11:30-15:00; 22:00-24:00'),
      publishedAt: '2026-11-15T19:16:41+00:00',
      regions: [expect.objectContaining({ id: 'kharkiv' })],
    })
    expect(posts[0]!.text).not.toContain('<')
  })

  it('rejects a changed API', () => {
    expect(() => kharkivPosts({} as never)).toThrow(/no "data"/)
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

  it('a misread newest channel post leaves its days not known on the channel; the site keeps what it published later', async () => {
    // a model that answers "25:00" for 2376: the newest post may be tomorrow's schedule
    const text = fakeText((input) =>
      input.url.endsWith('/2376') ? [day('2026-11-17', '1.1 23:00-25:00')] : answer(input),
    )
    const s = await client([{ match: WWW, body: SITE }, TELEGRAM], NOW, text).client.getSchedules('kharkiv')
    expect(s.sources![1]).toMatchObject({ ok: true })
    expect(s.sources![1]!.unread!.map((u) => u.date)).toContain('2026-11-17')
    expect(s.schedules['1.1']!.find((d) => d.date === '2026-11-17')?.status ?? 'unknown').toBe('unknown')
  })

  it('reads each post once while it is unchanged', async () => {
    const text = fakeText(answer)
    const { client: c } = client([{ match: WWW, body: SITE }, TELEGRAM], NOW, text)
    await c.getSchedules('kharkiv')
    const first = text.calls.length
    // site: 4 articles; channel: 2376, the one post since yesterday noon
    expect(first).toBe(5)
    await c.getSchedules('kharkiv')
    expect(text.calls).toHaveLength(first)
  })

  it('needs a text processor', async () => {
    const { client: c } = client([{ match: WWW, body: SITE }, TELEGRAM], NOW, null)
    await expect(c.getSchedules('kharkiv')).rejects.toMatchObject({
      code: 'config',
      message: expect.stringContaining('textProcessor'),
    })
  })
})
