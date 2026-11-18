import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ImageInput, ImageProcessor, PostInput, TextProcessor } from '../../src/ai/types.js'
import { OutageClient } from '../../src/client.js'
import { assessFreshness } from '../../src/freshness.js'
import { compactImage } from '../../src/image/compact.js'
import { splitHouses, zakarpattiaProvider } from '../../src/providers/zakarpattia.js'
import { STANDARD_GROUPS } from '../../src/schedule.js'
import type { DaySchedule } from '../../src/types.js'
import {
  ev,
  expectUnpublished,
  fakeImage,
  fakeText,
  fixture,
  fixtureBytes,
  intervalsOf,
  mockFetch,
  type Route,
} from '../helpers.js'

const NOW = new Date('2026-11-05T23:30:00+02:00')
const API = 'https://api-outage-zakarpat-energy.inneti.net/api'

const option = (key: string, value: string) =>
  JSON.stringify({
    'hydra:member': [{ option_key: key, value, date: '2026-06-30T20:08:40+00:00' }],
    'hydra:totalItems': 1,
  })

const TG_OCTOBER = 'telegram-zakarpatenergyofficial-10845-10850.trimmed.html'
const TG_FEBRUARY = 'telegram-zakarpatenergyofficial-9691-9718.trimmed.html'
const TELEGRAM = 'telegram:@zakarpatenergyofficial'
const poster = (name: string) => fixtureBytes(`zakarpattia/posters/${name}`)
const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)
const LABELS = JSON.parse(fixture('zakarpattia/posters/labels.json')) as Record<
  string,
  { date: string; rows: string[][] }
>

/** The posts' captions: "графік погодинних включень/відключень … на 17.10.2026", picture attached */
const CAPTION_DATES: Record<string, string> = {
  '10845': '2026-10-17',
  '10848': '2026-10-17',
  '10850': '2026-10-17',
  '9691': '2026-02-07',
  '9692': '2026-02-07',
  '9695': '2026-02-07',
  '9718': '2026-02-09',
}
const captions = (): TextProcessor & { calls: PostInput[] } =>
  fakeText((input) => {
    const date = CAPTION_DATES[input.url.split('/').at(-1)!]
    return date
      ? {
          photosAreSchedules: true,
          events: [ev({ kind: 'gpv', action: 'start', regions: ['zakarpattia'], date })],
        }
      : undefined
  })

/** A picture as the image processor gets it, by its compacted bytes → the labelled poster */
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
let byDigest: Map<string, string> | null = null
const posterOf = (input: ImageInput) => {
  byDigest ??= new Map(
    Object.keys(LABELS)
      .filter((n) => !n.startsWith('_'))
      .map((n) => [digest(compactImage(poster(n), { maxLongEdge: 1100 }).bytes), n]),
  )
  return byDigest.get(digest(input.bytes))
}
/** What a model reads on each labelled poster; anything else isn't a schedule */
const pictures = (): ImageProcessor & { calls: ImageInput[] } =>
  fakeImage((input) => {
    const name = posterOf(input)
    if (!name) return undefined
    const { date, rows } = LABELS[name]!
    return {
      date,
      schedule: STANDARD_GROUPS.map((queue, i) => ({
        queue,
        intervals: intervalsOf(rows[i]!.map((r) => r.replace(/-00:00$/, '-24:00')).join(', ')),
      })),
    }
  })

interface Processors {
  text?: TextProcessor | null
  image?: ImageProcessor | null
}
const processors = (p: Processors) => ({
  textProcessor: p.text === null ? undefined : (p.text ?? captions()),
  imageProcessor: p.image === null ? undefined : (p.image ?? pictures()),
})

/** The channel as it stood on 17.10.2026 (three schedule posts) or 07–08.02.2026 (four) */
function channel(
  opts: { now: string; page?: string; today?: string; tomorrow?: string; routes?: Route[] } & Processors,
) {
  const { fetch, calls } = mockFetch([
    ...(opts.routes ?? []),
    { match: 't.me/s/zakarpatenergyofficial', body: fixture(`zakarpattia/${opts.page ?? TG_OCTOBER}`) },
    { match: 'file/WvcqaCJ2G2', body: poster('10845_2026-10-17T0900.jpg') },
    { match: 'file/WpmvXvc4pw', body: poster('10848_2026-10-17T0951.jpg') },
    { match: 'file/GGnm0DhyTx', body: poster('10850_2026-10-17T1319.jpg') },
    { match: 'file/CWErS8t1y2', body: poster('9691_2026-02-07T0505.jpg') },
    { match: 'file/YOlE6-eL5g', body: poster('9692_2026-02-07T0646.jpg') },
    { match: 'file/GlwgkrG_AA', body: poster('9695_2026-02-07T0857.jpg') },
    { match: 'file/Kn2JwOodUy', body: poster('9718_2026-02-08T2108.jpg') },
    {
      match: 'option_key=pw_gpv_image_today',
      body: option('pw_gpv_image_today', opts.today ?? ''),
    },
    {
      match: 'option_key=pw_gpv_image_tomorrow',
      body: option('pw_gpv_image_tomorrow', opts.tomorrow ?? ''),
    },
  ])
  const now = new Date(opts.now)
  const p = processors(opts)
  return {
    client: new OutageClient({
      fetch,
      now: () => now,
      cacheTtlMs: 0,
      providers: [zakarpattiaProvider()],
      ...p,
    }),
    calls,
    now,
    ...p,
  }
}

function client(
  queues = fixture('zakarpattia/pw_address_queues.city-769.street-9373.json'),
  todayImage = '',
  p: Processors = {},
) {
  const { fetch, calls } = mockFetch([
    // the channel's last schedule posts are of 17.10: nothing in the window
    { match: 't.me/s/zakarpatenergyofficial', body: fixture(`zakarpattia/${TG_OCTOBER}`) },
    { match: `${API}/options?option_key=pw_gpv_image_today`, body: option('pw_gpv_image_today', todayImage) },
    { match: `${API}/options?option_key=pw_gpv_image_tomorrow`, body: option('pw_gpv_image_tomorrow', '') },
    { match: `${API}/pw_cities?pagination=false`, body: fixture('zakarpattia/pw_cities.json') },
    {
      match: `${API}/pw_streets?pagination=false&city.id=769`,
      body: fixture('zakarpattia/pw_streets.city-769.json'),
    },
    { match: `${API}/pw_address_queues?pagination=false&city.id=769&street.id=9373`, body: queues },
  ])
  return {
    client: new OutageClient({
      fetch,
      now: () => NOW,
      cacheTtlMs: 0,
      providers: [zakarpattiaProvider()],
      ...processors(p),
    }),
    calls,
  }
}

describe('Zakarpattiaoblenergo', () => {
  it('lists its groups as unknown, not "no outages", while no schedule picture is published', async () => {
    const { client: c } = client()
    expect(c.region('zakarpattia').capabilities).toMatchObject({
      schedule: true,
      addressSearch: true,
      streetSearch: true,
    })
    const s = await c.getSchedules('zakarpattia')
    expectUnpublished(s, 12)
    const h = await c.healthCheck()
    expect(h.regions[0]!.status).toBe('empty')
  })

  it('finds the group of a house from the per-group house lists', async () => {
    const m = await client().client.findGroup('zakarpattia', {
      city: 'Ужгород',
      street: 'Корзо',
      house: '15',
    })
    expect(m).toEqual({
      region: 'zakarpattia',
      group: '4.2',
      address: { city: 'Ужгород', street: 'Корзо', house: '15' },
    })
  })

  it('returns every group a house is listed under', async () => {
    const m = await client().client.findGroup('zakarpattia', {
      city: 'Ужгород',
      street: 'вул. Корзо',
      house: '20',
    })
    expect(m.group).toBe('4.2')
    expect(m.otherGroups).toEqual(['6.2'])
  })

  it('matches whole house numbers, not substrings', async () => {
    // "5" appears inside "15" and "25"; it is listed only for 4.1
    const m = await client().client.findGroup('zakarpattia', { city: 'Ужгород', street: 'Корзо', house: '5' })
    expect(m).toMatchObject({ group: '4.1' })
    expect(m.otherGroups).toBeUndefined()
    await expect(
      client().client.findGroup('zakarpattia', { city: 'Ужгород', street: 'Корзо', house: '3' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'not-found' }))
  })

  it('splits house lists, keeping commas inside parentheses', () => {
    expect(splitHouses(', 10, 17(2поверх,приміщення №2), 22/2, 24 б, б/н')).toEqual([
      '10',
      '17(2поверх,приміщення №2)',
      '22/2',
      '24 б',
      'б/н',
    ])
  })

  it('rejects a changed response format', async () => {
    await expect(
      client('{"rows": []}').client.findGroup('zakarpattia', {
        city: 'Ужгород',
        street: 'Корзо',
        house: '15',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'parse' }))
  })

  it('drops the nameless settlement and names the hromada', async () => {
    const cities = await client().client.searchCities('zakarpattia', 'Ужгород')
    expect(cities).toEqual([{ id: '769', name: 'Ужгород', district: 'Ужгородська громада', score: 1 }])
  })
})

describe('Zakarpattiaoblenergo schedule', () => {
  it("reads the channel's newest picture for today; the post time is updatedAt", async () => {
    const { client: c, calls, now } = channel({ now: '2026-10-17T14:30:00+03:00' })
    const s = await c.getSchedules('zakarpattia')
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-10-17'])
    // the third version of the day (14:19), not the first two
    expect(s.groups.map((g) => hhmm(s.schedules[g]![0]!))).toEqual(LABELS['10850_2026-10-17T1319.jpg']!.rows)
    expect(s.updatedAt).toBe('2026-10-17T14:19:19+03:00')
    expect(s.sources).toEqual([
      {
        id: TELEGRAM,
        // the newest post that shaped the day
        url: 'https://t.me/zakarpatenergyofficial/10850',
        ok: true,
        dates: ['2026-10-17'],
        updatedAt: '2026-10-17T14:19:19+03:00',
      },
      {
        id: 'api',
        url: 'https://zakarpat.energy/customers/break-in-electricity-supply/schedule/',
        ok: true,
        dates: [],
        updatedAt: null,
      },
    ])
    // every version of the day is read: a re-issued picture counts from its post time on
    expect(calls.filter((c) => c.url.includes('telesco.pe'))).toHaveLength(3)
    expect(assessFreshness(s, { now })).toMatchObject({ state: 'fresh', today: 'published' })
  })

  it("has tomorrow from the evening before, and not yesterday's picture as today", async () => {
    // 08.02 at 21:30: three posts for 07.02 and, since 21:08, the one for 09.02
    const { client: c, calls } = channel({ now: '2026-02-08T21:30:00+02:00', page: TG_FEBRUARY })
    const s = await c.getSchedules('zakarpattia')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-02-09'])
    expect(s.groups.map((g) => hhmm(s.schedules[g]![0]!))).toEqual(LABELS['9718_2026-02-08T2108.jpg']!.rows)
    expect(s.updatedAt).toBe('2026-02-08T21:08:00+02:00')
    // the three of 07.02 are read too (the window starts yesterday), and dropped as past
    expect(calls.filter((c) => c.url.includes('telesco.pe'))).toHaveLength(4)
  })

  it('never presents a post for a past date as today', async () => {
    // half past midnight on 18.10: the posts of 17.10 are in the window, and are for 17.10
    const { client: c, calls } = channel({ now: '2026-10-18T00:30:00+03:00' })
    const s = await c.getSchedules('zakarpattia')
    expectUnpublished(s, 12)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-10-18'])
    expect(s.updatedAt).toBeNull()
    expect(s.sources!.map((x) => [x.id, x.ok, x.dates])).toEqual([
      [TELEGRAM, true, []],
      ['api', true, []],
    ])
    // yesterday's posts are read (the window starts there), their day dropped
    expect(calls.filter((c) => c.url.includes('telesco.pe'))).toHaveLength(3)
  })

  it("reads the API picture for a day the channel names; the channel's dated reading wins", async () => {
    const { client: c } = channel({
      now: '2026-10-17T14:30:00+03:00',
      today: '/media/gpv-today.png',
      // the API still serves the second version
      routes: [{ match: '/media/gpv-today.png', body: poster('10848_2026-10-17T0951.jpg') }],
    })
    const s = await c.getSchedules('zakarpattia')
    expect(s.groups.map((g) => hhmm(s.schedules[g]![0]!))).toEqual(LABELS['10850_2026-10-17T1319.jpg']!.rows)
    expect(s.sources![0]).toMatchObject({ id: TELEGRAM, ok: true, dates: ['2026-10-17'] })
    expect(s.sources![1]).toMatchObject({ id: 'api', ok: true, dates: [], updatedAt: null, disagrees: true })
  })

  it('agrees silently when both carry the same picture', async () => {
    const { client: c } = channel({
      now: '2026-10-17T14:30:00+03:00',
      today: '/media/gpv-today.png',
      routes: [{ match: '/media/gpv-today.png', body: poster('10850_2026-10-17T1319.jpg') }],
    })
    const s = await c.getSchedules('zakarpattia')
    expect(s.sources![1]).toMatchObject({ id: 'api', ok: true })
    expect(s.sources![1]!.disagrees).toBeUndefined()
  })

  it('does not date an API picture by itself: without a post for the day the source fails', async () => {
    const { client: c } = channel({
      now: '2026-10-18T09:00:00+03:00',
      // left over from 17.10, or new for 18.10: nothing says
      today: '/media/gpv-today.png',
      routes: [{ match: '/media/gpv-today.png', body: poster('10850_2026-10-17T1319.jpg') }],
    })
    const s = await c.getSchedules('zakarpattia')
    expectUnpublished(s, 12)
    expect(s.sources![0]).toMatchObject({ id: TELEGRAM, ok: true, dates: [] })
    expect(s.sources![1]).toMatchObject({
      id: 'api',
      ok: false,
      error: {
        code: 'unsupported',
        message: expect.stringContaining('https://api-outage-zakarpat-energy.inneti.net/media/gpv-today.png'),
      },
    })
  })

  it('keeps the channel when the API is down, and says so', async () => {
    const { client: c } = channel({
      now: '2026-10-17T14:30:00+03:00',
      routes: [{ match: 'option_key=', body: 'Bad gateway', status: 502 }],
    })
    const s = await c.getSchedules('zakarpattia')
    expect(hhmm(s.schedules['2.1']![0]!)).toEqual(['14:00-17:00'])
    expect(s.sources![1]).toMatchObject({ id: 'api', ok: false })
  })

  it('lists the groups as unknown when the channel is down and the API has no picture', async () => {
    const { client: c } = channel({
      now: '2026-10-17T14:30:00+03:00',
      routes: [{ match: 't.me/s/', body: 'Too many requests', status: 429 }],
    })
    const s = await c.getSchedules('zakarpattia')
    expectUnpublished(s, 12)
    expect(s.sources![0]).toMatchObject({ id: TELEGRAM, ok: false })
    expect(s.sources![1]).toMatchObject({ id: 'api', ok: true, dates: [] })
  })

  it('fails when both are down, and when the channel is down with an undatable API picture', async () => {
    const down = channel({
      now: '2026-10-17T14:30:00+03:00',
      routes: [
        { match: 't.me/s/', body: 'Too many requests', status: 429 },
        { match: 'option_key=', body: 'Bad gateway', status: 502 },
      ],
    })
    await expect(down.client.getSchedules('zakarpattia')).rejects.toMatchObject({
      code: expect.stringMatching(/network|blocked|rate/),
    })
    const undated = channel({
      now: '2026-10-17T14:30:00+03:00',
      today: '/media/gpv-today.png',
      routes: [{ match: 't.me/s/', body: 'Too many requests', status: 429 }],
    })
    await expect(undated.client.getSchedules('zakarpattia')).rejects.toThrow()
  })

  it("the channel's newest picture can't be read: the version before it stands, flagged", async () => {
    const { client: c } = channel({
      now: '2026-10-17T14:30:00+03:00',
      today: '/media/gpv-today.png',
      routes: [
        // the 14:19 post now carries something else; the API still serves the version before it
        { match: 'file/GGnm0DhyTx', body: fixtureBytes('chernihiv/posters/tg-5631.jpg') },
        { match: '/media/gpv-today.png', body: poster('10848_2026-10-17T0951.jpg') },
      ],
    })
    // the older version stands, flagged: the 14:19 post is read again on the next poll
    const s = await c.getSchedules('zakarpattia')
    expect(s.groups.map((g) => hhmm(s.schedules[g]![0]!))).toEqual(LABELS['10848_2026-10-17T0951.jpg']!.rows)
    expect(s.sources![0]!.unread).toEqual([
      { date: '2026-10-17', message: expect.stringMatching(/announces a schedule picture/) },
    ])
  })

  it("a newest picture that can't be read: the version before it, flagged", async () => {
    const { client: c } = channel({
      now: '2026-10-17T14:30:00+03:00',
      // the 14:19 post now carries something else
      routes: [{ match: 'file/GGnm0DhyTx', body: fixtureBytes('chernihiv/posters/tg-5631.jpg') }],
    })
    const s = await c.getSchedules('zakarpattia')
    expect(s.groups.map((g) => hhmm(s.schedules[g]![0]!))).toEqual(LABELS['10848_2026-10-17T0951.jpg']!.rows)
    expect(s.sources![0]).toMatchObject({
      id: TELEGRAM,
      ok: true,
      unread: [{ date: '2026-10-17', message: expect.stringMatching(/announces a schedule picture/) }],
    })
  })

  it('an unreadable re-issue, then a later re-issue of the same day: the day as read, flagged', async () => {
    const { client: c } = channel({
      now: '2026-10-17T14:30:00+03:00',
      // the 10:51 post now carries something else; the 14:19 one reads, from 14:19 on
      routes: [{ match: 'file/WpmvXvc4pw', body: fixtureBytes('chernihiv/posters/tg-5631.jpg') }],
    })
    const s = await c.getSchedules('zakarpattia')
    expect(s.sources![0]).toMatchObject({ id: TELEGRAM, ok: true, unread: [{ date: '2026-10-17' }] })
    expect(s.schedules['1.1']![0]!.status).not.toBe('unknown')
  })

  it('sends the captions to the text processor and the pictures, with them, to the image processor', async () => {
    const { client: c, textProcessor, imageProcessor } = channel({ now: '2026-10-17T14:30:00+03:00' })
    await c.getSchedules('zakarpattia')
    const text = textProcessor as ReturnType<typeof captions>
    const image = imageProcessor as ReturnType<typeof pictures>
    expect(text.calls.map((x) => x.url)).toEqual([
      'https://t.me/zakarpatenergyofficial/10845',
      'https://t.me/zakarpatenergyofficial/10848',
      'https://t.me/zakarpatenergyofficial/10850',
    ])
    expect(text.calls[0]!.photoCount).toBe(1)
    expect(image.calls.map((x) => [x.url, x.caption?.slice(0, 20)])).toEqual(
      text.calls.map((x) => [x.url, x.text.slice(0, 20)]),
    )
  })

  it('a picture and its caption naming different days: the day is not known', async () => {
    // the caption of 10850 says 18.10; its picture is of 17.10
    const text = fakeText((input) =>
      input.url.endsWith('/10850')
        ? {
            photosAreSchedules: true,
            events: [ev({ kind: 'gpv', action: 'start', regions: ['zakarpattia'], date: '2026-10-18' })],
          }
        : {
            photosAreSchedules: true,
            events: [ev({ kind: 'gpv', action: 'start', regions: ['zakarpattia'], date: '2026-10-17' })],
          },
    )
    const s = await channel({ now: '2026-10-17T14:30:00+03:00', text }).client.getSchedules('zakarpattia')
    expect(s.sources![0]!.unread![0]!.message).toMatch(
      /the picture reads 2026-10-17, its post says 2026-10-18/,
    )
  })

  it("a newest caption that can't be read: the version before it, flagged", async () => {
    const text = fakeText((input) =>
      input.url.endsWith('/10850')
        ? [ev({ kind: 'gpv', action: 'start', regions: ['zakarpattia'], date: '2026-13-01' })]
        : {
            photosAreSchedules: true,
            events: [ev({ kind: 'gpv', action: 'start', regions: ['zakarpattia'], date: '2026-10-17' })],
          },
    )
    const s = await channel({ now: '2026-10-17T14:30:00+03:00', text }).client.getSchedules('zakarpattia')
    expect(s.groups.map((g) => hhmm(s.schedules[g]![0]!))).toEqual(LABELS['10848_2026-10-17T0951.jpg']!.rows)
    // the days it may be about, its own and the next
    expect(s.sources![0]!.unread!.map((u) => u.date)).toEqual(['2026-10-17', '2026-10-18'])
  })

  it('needs both processors for the schedule; the address search needs neither', async () => {
    // the API's picture is dated by the channel's captions: without either processor, nothing
    for (const p of [{ text: null }, { image: null }] as Processors[])
      await expect(
        channel({ now: '2026-10-17T14:30:00+03:00', ...p }).client.getSchedules('zakarpattia'),
      ).rejects.toMatchObject({ code: 'config' })
    const m = await client(undefined, '', { text: null, image: null }).client.findGroup('zakarpattia', {
      city: 'Ужгород',
      street: 'Корзо',
      house: '15',
    })
    expect(m.group).toBe('4.2')
  })

  it('answers `config` without processors, not "nothing published"', async () => {
    await expect(
      channel({ now: '2026-10-17T14:30:00+03:00', text: null, image: null }).client.getSchedules(
        'zakarpattia',
      ),
    ).rejects.toMatchObject({ code: 'config' })
  })
})
