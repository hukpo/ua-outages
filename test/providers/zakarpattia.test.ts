import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { readFileSync } from 'node:fs'
import { assessFreshness } from '../../src/freshness.js'
import { decodeJpeg } from '../../src/image/jpeg.js'
import { decodePng } from '../../src/image/png.js'
import { readQueueColourTable } from '../../src/image/queue-table.js'
import {
  readZakarpattiaPicture,
  schedulePostDate,
  splitHouses,
  zakarpattiaProvider,
} from '../../src/providers/zakarpattia.js'
import type { DaySchedule } from '../../src/types.js'
import { expectUnpublished, fixture, fixtureBytes, mockFetch, type Route } from '../helpers.js'

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

/** The channel as it stood on 17.10.2026 (three schedule posts) or 07–08.02.2026 (four) */
function channel(opts: { now: string; page?: string; today?: string; tomorrow?: string; routes?: Route[] }) {
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
  return {
    client: new OutageClient({ fetch, now: () => now, cacheTtlMs: 0, providers: [zakarpattiaProvider()] }),
    calls,
    now,
  }
}

function client(
  queues = fixture('zakarpattia/pw_address_queues.city-769.street-9373.json'),
  todayImage = '',
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
    client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [zakarpattiaProvider()] }),
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

describe('Zakarpattiaoblenergo schedule picture', () => {
  it('reads all eight hand-labelled pictures exactly', () => {
    const names = Object.keys(LABELS).filter((n) => !n.startsWith('_'))
    expect(names).toHaveLength(8)
    for (const name of names) {
      const { date, rows } = LABELS[name]!
      const day = readZakarpattiaPicture(poster(name), date)
      expect(Object.keys(day), name).toHaveLength(12)
      expect(
        Object.values(day).map((d) => hhmm(d)),
        name,
      ).toEqual(rows)
    }
  })

  it('refuses pictures that are not this table', () => {
    const others = [
      decodePng(fixtureBytes('volyn/gpv-2026-10-17-1847.png')),
      decodePng(fixtureBytes('khmelnytskyi/announcement-2026-10-17-1658.png')),
      decodeJpeg(fixtureBytes('chernihiv/posters/tg-5631.jpg')),
    ]
    for (const img of others) expect(() => readQueueColourTable(img)).toThrow()
    expect(() => readZakarpattiaPicture(fixtureBytes('volyn/gpv-2026-10-17-1847.png'), '2026-10-17')).toThrow(
      expect.objectContaining({ code: 'parse' }),
    )
  })

  it('refuses a cell that is neither white nor its row colour, and a table with a row missing', () => {
    const paint = (
      box: { x0: number; x1: number; y0: number; y1: number },
      rgb: [number, number, number],
    ) => {
      const img = decodeJpeg(poster('10845_2026-10-17T0900.jpg'))
      const data = new Uint8Array(img.data)
      for (let y = box.y0; y <= box.y1; y++)
        for (let x = box.x0; x <= box.x1; x++) data.set(rgb, (y * img.width + x) * 4)
      return { ...img, data }
    }
    // untouched, it reads
    expect(readQueueColourTable(decodeJpeg(poster('10845_2026-10-17T0900.jpg')))).toHaveLength(12)
    // 1-1 at 03:00, grey: a colour the table doesn't use
    expect(() => readQueueColourTable(paint({ x0: 171, x1: 183, y0: 51, y1: 60 }, [150, 150, 150]))).toThrow(
      /neither white nor/,
    )
    // the same cell in queue 2's green: not this row's colour
    expect(() => readQueueColourTable(paint({ x0: 171, x1: 183, y0: 51, y1: 60 }, [147, 208, 81]))).toThrow(
      /neither white nor/,
    )
    // half of the cell filled
    expect(() => readQueueColourTable(paint({ x0: 171, x1: 176, y0: 51, y1: 60 }, [255, 255, 0]))).toThrow(
      /neither white nor/,
    )
    // the label of row 6-2 wiped: eleven rows
    expect(() => readQueueColourTable(paint({ x0: 0, x1: 76, y0: 193, y1: 206 }, [255, 255, 255]))).toThrow(
      /sub-queue cells/,
    )
  })

  it('takes the date of a post from its caption', () => {
    expect(
      schedulePostDate(
        'До уваги споживачів графік погодинних включень/відключень електроенергії на 17.10.2026',
      ),
    ).toBe('2026-10-17')
    expect(
      schedulePostDate(
        'Увага! Змінено графік погодинних включень/відключень електроенергії ГПВ на 09.02.2026 згідно з розпорядженням НЕК «Укренерго».',
      ),
    ).toBe('2026-02-09')
    expect(schedulePostDate('графік погодинних включень/відключень електроенергії на 31.02.2026')).toBeNull()
    expect(
      schedulePostDate('Укренерго про ситуацію в енергосистемі України на сьогодні, 16 жовтня'),
    ).toBeNull()
    expect(
      schedulePostDate(
        'У низці регіонів України повернулися графіки відключень світла. Станом на 08.10.2026',
      ),
    ).toBeNull()
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
        url: 'https://t.me/s/zakarpatenergyofficial',
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
    expect(calls.filter((c) => c.url.includes('telesco.pe'))).toHaveLength(1)
    expect(assessFreshness(s, { now })).toMatchObject({ state: 'fresh', today: 'published' })
  })

  it("has tomorrow from the evening before, and not yesterday's picture as today", async () => {
    // 08.02 at 21:30: three posts for 07.02 and, since 21:08, the one for 09.02
    const { client: c, calls } = channel({ now: '2026-02-08T21:30:00+02:00', page: TG_FEBRUARY })
    const s = await c.getSchedules('zakarpattia')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-02-09'])
    expect(s.groups.map((g) => hhmm(s.schedules[g]![0]!))).toEqual(LABELS['9718_2026-02-08T2108.jpg']!.rows)
    expect(s.updatedAt).toBe('2026-02-08T21:08:00+02:00')
    expect(calls.filter((c) => c.url.includes('telesco.pe'))).toHaveLength(1)
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
    expect(calls.filter((c) => c.url.includes('telesco.pe'))).toHaveLength(0)
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

  it("doesn't show the API picture as the day when the channel's newest picture for it can't be read", async () => {
    const { client: c } = channel({
      now: '2026-10-17T14:30:00+03:00',
      today: '/media/gpv-today.png',
      routes: [
        // the 14:19 post now carries something else; the API still serves the version before it
        { match: 'file/GGnm0DhyTx', body: fixtureBytes('chernihiv/posters/tg-5631.jpg') },
        { match: '/media/gpv-today.png', body: poster('10848_2026-10-17T0951.jpg') },
      ],
    })
    // before: the API's older version stood as today. Now neither channel has the day
    await expect(c.getSchedules('zakarpattia')).rejects.toMatchObject({
      code: 'parse',
      message: expect.stringContaining('2026-10-17'),
    })
  })

  it("fails the channel when its newest picture can't be read, not falling back to an older one", async () => {
    const { client: c } = channel({
      now: '2026-10-17T14:30:00+03:00',
      // the 14:19 post now carries something else
      routes: [{ match: 'file/GGnm0DhyTx', body: fixtureBytes('chernihiv/posters/tg-5631.jpg') }],
    })
    const s = await c.getSchedules('zakarpattia')
    expectUnpublished(s, 12)
    expect(s.sources![0]).toMatchObject({
      id: TELEGRAM,
      ok: false,
      error: { code: 'parse', message: expect.stringContaining('2026-10-17') },
    })
  })
})
