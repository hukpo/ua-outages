import { beforeAll, describe, expect, it } from 'vitest'
import { AiRuntime } from '../../src/ai/runtime.js'
import type { PostAnalysis, PostInput, TextProcessor } from '../../src/ai/types.js'
import { OutageClient } from '../../src/client.js'
import { parseTelegramPreview, type TelegramPost } from '../../src/emergency/telegram.js'
import { assessFreshness } from '../../src/freshness.js'
import { Http } from '../../src/http.js'
import { dateGrid, gridToSource, kirovohradProvider, parseGrid } from '../../src/providers/kirovohrad.js'
import {
  gpvVersions,
  gpvVersionsToSource,
  standingVersions,
  type GpvVersion,
} from '../../src/providers/kirovohrad-telegram.js'
import type { RegionSchedule } from '../../src/types.js'
import { ev, expectUnpublished, fakeText, fixture, mockFetch } from '../helpers.js'

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
const DISTRICT = fixture('kirovohrad/telegram-SvitloHolovanivskohoRayonu-1791-1793.trimmed.html')

/** The posts of a saved preview page up to `last` (the channel as it was at that moment) */
function upTo(page: string, last: number): string {
  const [head, ...blocks] = page.split(/(?=<div class="tgme_widget_message_wrap\b)/)
  return head + blocks.filter((b) => Number(/data-post="[^"/]+\/(\d+)"/.exec(b)![1]) <= last).join('')
}
const posts = (page: string): TelegramPost[] => parseTelegramPreview(page)

// --- what a model reads in the dispatcher's posts ---

/**
 * "Черга 1.1: 08-10, 16-18" lines → the schedule as the model gives it ("20-21:30" → 20:00–21:30);
 * a group whose hours it can't give ("уточнюється") is listed without them
 */
function lines(text: string) {
  const hhmm = (t: string) => (t.includes(':') ? t.padStart(5, '0') : `${t.padStart(2, '0')}:00`)
  return [...text.matchAll(/^Черга (\d\.\d): (.*)$/gm)].map(([, queue, hours]) => {
    const ranges = [...hours!.matchAll(/(\d{1,2}(?::\d{2})?)-(\d{1,2}(?::\d{2})?)/g)]
    return {
      queue: queue!,
      intervals: ranges.length
        ? ranges.map(([, f, t]) => ({ from: hhmm(f!), to: hhmm(t!), kind: 'off' as const }))
        : null,
    }
  })
}
const list = (date: string, statedAt: string | null = null) => ({ date, statedAt })
/** Per post: the day its list is for and its "станом на"; or another answer */
const HEADS: Record<string, ReturnType<typeof list> | Partial<PostAnalysis>> = {
  // a forecast: "ГПВ згідно з заданими обсягами" for 05.11, hours to come
  1747: { events: [ev({ kind: 'gpv', action: 'start', regions: ['kirovohrad'], date: '2026-11-05' })] },
  1750: list('2026-11-05'),
  // "Зміни на 08:56 05.11.2026 до графіка погодинних відключень"
  1752: list('2026-11-05', '08:56'),
  1753: list('2026-11-05', '09:55'),
  1754: list('2026-11-05', '13:35'),
  1755: list('2026-11-05', '21:27'),
  1813: list('2026-11-15'),
  1814: list('2026-11-15', '07:41'),
  1815: list('2026-11-15', '08:29'),
  1816: list('2026-11-15', '15:45'),
  1817: list('2026-11-15', '17:49'),
  // "15.11.2026 за наказом НЕК "Укренерго" ГПВ та ГОП скасовано до окремого розпорядження."
  1818: {
    events: [
      ev({
        kind: 'gpv',
        action: 'cancel',
        regions: ['kirovohrad'],
        date: '2026-11-15',
        untilFurtherNotice: true,
      }),
    ],
  },
  1819: list('2026-11-16'),
  1820: list('2026-11-15', '20:50'),
  1821: list('2026-11-15', '22:41'),
  1822: list('2026-11-16', '01:36'),
  // "16.11.26 в 16:27 застосовано СГАВ"
  1823: { events: [ev({ kind: 'sgav', action: 'start', regions: ['kirovohrad'], at: '16:27' })] },
  1824: list('2026-11-16', '17:46'),
  1825: { events: [ev({ kind: 'sgav', action: 'cancel', regions: ['kirovohrad'], at: '19:00' })] },
  1826: list('2026-11-16', '19:49'),
  1827: list('2026-11-17'),
  1828: list('2026-11-17', '23:56'),
  // the district channel: the list of 17:49, the emptied list "станом на 20:00", the order of 20:23
  'SvitloHolovanivskohoRayonu/1791': list('2026-11-15', '17:49'),
  'SvitloHolovanivskohoRayonu/1792': {
    statedAt: '20:00',
    events: [ev({ kind: 'gpv', action: 'cancel', regions: ['kirovohrad'], date: '2026-11-15' })],
  },
  'SvitloHolovanivskohoRayonu/1793': {
    events: [
      ev({
        kind: 'gpv',
        action: 'cancel',
        regions: ['kirovohrad'],
        date: '2026-11-15',
        untilFurtherNotice: true,
      }),
    ],
  },
}
function kiroAnswer(input: PostInput): Partial<PostAnalysis> | undefined {
  const [channel, id] = input.url.split('/').slice(-2) as [string, string]
  const head = HEADS[channel === 'SvitloKropyvnytskyiMisto' ? id : `${channel}/${id}`]
  if (!head || !('date' in head)) return head as Partial<PostAnalysis> | undefined
  return {
    statedAt: head.statedAt,
    events: [
      ev({
        kind: 'gpv',
        action: 'start',
        regions: ['kirovohrad'],
        date: head.date,
        schedule: lines(input.text),
      }),
    ],
  }
}
const kiroText = () => fakeText(kiroAnswer)
/** `gpvVersions` as the provider runs it, at `now`: the channel */
const channelAt = (page: string, now: Date, text: TextProcessor = kiroText()) =>
  gpvVersions(
    {
      http: new Http({ fetch: mockFetch([]).fetch }),
      now: () => now,
      ai: new AiRuntime({ textProcessor: text }),
    },
    posts(page),
  )
const version = async (page: string, id: number, now: Date) =>
  (await versionsAt(page, now)).find((v) => v.url.endsWith(`/${id}`))!
/** …its versions */
const versionsAt = async (page: string, now: Date, text: TextProcessor = kiroText()) =>
  (await channelAt(page, now, text)).versions
const asChannel = (versions: GpvVersion[]) => ({ versions, unread: new Map() })

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
    /** null = no text processor */
    text?: TextProcessor | null
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
  const textProcessor = opts.text === null ? undefined : (opts.text ?? kiroText())
  return {
    client: new OutageClient({
      fetch,
      now: () => now,
      cacheTtlMs: 0,
      retries: 0,
      providers: [provider],
      textProcessor,
    }),
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
      textProcessor: kiroText(),
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

  it('takes each list with its "станом на" time; СГАВ notices give none', async () => {
    const all = await versionsAt(CHANNEL_17, NIGHT)
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
    expect((await version(CHANNEL_17, 1822, NIGHT)).slots['2.1']![0]).toEqual({
      start: 0,
      end: 90,
      kind: 'off',
    })
  })

  it('gives a group missing from a list a day without outages', async () => {
    // 1816 (15.11 15:45) lists 2.1–6.2 only
    const days = gpvVersionsToSource(
      await channelAt(upTo(CHANNEL_17, 1816), NIGHT),
      new Date('2026-11-15T16:00:00+02:00'),
    ).days
    const day = days['2026-11-15']!
    expect(day.publishedAt).toBe('2026-11-15T15:45:00+02:00')
    expect(day.schedules['1.1']).toEqual({ date: '2026-11-15', status: 'scheduled', intervals: [] })
    expect(day.schedules['4.2']!.intervals.map((i) => i.from.slice(11, 16))).toEqual(['18:00', '22:00'])
    expect(Object.keys(day.schedules)).toHaveLength(12)
  })

  it('takes a list called a change as the whole day too, and skips a forecast without hours', async () => {
    const asChange = fakeText((input) => {
      const a = kiroAnswer(input)
      return a?.events?.length
        ? { ...a, events: a.events.map((e) => (e.schedule.length ? { ...e, action: 'change' as const } : e)) }
        : a
    })
    const all = await versionsAt(CHANNEL_05, NOW, asChange)
    expect(all.map((v) => [v.url.split('/').pop(), v.date, v.at])).toEqual([
      ['1750', '2026-11-05', '2026-11-04T21:32:02+02:00'],
      // "Зміни на 08:56 05.11.2026 до графіка погодинних відключень"
      ['1752', '2026-11-05', '2026-11-05T08:56:00+02:00'],
      ['1753', '2026-11-05', '2026-11-05T09:55:00+02:00'],
      ['1754', '2026-11-05', '2026-11-05T13:35:00+02:00'],
      ['1755', '2026-11-05', '2026-11-05T21:27:00+02:00'],
    ])
    // 1753 drops 1.1's 10-12 of 1752: the whole list stands, not 1752 plus 1753
    expect(
      gpvVersionsToSource(asChannel(all), NOW).days['2026-11-05']!.schedules['1.1']!.intervals,
    ).toHaveLength(4)
  })

  it('reads both cancellations; "до окремого розпорядження" also withdraws a list for tomorrow', async () => {
    const cancel = await version(CHANNEL_17, 1818, NIGHT)
    expect(cancel).toMatchObject({
      date: '2026-11-15',
      cancelled: true,
      untilFurtherOrder: true,
      at: '2026-11-15T20:24:03+02:00',
    })
    // a district channel also has the emptied list: "… скасовано графік погодинних відключень (ГПВ) станом на 20:00 15.11.2026:"
    const district = await versionsAt(DISTRICT, NIGHT)
    expect(district.map((v) => [v.cancelled, v.untilFurtherOrder ?? false, v.at])).toEqual([
      [false, false, '2026-11-15T17:49:00+02:00'],
      [true, false, '2026-11-15T20:00:00+02:00'],
      [true, true, '2026-11-15T20:23:17+02:00'],
    ])

    const day = (date: string, at: string): GpvVersion => ({
      date,
      at,
      postedAt: at,
      url: 'https://t.me/x/1',
      cancelled: false,
      slots: { '1.1': [{ start: 0, end: 60, kind: 'off' }] },
    })
    const early = day('2026-11-16', '2026-11-15T20:10:00+02:00')
    const late = day('2026-11-16', '2026-11-15T20:41:54+02:00')
    expect([...standingVersions([early, cancel]).keys()]).toEqual(['2026-11-15'])
    expect(standingVersions([early, cancel, late]).get('2026-11-16')).toBe(late)
  })

  it('flags the day of a recent list it cannot use exactly (read again on the next poll), and ignores an old one', async () => {
    const post = (at: string) =>
      `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="SvitloKropyvnytskyiMisto/1">` +
      `<div class="tgme_widget_message_text js-message_text" dir="auto">17.11.2026 за розпорядженням НЕК "Укренерго" буде діяти наступний графік</div>` +
      `<a class="tgme_widget_message_date" href="https://t.me/SvitloKropyvnytskyiMisto/1"><time datetime="${at}" class="time">00:00</time></a></div></div>`
    const recent = post('2026-11-16T21:35:26+00:00')
    const answer = (a: Partial<PostAnalysis>) => fakeText(() => a)
    const gpv = (e: Partial<Parameters<typeof ev>[0]>) =>
      ev({ kind: 'gpv', action: 'start', regions: ['kirovohrad'], date: '2026-11-17', ...e })
    const bad: [string, Partial<PostAnalysis>][] = [
      // a time that doesn't exist, a group the region doesn't have: the answer fails validation
      [
        '25:00',
        {
          events: [
            gpv({ schedule: [{ queue: '1.1', intervals: [{ from: '25:00', to: '26:00', kind: 'off' }] }] }),
          ],
        },
      ],
      ['7.1', { events: [gpv({ schedule: [{ queue: '7.1', intervals: [] }] })] }],
      // a group named without hours ("уточнюється")
      ['no hours', { events: [gpv({ schedule: [{ queue: '1.1', intervals: null }] })] }],
      // a list for part of the day: a reader of whole lists can't apply it
      [
        'window',
        { events: [gpv({ at: '16:00', until: '18:00', schedule: [{ queue: '1.1', intervals: [] }] })] },
      ],
    ]
    for (const [what, a] of bad) {
      const c = await channelAt(recent, NIGHT, answer(a))
      expect(c.versions, what).toEqual([])
      expect([...c.unread.keys()], what).toContain('2026-11-17')
    }
    // a list for a day already past: nothing to flag
    const past = await channelAt(
      recent,
      NIGHT,
      answer({ events: [gpv({ date: '2026-11-15', schedule: [{ queue: '1.1', intervals: [] }] })] }),
    )
    expect([past.versions, [...past.unread.keys()]]).toEqual([[], []])
    // posted before yesterday: it can't matter any more (15.11 is that post's next day, and fits)
    const old = post('2026-11-14T21:35:26+00:00')
    for (const [what, a] of bad.slice(0, 3)) expect(await versionsAt(old, NIGHT, answer(a)), what).toEqual([])
  })
})

describe('Kirovohradoblenergo: site and channel merged', () => {
  let all17: GpvVersion[]
  const v = (id: number) => all17.find((x) => x.url.endsWith(`/${id}`))!
  beforeAll(async () => {
    all17 = await versionsAt(CHANNEL_17, new Date('2026-11-17T00:45:00+02:00'))
  })

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
    const known = await versionsAt(channel, morning)
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

  it('flags the day of an unusable recent list on the channel; the site stands, undated', async () => {
    const now = new Date('2026-11-17T09:00:00+02:00')
    const broken = CHANNEL_17.replace(
      'Черга 6.2: 02-04, 06-08, 14-16, 18-20, 22-24',
      'Черга 6.2: уточнюється',
    )
    expect(broken).not.toBe(CHANNEL_17)
    const s = await setup({ now, graphs: GRID_17, channel: broken }).client.getSchedules('kirovohrad')
    expect(source(s, CHANNEL)).toMatchObject({
      ok: true,
      unread: [
        { date: '2026-11-17', message: expect.stringMatching(/1828: a group is listed without hours/) },
      ],
    })
    expect(source(s, SITE)).toMatchObject({ ok: true, dates: ['2026-11-17'], updatedAt: null })
  })

  it('serves the site without a change time when there is no text processor', async () => {
    const now = new Date('2026-11-17T09:00:00+02:00')
    const s = await setup({ now, graphs: GRID_17, channel: CHANNEL_17, text: null }).client.getSchedules(
      'kirovohrad',
    )
    expect(spans(s, '1.1')[0]).toBe('00:00–02:00 off')
    expect(s.updatedAt).toBeNull()
    expect(source(s, SITE)).toMatchObject({ ok: true, dates: ['2026-11-17'], updatedAt: null })
    expect(source(s, CHANNEL)).toMatchObject({ ok: false, error: { code: 'config' } })
  })
})
