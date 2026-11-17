import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { parseTelegramPreview, type TelegramPost } from '../../src/emergency/telegram.js'
import { assessFreshness } from '../../src/freshness.js'
import { Http } from '../../src/http.js'
import { dateGrid, gridToSource, kirovohradProvider, parseGrid } from '../../src/providers/kirovohrad.js'
import {
  gpvVersionsToSource,
  parseGpvPosts,
  standingVersions,
  type GpvVersion,
} from '../../src/providers/kirovohrad-telegram.js'
import type { RegionSchedule } from '../../src/types.js'
import { expectUnpublished, fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-05T23:40:00+02:00')
const B = 'https://kiroe.com.ua/electricity-blackout'
const TG = 't.me/s/SvitloKropyvnytskyiMisto'
const EMPTY = '{"success":true,"data":[]}'
const TOKEN = '00000000000000000000000000000000'
const GRID_05 = fixture('kirovohrad/blackout-actual-gpv-graphs.2026-11-05.json')
/** Fetched 17.11.2026 00:43: the list of post 1828 */
const GRID_17 = fixture('kirovohrad/blackout-actual-gpv-graphs.2026-11-17T0043.json')
/** 04–05.11.2026: the list for 05.11 and its changes; 1755 (21:27) is what the 05.11 grid shows */
const CHANNEL_05 = fixture('kirovohrad/telegram-SvitloKropyvnytskyiMisto-1747-1755.trimmed.html')
/** 14–16.11.2026: lists for 15, 16 and 17.11, the cancellation of 15.11 20:24, СГАВ notices */
const CHANNEL_17 = fixture('kirovohrad/telegram-SvitloKropyvnytskyiMisto-1813-1828.trimmed.html')

/** The posts of a saved preview page up to `last` (the channel as it was at that moment) */
function upTo(page: string, last: number): string {
  const [head, ...blocks] = page.split(/(?=<div class="tgme_widget_message_wrap\b)/)
  return head + blocks.filter((b) => Number(/data-post="[^"/]+\/(\d+)"/.exec(b)![1]) <= last).join('')
}
const posts = (page: string): TelegramPost[] => parseTelegramPreview(page)
const versionsAt = (page: string, now: Date) => parseGpvPosts(posts(page), now)
const version = (page: string, id: number, now: Date) =>
  versionsAt(page, now).find((v) => v.url.endsWith(`/${id}`))!

/**
 * The grid the site draws for a channel list: "1" for its hours, "10" ("possible") for the half
 * hour on each side of a block, as in both saved grids. Derived, for the moments nobody saved.
 */
function gridOf(v: GpvVersion): string {
  const data: Record<string, { times: Record<string, string> }> = {}
  for (let q = 1; q <= 6; q++)
    for (const sub of [1, 2]) {
      const cells = new Array<string>(48).fill('0')
      for (const s of v.slots[`${q}.${sub}`] ?? []) cells.fill('1', s.start / 30, s.end / 30)
      const edged = cells.map((c, i) =>
        c === '0' && (cells[i - 1] === '1' || cells[i + 1] === '1') ? '10' : c,
      )
      const times: Record<string, string> = {}
      edged.forEach((c, i) => {
        times[`${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`] = c
      })
      data[`${q}.${sub}`] = { times }
    }
  return JSON.stringify({ success: true, data })
}

function setup(
  opts: {
    graphs?: string
    sessionDead?: boolean
    now?: Date
    /** The channel's preview page; null = Telegram can't be reached */
    channel?: string | null
  } = {},
) {
  const dead = opts.sessionDead ?? false
  const now = opts.now ?? NOW
  const { fetch, calls } = mockFetch([
    {
      match: /electricity-blackout$/,
      method: 'GET',
      body: fixture('kirovohrad/blackout-page-offices.html'),
      headers: { 'set-cookie': '8f3a1c7833fb0e0c789b47f2e28acc10=sess; path=/' },
    },
    {
      match: `${B}/actual-gpv-graphs`,
      method: 'POST',
      body: () => (dead ? EMPTY : (opts.graphs ?? GRID_05)),
    },
    {
      match: `${B}/city/86`,
      method: 'POST',
      body: () => (dead ? EMPTY : fixture('kirovohrad/blackout-city-86.json')),
    },
    { match: /\/city\/\d+$/, method: 'POST', body: EMPTY },
    {
      match: `${B}/street/1471`,
      method: 'POST',
      body: fixture('kirovohrad/blackout-street-1471.TRIMMED.json'),
    },
    { match: `${B}/house/14592`, method: 'POST', body: fixture('kirovohrad/blackout-house-14592.json') },
    {
      match: `${B}/get-house-info/96451`,
      method: 'POST',
      body: fixture('kirovohrad/blackout-get-house-info-96451.json'),
    },
    opts.channel === null
      ? { match: TG, body: 'bad gateway', status: 502 }
      : { match: TG, body: opts.channel ?? CHANNEL_05 },
  ])
  const provider = kirovohradProvider()
  return {
    client: new OutageClient({ fetch, now: () => now, cacheTtlMs: 0, retries: 0, providers: [provider] }),
    ctx: { http: new Http({ fetch }), now: () => now },
    provider,
    calls,
  }
}

const spans = (s: RegionSchedule, group: string, date?: string) =>
  (date ? s.schedules[group]!.find((d) => d.date === date)! : s.schedules[group]![0]!).intervals.map(
    (i) => `${i.from.slice(11, 16)}–${i.to.slice(11, 16)} ${i.kind}`,
  )
const source = (s: RegionSchedule, id: string) => s.sources!.find((x) => x.id === id)!
const SITE = 'site'
const CHANNEL = 'telegram:@SvitloKropyvnytskyiMisto'

describe('Kirovohradoblenergo', () => {
  const graphs = JSON.parse(GRID_05).data

  it('reads today’s half-hour cells with possible-outage edges', async () => {
    const s = await setup().client.getSchedules('kirovohrad')
    expect(s.groups).toEqual([
      '1.1',
      '1.2',
      '2.1',
      '2.2',
      '3.1',
      '3.2',
      '4.1',
      '4.2',
      '5.1',
      '5.2',
      '6.1',
      '6.2',
    ])
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-05'])
    // "times" of 1.1: 01:30 "10", 02:00–03:30 "1", 04:00 "10", …
    expect(spans(s, '1.1')).toEqual([
      '01:30–02:00 maybe',
      '02:00–04:00 off',
      '04:00–04:30 maybe',
      '05:30–06:00 maybe',
      '06:00–08:00 off',
      '08:00–08:30 maybe',
      '13:30–14:00 maybe',
      '14:00–16:00 off',
      '16:00–16:30 maybe',
      '17:30–18:00 maybe',
      '18:00–20:00 off',
      '20:00–20:30 maybe',
    ])
    // the grid has no change time of its own: it is the channel's list "станом на 21:27 05.11.2026"
    expect(s.updatedAt).toBe('2026-11-05T21:27:00+02:00')
    expect(s.fetchedAt).toBe('2026-11-05T23:40:00+02:00')
    expect(source(s, SITE)).toMatchObject({ ok: true, dates: ['2026-11-05'] })
  })

  it('fetches with the session cookie, token and Referer', async () => {
    const { client, calls } = setup()
    const s = await client.getSchedules('kirovohrad')
    expect(s.groups).toHaveLength(12)
    const post = calls.find((c) => c.url.endsWith('/actual-gpv-graphs'))!
    const headers = post.init!.headers as Record<string, string>
    expect(headers.Referer).toBe(B)
    expect(headers.Cookie).toBe('8f3a1c7833fb0e0c789b47f2e28acc10=sess')
    expect(Object.fromEntries(new URLSearchParams(String(post.init!.body)))).toEqual({
      ajax: '1',
      token: TOKEN,
    })
  })

  it('publishes nothing from the site when its schedule is empty but the session works', async () => {
    const { client, calls } = setup({ graphs: EMPTY, channel: upTo(CHANNEL_05, 1748) })
    const s = await client.getSchedules('kirovohrad')
    // the 12 groups stay listed, unknown: an empty grid is not "no outages"
    expectUnpublished(s, 12)
    expect(s.sources!.map((x) => [x.ok, x.dates])).toEqual([
      [true, []],
      [true, []],
    ])
    // the empty answer was double-checked against a known ОТГ
    expect(calls.some((c) => c.url.endsWith('/city/86'))).toBe(true)
  })

  it('does not mistake a rejected session for "no outages"', async () => {
    // the channel still answers: its list stands, and the site is reported as failed
    const s = await setup({ sessionDead: true }).client.getSchedules('kirovohrad')
    expect(source(s, SITE)).toMatchObject({
      ok: false,
      error: { code: 'blocked', message: expect.stringMatching(/ignores our session/) },
    })
    expect(source(s, CHANNEL)).toMatchObject({ ok: true, dates: ['2026-11-05'] })
    expect(assessFreshness(s, { now: NOW }).issues.map((i) => i.code)).toContain('source-failed')
    // both down: the site's error
    await expect(
      setup({ sessionDead: true, channel: null }).client.getSchedules('kirovohrad'),
    ).rejects.toMatchObject({ code: 'blocked', message: expect.stringMatching(/ignores our session/) })
  })

  it('renews an expired session instead of reporting no outages', async () => {
    let pages = 0
    const { fetch, calls } = mockFetch([
      {
        match: /electricity-blackout$/,
        method: 'GET',
        body: () => (pages++, fixture('kirovohrad/blackout-page-offices.html')),
      },
      // the second schedule request finds the first session expired
      {
        match: '/actual-gpv-graphs',
        method: 'POST',
        body: () =>
          pages === 1 && calls.filter((c) => c.url.includes('kiroe.com.ua')).length > 2 ? EMPTY : GRID_05,
      },
      { match: TG, body: CHANNEL_05 },
    ])
    const client = new OutageClient({
      fetch,
      now: () => NOW,
      cacheTtlMs: 0,
      providers: [kirovohradProvider()],
    })
    await client.getSchedules('kirovohrad')
    await new Promise((r) => setTimeout(r, 2))
    const s = await client.getSchedules('kirovohrad')
    expect(source(s, SITE)).toMatchObject({ ok: true, dates: ['2026-11-05'] })
    expect(pages).toBe(2)
  })

  it('fails loudly when the cell format changes', () => {
    const odd = structuredClone(graphs)
    odd['1.1'].times['00:00'] = '2'
    expect(() => parseGrid(odd)).toThrow(expect.objectContaining({ code: 'parse' }))
    const short = structuredClone(graphs)
    delete short['3.2'].times['23:30']
    expect(() => parseGrid(short)).toThrow(/47 cells, expected 48/)
    expect(() => parseGrid(['1.1'])).toThrow(expect.objectContaining({ code: 'parse' }))
  })

  it('finds a group by address through ОТГ, settlement, street and house', async () => {
    const m = await setup().client.findGroup('kirovohrad', {
      city: 'Кропивницький',
      street: 'Велика Перспективна',
      house: '2',
    })
    expect(m).toEqual({
      region: 'kirovohrad',
      group: '5.1',
      address: { city: 'Кропивницький', street: 'вул. Велика Перспективна', house: '2' },
    })
  })

  it('explains houses outside the schedule', async () => {
    await expect(
      setup().client.findGroup('kirovohrad', {
        city: 'Кропивницький',
        street: 'Велика Перспективна',
        house: '40',
      }),
    ).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringMatching(/not in the outage schedule/),
    })
  })

  it('asks the site for a house it has not listed in this session', async () => {
    const { provider, ctx } = setup()
    const m = await provider.groupOf!(
      ctx,
      { id: '96451', number: '1б', streetId: '14592' },
      { id: '14592', name: 'вул. Велика Перспективна', cityId: '1471' },
    )
    expect(m.group).toBe('5.1')
  })
})

describe('Kirovohradoblenergo: the channel’s lists', () => {
  const NIGHT = new Date('2026-11-17T00:45:00+02:00')

  it('reads a first publication, a change with its "станом на" time and skips СГАВ notices', () => {
    const all = versionsAt(CHANNEL_17, NIGHT)
    // 1823 and 1825 ("16.11.26 в 16:27 застосовано СГАВ") are the emergency reader's
    expect(all.map((v) => Number(v.url.split('/').pop()))).toEqual([
      1813, 1814, 1815, 1816, 1817, 1818, 1819, 1820, 1821, 1822, 1824, 1826, 1827, 1828,
    ])
    const first = all.find((v) => v.url.endsWith('/1827'))!
    expect(first).toMatchObject({ date: '2026-11-17', at: '2026-11-16T23:35:26+02:00', cancelled: false })
    expect(first.slots['3.2']).toEqual([
      { start: 240, end: 360, kind: 'off' },
      { start: 720, end: 840, kind: 'off' },
      { start: 960, end: 1080, kind: 'off' },
    ])
    // "На 17.11.2026 … станом на 23:56 16.11.2026": a change the evening before, at the stamp's minute
    expect(all.at(-1)).toMatchObject({
      date: '2026-11-17',
      at: '2026-11-16T23:56:00+02:00',
      postedAt: '2026-11-16T23:56:45+02:00',
    })
    // half hours: "Черга 2.1: 00-01:30, 08-10, 16-18, 20-22"
    expect(version(CHANNEL_17, 1822, NIGHT).slots['2.1']![0]).toEqual({ start: 0, end: 90, kind: 'off' })
  })

  it('gives a group missing from a list a day without outages', () => {
    // 1816 (15.11 15:45) lists 2.1–6.2 only
    const days = gpvVersionsToSource(
      versionsAt(upTo(CHANNEL_17, 1816), NIGHT),
      new Date('2026-11-15T16:00:00+02:00'),
    ).days
    const day = days['2026-11-15']!
    expect(day.publishedAt).toBe('2026-11-15T15:45:00+02:00')
    expect(day.schedules['1.1']).toEqual({ date: '2026-11-15', status: 'scheduled', intervals: [] })
    expect(day.schedules['4.2']!.intervals.map((i) => i.from.slice(11, 16))).toEqual(['18:00', '22:00'])
    expect(Object.keys(day.schedules)).toHaveLength(12)
  })

  it('reads the wording used until 05.11.2026 and skips forecasts and ГОП orders', () => {
    const all = versionsAt(CHANNEL_05, NOW)
    expect(all.map((v) => [v.url.split('/').pop(), v.date, v.at])).toEqual([
      // "05.11.2026 - Графік погодинних відключень / За розпорядженням НЕК "Укренерго" 05.11.2026 буде діяти …"
      ['1750', '2026-11-05', '2026-11-04T21:32:02+02:00'],
      // "Зміни на 08:56 05.11.2026 до графіка погодинних відключень"
      ['1752', '2026-11-05', '2026-11-05T08:56:00+02:00'],
      ['1753', '2026-11-05', '2026-11-05T09:55:00+02:00'],
      ['1754', '2026-11-05', '2026-11-05T13:35:00+02:00'],
      ['1755', '2026-11-05', '2026-11-05T21:27:00+02:00'],
    ])
  })

  it('reads both cancellations; "до окремого розпорядження" also withdraws a list for tomorrow', () => {
    const cancel = version(CHANNEL_17, 1818, NIGHT)
    expect(cancel).toMatchObject({
      date: '2026-11-15',
      cancelled: true,
      untilFurtherOrder: true,
      at: '2026-11-15T20:24:03+02:00',
    })
    // a district channel also has the emptied list: "… скасовано графік погодинних відключень (ГПВ) станом на 20:00 15.11.2026:"
    const district = parseGpvPosts(
      posts(fixture('kirovohrad/telegram-SvitloHolovanivskohoRayonu-1791-1793.trimmed.html')),
      NIGHT,
    )
    expect(district.map((v) => [v.cancelled, v.untilFurtherOrder ?? false, v.at])).toEqual([
      [false, false, '2026-11-15T17:49:00+02:00'],
      [true, false, '2026-11-15T20:00:00+02:00'],
      [true, true, '2026-11-15T20:23:17+02:00'],
    ])

    const list = (date: string, at: string): GpvVersion => ({
      date,
      at,
      postedAt: at,
      url: 'https://t.me/x/1',
      cancelled: false,
      slots: { '1.1': [{ start: 0, end: 60, kind: 'off' }] },
    })
    const early = list('2026-11-16', '2026-11-15T20:10:00+02:00')
    const late = list('2026-11-16', '2026-11-15T20:41:54+02:00')
    expect([...standingVersions([early, cancel]).keys()]).toEqual(['2026-11-15'])
    expect(standingVersions([early, cancel, late]).get('2026-11-16')).toBe(late)
  })

  it('refuses a recent list it cannot read exactly, and ignores an old one', () => {
    const post = (id: number, at: string, text: string): TelegramPost => ({
      channel: 'SvitloKropyvnytskyiMisto',
      id,
      url: `https://t.me/SvitloKropyvnytskyiMisto/${id}`,
      at,
      text,
      edited: false,
      photos: [],
    })
    const head = (d: string) =>
      `${d} за розпорядженням НЕК "Укренерго" буде діяти наступний графік погодинних відключень (ГПВ):\n\n`
    const at = '2026-11-16T23:35:26+02:00'
    const bad = [
      // hours that aren't a range
      head('17.11.2026') + 'Черга 1.1: 08-10, з 16',
      // backwards
      head('17.11.2026') + 'Черга 1.1: 10-08',
      // a group the region doesn't have
      head('17.11.2026') + 'Черга 7.1: 08-10',
      head('17.11.2026') + 'Черга 1.1: 08-10\nЧерга 1.1: 12-14',
      // a list for a day that doesn't fit its post: a week ahead, or already past
      head('24.11.2026') + 'Черга 1.1: 08-10',
      head('14.11.2026') + 'Черга 1.1: 08-10',
      // no date
      'За розпорядженням НЕК "Укренерго" буде діяти наступний графік погодинних відключень (ГПВ):\n\nЧерга 1.1: 08-10',
      // a ГПВ cancellation in words the reader doesn't know
      'Сьогодні ГПВ скасовано',
    ]
    for (const text of bad)
      expect(() => parseGpvPosts([post(1, at, text)], NIGHT), text).toThrow(
        expect.objectContaining({ code: 'parse' }),
      )
    // posted before yesterday: it can't matter any more
    expect(parseGpvPosts([post(1, '2026-11-14T23:35:26+02:00', bad[0]!)], NIGHT)).toEqual([])
    // not ГПВ lists at all
    expect(
      parseGpvPosts(
        [post(1, at, '16.11.26 у 19:00 скасовано СГАВ (спеціальний графік аварійних відключень).')],
        NIGHT,
      ),
    ).toEqual([])
  })
})

describe('Kirovohradoblenergo: site and channel merged', () => {
  const v = (id: number) => version(CHANNEL_17, id, new Date('2026-11-17T00:45:00+02:00'))

  it('takes today from the site while it shows the channel’s current list', async () => {
    // live, 17.11.2026 00:43: the grid is post 1828 plus the "possible" half hours
    const now = new Date('2026-11-17T00:45:00+02:00')
    const s = await setup({ now, graphs: GRID_17, channel: CHANNEL_17 }).client.getSchedules('kirovohrad')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(spans(s, '1.1').slice(0, 4)).toEqual([
      '00:00–02:00 off',
      '02:00–02:30 maybe',
      '03:30–04:00 maybe',
      '04:00–06:00 off',
    ])
    expect(s.updatedAt).toBe('2026-11-16T23:56:00+02:00')
    expect(s.sources).toEqual([
      { id: SITE, url: B, ok: true, dates: ['2026-11-17'], updatedAt: '2026-11-16T23:56:00+02:00' },
      {
        id: CHANNEL,
        url: 'https://t.me/s/SvitloKropyvnytskyiMisto',
        ok: true,
        dates: [],
        updatedAt: '2026-11-16T23:56:00+02:00',
      },
    ])
    expect(assessFreshness(s, { now })).toMatchObject({ state: 'fresh', today: 'published', issues: [] })
  })

  it('takes tomorrow from the channel the evening before', async () => {
    const now = new Date('2026-11-16T23:40:00+02:00')
    const s = await setup({
      now,
      graphs: gridOf(v(1826)),
      channel: upTo(CHANNEL_17, 1827),
    }).client.getSchedules('kirovohrad')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17'])
    expect(source(s, SITE)).toMatchObject({ dates: ['2026-11-16'], updatedAt: '2026-11-16T19:49:00+02:00' })
    expect(source(s, CHANNEL)).toMatchObject({
      dates: ['2026-11-17'],
      updatedAt: '2026-11-16T23:35:26+02:00',
    })
    // the text has no "possible" half hours
    expect(spans(s, '1.1', '2026-11-17')).toEqual(['08:00–10:00 off', '16:00–18:00 off', '20:00–22:00 off'])
    expect(s.updatedAt).toBe('2026-11-16T23:35:26+02:00')
    expect(assessFreshness(s, { now, tomorrowExpectedAt: '23:00' })).toMatchObject({
      state: 'fresh',
      tomorrow: 'published',
      issues: [],
    })
  })

  it('dates a grid that hasn’t moved past midnight yesterday, not today', async () => {
    const now = new Date('2026-11-17T00:05:00+02:00')
    const s = await setup({ now, graphs: gridOf(v(1826)), channel: CHANNEL_17 }).client.getSchedules(
      'kirovohrad',
    )
    expect(source(s, SITE)).toMatchObject({ dates: ['2026-11-16'], updatedAt: '2026-11-16T19:49:00+02:00' })
    expect(source(s, CHANNEL)).toMatchObject({
      dates: ['2026-11-17'],
      updatedAt: '2026-11-16T23:56:00+02:00',
    })
    // today is the channel's list, not yesterday's grid under a new date
    expect(spans(s, '1.1', '2026-11-17')[0]).toBe('00:00–02:00 off')
    expect(spans(s, '1.1', '2026-11-16')[0]).toBe('11:30–12:00 maybe')
    expect(assessFreshness(s, { now }).today).toBe('published')
  })

  it('gives a grid nothing confirms no date in the first hour of the day', async () => {
    const grid = parseGrid(JSON.parse(gridOf(v(1826))).data)!
    // the channel is down: at 00:05 the grid may be yesterday's, at 01:30 it is today's
    expect(dateGrid(grid, null, new Date('2026-11-17T00:05:00+02:00'))).toBeNull()
    expect(dateGrid(grid, null, new Date('2026-11-17T00:59:00+02:00'))).toBeNull()
    expect(dateGrid(grid, null, new Date('2026-11-17T01:00:00+02:00'))).toEqual({
      date: '2026-11-17',
      publishedAt: null,
    })
    expect(gridToSource(grid, null, new Date('2026-11-17T00:05:00+02:00')).days).toEqual({})

    const now = new Date('2026-11-17T00:05:00+02:00')
    const s = await setup({ now, graphs: gridOf(v(1826)), channel: null }).client.getSchedules('kirovohrad')
    expectUnpublished(s, 12)
    expect(source(s, SITE)).toMatchObject({ ok: true, dates: [] })
    expect(source(s, CHANNEL)).toMatchObject({ ok: false, error: { code: 'http' } })
  })

  it('still serves today from the site when the channel is down, without a change time', async () => {
    const now = new Date('2026-11-17T09:00:00+02:00')
    const s = await setup({ now, graphs: GRID_17, channel: null }).client.getSchedules('kirovohrad')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(spans(s, '1.1')[0]).toBe('00:00–02:00 off')
    expect(s.updatedAt).toBeNull()
    expect(source(s, SITE)).toMatchObject({ ok: true, dates: ['2026-11-17'], updatedAt: null })
    expect(source(s, CHANNEL).ok).toBe(false)
    expect(assessFreshness(s, { now }).issues.map((i) => i.code)).toEqual(['source-failed'])
  })

  it('prefers the channel when the grid still shows a list it has replaced', async () => {
    // 1827 (23:35) was replaced by 1828 (23:56); the grid is still the first one
    const now = new Date('2026-11-17T01:30:00+02:00')
    const s = await setup({ now, graphs: gridOf(v(1827)), channel: CHANNEL_17 }).client.getSchedules(
      'kirovohrad',
    )
    expect(source(s, CHANNEL)).toMatchObject({
      dates: ['2026-11-17'],
      updatedAt: '2026-11-16T23:56:00+02:00',
    })
    expect(source(s, SITE)).toMatchObject({
      dates: [],
      updatedAt: '2026-11-16T23:35:26+02:00',
      disagrees: true,
    })
    expect(spans(s, '1.1')[0]).toBe('00:00–02:00 off')
    expect(assessFreshness(s, { now }).issues.map((i) => i.code)).toEqual(['sources-disagree'])
  })

  it('prefers the channel’s dated list over a grid that matches none of its lists', async () => {
    const now = new Date('2026-11-17T09:00:00+02:00')
    const odd = JSON.parse(GRID_17)
    odd.data['1.1'].times['12:00'] = '1'
    const s = await setup({ now, graphs: JSON.stringify(odd), channel: CHANNEL_17 }).client.getSchedules(
      'kirovohrad',
    )
    expect(source(s, CHANNEL).dates).toEqual(['2026-11-17'])
    expect(source(s, SITE)).toMatchObject({ dates: [], updatedAt: null, disagrees: true })
  })

  it('lets a newer cancellation win over the grid', async () => {
    // 15.11 20:24 "ГПВ та ГОП скасовано"; the grid still shows the list of 17:49 (post 1817)
    const now = new Date('2026-11-15T20:30:00+02:00')
    const s = await setup({
      now,
      graphs: gridOf(v(1817)),
      channel: upTo(CHANNEL_17, 1818),
    }).client.getSchedules('kirovohrad')
    for (const g of s.groups)
      expect(s.schedules[g]).toEqual([{ date: '2026-11-15', status: 'no-outages', intervals: [] }])
    expect(s.updatedAt).toBe('2026-11-15T20:24:03+02:00')
    expect(source(s, SITE)).toMatchObject({
      dates: [],
      updatedAt: '2026-11-15T17:49:00+02:00',
      disagrees: true,
    })

    // 20:41 the list for 16.11, 20:50 a new order for the rest of 15.11
    const later = await setup({
      now: new Date('2026-11-15T21:00:00+02:00'),
      graphs: gridOf(v(1820)),
      channel: upTo(CHANNEL_17, 1820),
    }).client.getSchedules('kirovohrad')
    expect(later.schedules['4.1']!.map((d) => [d.date, d.status, d.intervals.length])).toEqual([
      // "Черга 4.1: 22-24" on the grid: the possible half hour before it, then the outage
      ['2026-11-15', 'scheduled', 2],
      ['2026-11-16', 'scheduled', 4],
    ])
    expect(source(later, SITE)).toMatchObject({
      dates: ['2026-11-15'],
      updatedAt: '2026-11-15T20:50:00+02:00',
    })
  })

  it('the day after "скасовано до окремого розпорядження": a blank grid is today, not yesterday', async () => {
    // 15.11 20:24 "ГПВ та ГОП скасовано до окремого розпорядження"; CONSTRUCTED: no order follows,
    // and on 16.11 the grid shows nobody switched off
    const channel = upTo(CHANNEL_17, 1818)
    const cancel = v(1818)
    const blank = gridOf(cancel)
    const grid = parseGrid(JSON.parse(blank).data)!
    const morning = new Date('2026-11-16T09:00:00+02:00')
    const known = versionsAt(channel, morning)
    expect(dateGrid(grid, known, morning)).toEqual({ date: '2026-11-16', publishedAt: cancel.at })
    // the order stands at any hour: no doubt after midnight either
    expect(dateGrid(grid, known, new Date('2026-11-16T00:10:00+02:00'))).toEqual({
      date: '2026-11-16',
      publishedAt: cancel.at,
    })

    const s = await setup({ now: morning, graphs: blank, channel }).client.getSchedules('kirovohrad')
    for (const g of s.groups)
      expect(s.schedules[g]).toEqual([{ date: '2026-11-16', status: 'scheduled', intervals: [] }])
    expect(s.updatedAt).toBe('2026-11-15T20:24:03+02:00')
    expect(source(s, SITE)).toMatchObject({ dates: ['2026-11-16'], updatedAt: '2026-11-15T20:24:03+02:00' })
    expect(assessFreshness(s, { now: morning })).toMatchObject({
      state: 'fresh',
      today: 'published',
      issues: [],
    })

    // a grid with outages under that order is not confirmed by it
    expect(dateGrid(parseGrid(JSON.parse(gridOf(v(1817))).data)!, known, morning)).toEqual({
      date: '2026-11-15',
      publishedAt: '2026-11-15T17:49:00+02:00',
    })
    // a cancellation of yesterday alone ("скасовано графік … станом на 20:00") says nothing about
    // today, and a blank grid isn't "yesterday's" by it: undated in the hour of doubt, then today's
    const dayOnly = [{ ...cancel, untilFurtherOrder: undefined }]
    expect(dateGrid(grid, dayOnly, new Date('2026-11-16T00:10:00+02:00'))).toBeNull()
    expect(dateGrid(grid, dayOnly, morning)).toEqual({ date: '2026-11-16', publishedAt: null })
    // a new order for today ends it: the blank grid is then behind the channel's list
    const order = { ...v(1826), date: '2026-11-16', at: '2026-11-16T08:00:00+02:00' }
    expect(dateGrid(grid, [...known, order], morning)).toEqual({ date: '2026-11-16', publishedAt: null })
  })

  it('reports an unreadable recent list as a failed channel and keeps the site', async () => {
    const now = new Date('2026-11-17T09:00:00+02:00')
    const broken = CHANNEL_17.replace(
      'Черга 6.2: 02-04, 06-08, 14-16, 18-20, 22-24',
      'Черга 6.2: уточнюється',
    )
    expect(broken).not.toBe(CHANNEL_17)
    const s = await setup({ now, graphs: GRID_17, channel: broken }).client.getSchedules('kirovohrad')
    expect(source(s, CHANNEL)).toMatchObject({
      ok: false,
      error: { code: 'parse', message: expect.stringMatching(/post 1828: unexpected hours/) },
    })
    expect(source(s, SITE)).toMatchObject({ ok: true, dates: ['2026-11-17'], updatedAt: null })
  })
})
