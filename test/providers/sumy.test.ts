import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { OutageError } from '../../src/errors.js'
import { assessFreshness } from '../../src/freshness.js'
import {
  decryptSumyResponse,
  parseCabinetAnswer,
  parseSumySchedules,
  sumyProvider,
} from '../../src/providers/sumy.js'
import type { DaySchedule } from '../../src/types.js'
import type { ImageProcessor, TextProcessor } from '../../src/ai/types.js'
import {
  ev,
  expectUnpublished,
  fakeImage,
  fakeText,
  fixture,
  fixtureBytes,
  pictureSchedule,
  mockFetch,
  type Route,
} from '../helpers.js'
import { previewPage } from '../emergency/preview.js'

const NOW = new Date('2026-11-05T23:40:00+02:00')
const API = 'https://www.soe.com.ua/next-api/shutdowns'
const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)

/** Encrypts like the site does, so decrypted fixtures can be served as real responses. */
async function encrypt(plain: string, keyString = 'qasdw-enjenf-twfeft!!d451qwqw!-2'): Promise<string> {
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(keyString), 'AES-GCM', false, [
    'encrypt',
  ])
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const data = new Uint8Array(
    await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)),
  )
  return JSON.stringify({ payload: Buffer.concat([iv, data]).toString('base64') })
}

async function routes(): Promise<Route[]> {
  return [
    { match: `${API}/schedules`, body: fixture('sumy/schedules-2026-11-05.encrypted.json') },
    { match: `${API}/cities?`, body: await encrypt(fixture('sumy/cities-shostka.json')) },
    {
      match: `${API}/streets?cityId=5911000000&`,
      body: fixture('sumy/streets-5911000000-shevch.encrypted.json'),
    },
    { match: `${API}/houses?streetId=7549&`, body: await encrypt(fixture('sumy/houses-7549-1.json')) },
    {
      match: `${API}/queues-by-street?streetId=7549&houseId=211911`,
      body: await encrypt(fixture('sumy/queues-by-street-7549-211911.json')),
    },
  ]
}

async function client(r?: Route[]) {
  const { fetch, calls } = mockFetch(r ?? (await routes()))
  return {
    client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [sumyProvider()] }),
    calls,
  }
}

describe('Sumyoblenergo', () => {
  it('decrypts the schedule and dates it today, merging overlapping windows', async () => {
    const { client: c, calls } = await client()
    const s = await c.getSchedules('sumy')
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
    const g11 = s.schedules['1.1']!
    expect(g11.map((d) => d.date)).toEqual(['2026-11-05'])
    // source: 08–12, 14–18, 20–00 and 22–00
    expect(g11[0]!.intervals).toEqual([
      { from: '2026-11-05T08:00:00+02:00', to: '2026-11-05T12:00:00+02:00', kind: 'off' },
      { from: '2026-11-05T14:00:00+02:00', to: '2026-11-05T18:00:00+02:00', kind: 'off' },
      { from: '2026-11-05T20:00:00+02:00', to: '2026-11-06T00:00:00+02:00', kind: 'off' },
    ])
    expect(hhmm(s.schedules['3.1']![0]!)).toEqual([
      '00:00-04:00',
      '06:00-10:00',
      '12:00-16:00',
      '18:00-21:30',
    ])
    expect(hhmm(s.schedules['6.2']![0]!)).toEqual(['10:00-14:00', '16:00-20:00', '22:00-00:00'])
    expect((calls[0]!.init?.headers as Record<string, string>).Referer).toMatch(
      /^https:\/\/www\.soe\.com\.ua\//,
    )
  })

  it('reads the update time', async () => {
    const s = await (await client()).client.getSchedules('sumy')
    expect(s.updatedAt).toBe('2026-11-05T21:21:00+02:00')
  })

  it('keeps groups without windows as a day with no outages scheduled', () => {
    const res = JSON.parse(fixture('sumy/schedules-2026-11-05.json'))
    for (const e of res.data) e.lst_time_disc = []
    const s = parseSumySchedules(res, NOW)
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']).toEqual([{ date: '2026-11-05', status: 'scheduled', intervals: [] }])
  })

  it('keeps every group as unknown, not "no outages", when every group has no data', () => {
    const s = parseSumySchedules(JSON.parse(fixture('sumy/schedules-no-data.json')), NOW)
    expectUnpublished(s, 12)
    expect(s.schedules['1.1']).toEqual([{ date: '2026-11-05', status: 'unknown', intervals: [] }])
  })

  it('rejects a changed schedule format', () => {
    expect(() => parseSumySchedules({} as never, NOW)).toThrow(OutageError)
    const res = JSON.parse(fixture('sumy/schedules-2026-11-05.json'))
    res.data[0].lst_time_disc = [{ from: '08:00', to: '12:00' }]
    expect(() => parseSumySchedules(res, NOW)).toThrow(/bad time/)
  })

  it('fails with a parse error when the key no longer decrypts', async () => {
    const body = await encrypt(fixture('sumy/schedules-2026-11-05.json'), 'a-different-key-of-32-bytes-xxxx')
    const err = await (
      await client([{ match: `${API}/schedules`, body }])
    ).client
      .getSchedules('sumy')
      .catch((e) => e)
    expect(err).toBeInstanceOf(OutageError)
    expect(err.code).toBe('parse')
    expect(err.message).toMatch(/^Sumy: cannot decrypt/)
    await expect(decryptSumyResponse({ payload: 'bm90IGVuY3J5cHRlZA==' })).rejects.toThrow(/cannot decrypt/)
    await expect(decryptSumyResponse({ message: 'x' } as never)).rejects.toThrow(/no encrypted "payload"/)
  })

  it('finds the group of a house', async () => {
    const { client: c, calls } = await client()
    const m = await c.findGroup('sumy', { city: 'Шостка', street: 'вул. Шевченка', house: '14' })
    expect(m).toEqual({
      region: 'sumy',
      group: '6.1',
      address: { city: 'м.Шостка', street: 'вулиця Шевченка', house: '14' },
    })
    // the server matches substrings, so the street type is left out of the query
    expect(calls.find((x) => x.url.includes('/streets?'))!.url).toContain(
      `search=${encodeURIComponent('шевченка')}`,
    )
    expect(calls.find((x) => x.url.includes('/houses?'))!.url).toContain('search=14')
  })

  it('returns every group of a building with several connections', async () => {
    const { fetch } = mockFetch([
      {
        match: `${API}/queues-by-street?streetId=7549&`,
        body: await encrypt(fixture('sumy/queues-by-street-7549.json')),
      },
    ])
    const c = new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [sumyProvider()] })
    const m = await c.groupOf(
      'sumy',
      { id: '1', number: '2', streetId: '7549' },
      { id: '7549', name: 'вулиця Шевченка' },
    )
    expect(m.group).toBe('4.1')
    expect(m.otherGroups).toEqual(['6.1'])
  })

  it('reports a house without an hourly schedule group as not found', async () => {
    const { fetch } = mockFetch([
      {
        match: `${API}/queues-by-street?`,
        body: await encrypt(fixture('sumy/queues-by-street-sumy-kharkivska.json')),
      },
    ])
    const c = new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [sumyProvider()] })
    const err = await c
      .groupOf('sumy', { id: '1', number: '1', streetId: '1' }, { id: '1', name: 'вулиця Харківська' })
      .catch((e) => e)
    expect(err).toBeInstanceOf(OutageError)
    expect(err.code).toBe('not-found')
  })
})

describe('Sumyoblenergo: the site and E-Svitlo as two channels', () => {
  const CABINET =
    'https://sm.e-svitlo.com.ua/ip_cabinet/restfull_api/improvise/api_main/get_user_disconnections_image_api.json'
  /** Real answers of 17.11.2026 00:48 for all twelve groups; the site's grid of 00:26 has the same windows */
  const ANSWERS: Record<string, { data: Record<string, any> }> = JSON.parse(
    fixture('sumy/e-svitlo-2026-11-17.by-group.json'),
  )
  const SITE_17 = fixture('sumy/schedules-2026-11-17.json')
  const AT = new Date('2026-11-17T00:48:00+02:00')
  const GROUPS = Object.keys(ANSWERS)
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

  /**
   * CONSTRUCTED: the tomorrow slot has only been seen empty. Here it is filled with the shape of
   * today's slot, which is what the reader accepts as a published tomorrow.
   */
  function withTomorrow(windows: (group: string) => { start_time: string; end_time: string }[]) {
    const out = clone(ANSWERS)
    for (const [g, a] of Object.entries(out))
      Object.assign(a.data.dict_tom, {
        no_data: false,
        last_update: 'Оновлено: 17.11.2026 21:05',
        lst_time_disc: windows(g),
      })
    return out
  }

  interface Setup {
    site?: string | null
    answers?: Record<string, unknown> | null
    now?: Date
    /** The channel's page, and processors to read it with */
    channel?: { page: string; text: TextProcessor; image: ImageProcessor; picture: Uint8Array }
  }
  async function setup({ site = SITE_17, answers = ANSWERS, now = AT, channel }: Setup = {}) {
    const siteBody = site === null ? null : await encrypt(site)
    const { fetch, calls } = mockFetch([
      { match: `${API}/schedules`, body: siteBody ?? 'down', status: siteBody === null ? 503 : 200 },
      {
        match: CABINET,
        method: 'POST',
        body: () => {
          const group = new URLSearchParams(String(calls.at(-1)!.init!.body)).get('cherga')!
          return answers ? JSON.stringify(answers[group]) : 'down'
        },
        status: answers ? 200 : 503,
      },
      ...(channel
        ? [
            { match: 't.me/s/SumyEnergo', body: channel.page },
            { match: 'cdn4.telesco.pe', body: channel.picture },
          ]
        : []),
    ])
    const client = new OutageClient({
      fetch,
      now: () => now,
      cacheTtlMs: 0,
      retries: 0,
      providers: [sumyProvider()],
      ...(channel ? { textProcessor: channel.text, imageProcessor: channel.image } : {}),
    })
    const asked = () =>
      calls
        .filter((c) => c.url === CABINET)
        .map((c) => new URLSearchParams(String(c.init!.body)).get('cherga'))
    return { client, calls, asked }
  }

  it("takes tomorrow from the channel's picture the evening before", async () => {
    const now = new Date('2026-11-17T21:30:00+02:00')
    const page = previewPage('SumyEnergo', [
      {
        id: 3931,
        at: '2026-11-17T18:49:00Z',
        text: 'Завтра, 18-11-2026, діятимуть графіки погодинних відключень відповідно до обсягів, доведених командою з НЕК "Укренерго".',
        photos: ['https://cdn4.telesco.pe/file/sumy-18.jpg'],
      },
    ])
    const text = fakeText(() => [ev({ kind: 'gpv', action: 'start', regions: ['sumy'], date: '2026-11-18' })])
    const image = fakeImage(() => ({
      date: '2026-11-18',
      schedule: pictureSchedule({
        '1.1': '00:00-02:00, 04:00-08:00, 10:00-12:00, 22:00-24:00',
        '1.2': '02:00-06:00',
      }),
    }))
    const picture = fixtureBytes('chernihiv/posters/2026-10-06-tg.jpg')
    const s = await (
      await setup({ now, channel: { page, text, image, picture } })
    ).client.getSchedules('sumy')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-17', '2026-11-18'])
    expect(hhmm(s.schedules['1.1']![1]!)).toEqual([
      '00:00-02:00',
      '04:00-08:00',
      '10:00-12:00',
      '22:00-00:00',
    ])
    expect(s.sources!.find((x) => x.id === 'telegram:@SumyEnergo')).toMatchObject({
      ok: true,
      dates: ['2026-11-18'],
      updatedAt: '2026-11-17T20:49:00+02:00',
    })
    // the caption says the photo is the schedule: read in full, no cheap check
    expect(image.calls).toHaveLength(1)
  })

  it('dates the site grid by E-Svitlo with one extra request', async () => {
    const { client, calls, asked } = await setup()
    const s = await client.getSchedules('sumy')
    expect(s.groups).toEqual(GROUPS)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['08:00-12:00', '14:00-18:00', '20:00-22:00'])
    expect(hhmm(s.schedules['3.2']![0]!)).toEqual([
      '00:00-02:00',
      '04:00-08:00',
      '10:00-12:00',
      '22:00-00:00',
    ])
    expect(s.updatedAt).toBe('2026-11-16T22:49:00+02:00')
    // the tomorrow slot is empty: the other eleven groups are not asked
    expect(asked()).toEqual(['1.1'])
    expect(calls).toHaveLength(2)
    expect(new URLSearchParams(String(calls[1]!.init!.body)).get('mobile_v')).toBe('true')
    expect(s.sources).toEqual([
      {
        id: 'site',
        url: 'https://www.soe.com.ua/consumers/shutdowns',
        ok: true,
        dates: ['2026-11-17'],
        updatedAt: '2026-11-16T22:49:00+02:00',
      },
      { id: 'e-svitlo', url: 'https://sm.e-svitlo.com.ua/', ok: true, dates: [], updatedAt: null },
      // no image processor: the channel's pictures aren't read, and not fetched
      {
        id: 'telegram:@SumyEnergo',
        url: 'https://t.me/s/SumyEnergo',
        ok: false,
        dates: [],
        updatedAt: null,
        error: { code: 'config', message: expect.stringContaining('imageProcessor') },
      },
    ])
  })

  it("does not date yesterday's grid today when both still serve it after midnight", async () => {
    // 18.11 00:00:20 by the clock; the site and E-Svitlo (date_today 17.11) have not switched yet
    const now = new Date('2026-11-18T00:00:20+02:00')
    const s = await (await setup({ now })).client.getSchedules('sumy')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(assessFreshness(s, { now })).toMatchObject({ state: 'stale', today: 'missing' })
  })

  it('adds tomorrow from E-Svitlo as soon as its slot is filled, asking all twelve groups', async () => {
    const answers = withTomorrow((g) => [{ start_time: g === '1.1' ? '06:00' : '10:00', end_time: '14:00' }])
    const now = new Date('2026-11-17T21:10:00+02:00')
    const { client, asked } = await setup({ answers, now })
    const s = await client.getSchedules('sumy')
    expect(asked().sort()).toEqual(GROUPS)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-17', '2026-11-18'])
    expect(hhmm(s.schedules['1.1']![1]!)).toEqual(['06:00-14:00'])
    expect(hhmm(s.schedules['6.2']![1]!)).toEqual(['10:00-14:00'])
    expect(s.updatedAt).toBe('2026-11-17T21:05:00+02:00')
    // today: same windows and change time on both, so the first channel keeps it
    expect(s.sources!.map((x) => [x.id, x.ok, x.dates, x.updatedAt, x.disagrees])).toEqual([
      ['site', true, ['2026-11-17'], '2026-11-16T22:49:00+02:00', undefined],
      ['e-svitlo', true, ['2026-11-18'], '2026-11-17T21:05:00+02:00', undefined],
      ['telegram:@SumyEnergo', false, [], null, undefined],
    ])
    expect(assessFreshness(s, { now, tomorrowExpectedAt: '21:00' })).toMatchObject({
      state: 'fresh',
      tomorrow: 'published',
      issues: [],
    })
  })

  it('ignores a tomorrow slot of any other shape, never failing on it', () => {
    const base = ANSWERS['1.1']!
    const tom = (dict_tom: unknown) => {
      const a = clone(base)
      a.data.dict_tom = dict_tom
      return parseCabinetAnswer(a, '1.1', AT)
    }
    const filled = { ...base.data.dict_tom, no_data: false, last_update: 'Оновлено: 17.11.2026 21:05' }
    const windows = [{ start_time: '06:00', end_time: '10:00' }]
    // as seen live: no_data true
    expect(parseCabinetAnswer(base, '1.1', AT)).toMatchObject({ tomorrow: null, tomorrowAnnounced: false })
    for (const odd of [null, undefined, {}, [], 'завтра', 5])
      expect(tom(odd)).toMatchObject({ tomorrow: null, tomorrowAnnounced: false })
    // filled but not readable as a day: not published, though worth a look at the other groups
    for (const odd of [
      { ...filled, lst_time_disc: [] },
      { ...filled, lst_time_disc: 'none' },
      { ...filled, lst_time_disc: [{ start_time: '6', end_time: 'ранок' }] },
      { ...filled, lst_time_disc: windows, cherga_n: '2.1' },
      { ...filled, lst_time_disc: windows, date_today: '19.11.2026' },
      { ...filled, lst_time_disc: windows, date_today: undefined },
    ])
      expect(tom(odd)).toMatchObject({ tomorrow: null, tomorrowAnnounced: true })
    expect(tom({ ...filled, lst_time_disc: windows }).tomorrow).toEqual({
      date: '2026-11-18',
      slots: [{ start: 360, end: 600, kind: 'off' }],
      publishedAt: '2026-11-17T21:05:00+02:00',
    })
  })

  it('reads all twelve groups from E-Svitlo when the site is down', async () => {
    const { client, asked } = await setup({ site: null })
    const s = await client.getSchedules('sumy')
    expect(asked().sort()).toEqual(GROUPS)
    expect(s.schedules['5.2']).toEqual([
      {
        date: '2026-11-17',
        status: 'scheduled',
        intervals: [
          { from: '2026-11-17T14:00:00+02:00', to: '2026-11-17T18:00:00+02:00', kind: 'off' },
          { from: '2026-11-17T20:00:00+02:00', to: '2026-11-18T00:00:00+02:00', kind: 'off' },
        ],
      },
    ])
    expect(s.updatedAt).toBe('2026-11-16T22:49:00+02:00')
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: false, error: { code: 'http' } })
    expect(s.sources![1]).toMatchObject({ id: 'e-svitlo', ok: true, dates: ['2026-11-17'] })
  })

  it('reads the site alone when E-Svitlo is down, dated by the clock', async () => {
    const now = new Date('2026-11-17T01:00:00+02:00')
    const s = await (await setup({ answers: null, now })).client.getSchedules('sumy')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: true, dates: ['2026-11-17'] })
    expect(s.sources![1]).toMatchObject({ id: 'e-svitlo', ok: false, error: { code: 'http' } })
  })

  it("just after midnight, E-Svitlo down: a grid changed yesterday isn't dated today", async () => {
    // "Оновлено: 16.11.2026 22:49" read at 00:10 on 17.11: the evening's schedule for the 17th,
    // or the 16th's grid the endpoint still serves; the stamp is the same for both
    for (const at of ['2026-11-17T00:10:00+02:00', '2026-11-17T00:59:00+02:00']) {
      const s = await (await setup({ answers: null, now: new Date(at) })).client.getSchedules('sumy')
      expectUnpublished(s, 12)
      expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-17'])
      expect(s.sources).toMatchObject([
        { id: 'site', ok: true, dates: [] },
        { id: 'e-svitlo', ok: false },
        { id: 'telegram:@SumyEnergo', ok: false, error: { code: 'config' } },
      ])
      expect(s.updatedAt).toBeNull()
    }
    // a grid changed after midnight is today's whatever the minute
    const changed = JSON.parse(SITE_17)
    for (const e of changed.data) if (e.last_update) e.last_update = 'Оновлено: 17.11.2026 00:05'
    const s = await (
      await setup({
        site: JSON.stringify(changed),
        answers: null,
        now: new Date('2026-11-17T00:10:00+02:00'),
      })
    ).client.getSchedules('sumy')
    expect(s.schedules['1.1']!.map((d) => [d.date, d.status])).toEqual([['2026-11-17', 'scheduled']])
    expect(s.updatedAt).toBe('2026-11-17T00:05:00+02:00')
  })

  it('refuses to date a grid last changed before yesterday when nothing else dates it', async () => {
    // the 17.11 grid ("Оновлено: 16.11.2026 22:49") still served on 19.11, E-Svitlo down
    const now = new Date('2026-11-19T09:00:00+02:00')
    await expect((await setup({ answers: null, now })).client.getSchedules('sumy')).rejects.toMatchObject({
      code: 'parse',
      message: expect.stringMatching(/no date and was last changed 2026-11-16T22:49/),
    })
    // changed yesterday evening = published the evening before: today's, as on 17.11
    const day = new Date('2026-11-17T23:00:00+02:00')
    const s = await (await setup({ answers: null, now: day })).client.getSchedules('sumy')
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-17'])
  })

  it("does not date a site grid that differs from both of E-Svitlo's days", async () => {
    // the site still serves another day's windows (1.1: 00–04, 06–10, 18–22) under today's clock
    const other = JSON.parse(SITE_17)
    other.data[0].lst_time_disc = [
      { start_time: '00:00', end_time: '04:00' },
      { start_time: '06:00', end_time: '10:00' },
      { start_time: '18:00', end_time: '22:00' },
    ]
    const { client, asked } = await setup({ site: JSON.stringify(other) })
    const s = await client.getSchedules('sumy')
    expect(asked().sort()).toEqual(GROUPS)
    expect(s.sources![0]).toMatchObject({
      id: 'site',
      ok: false,
      error: { code: 'parse', message: expect.stringMatching(/differs from both days E-Svitlo has/) },
    })
    expect(s.sources![1]).toMatchObject({ id: 'e-svitlo', ok: true, dates: ['2026-11-17'] })
    expect(hhmm(s.schedules['1.1']![0]!)).toEqual(['08:00-12:00', '14:00-18:00', '20:00-22:00'])
  })

  it('fails when both channels are down', async () => {
    await expect(
      (await setup({ site: null, answers: null })).client.getSchedules('sumy'),
    ).rejects.toMatchObject({ code: 'http' })
  })

  it("reads today's slot strictly", () => {
    const a = (patch: Record<string, unknown>) => {
      const x = clone(ANSWERS['1.1']!)
      Object.assign(x.data, patch)
      return x
    }
    expect(parseCabinetAnswer(ANSWERS['1.1'], '1.1', AT).today).toEqual({
      date: '2026-11-17',
      slots: [
        { start: 480, end: 720, kind: 'off' },
        { start: 840, end: 1080, kind: 'off' },
        { start: 1200, end: 1320, kind: 'off' },
      ],
      publishedAt: '2026-11-16T22:49:00+02:00',
    })
    // another group's answer, a date that is not around today, no date, a bad time
    expect(() => parseCabinetAnswer(ANSWERS['2.1'], '1.1', AT)).toThrow(/asked for group 1.1/)
    expect(() => parseCabinetAnswer(a({ date_today: '05.11.2026' }), '1.1', AT)).toThrow(/date_today/)
    expect(() => parseCabinetAnswer(a({ date_today: undefined }), '1.1', AT)).toThrow(/date_today/)
    expect(() =>
      parseCabinetAnswer(a({ lst_time_disc: [{ start_time: 'x', end_time: 'y' }] }), '1.1', AT),
    ).toThrow(/bad time/)
    expect(() => parseCabinetAnswer({}, '1.1', AT)).toThrow(/no "data"/)
    // what the endpoint answers without a group: nothing published for it, not "no outages"
    expect(
      parseCabinetAnswer({ data: { no_data: true, date_today: '17.11.2026', dict_tom: null } }, '1.1', AT),
    ).toMatchObject({ today: { date: '2026-11-17', slots: null }, tomorrow: null })
    // the half-hour rows are not on/off (all "3" at night although outages follow): not used
    expect(new Set(ANSWERS['1.1']!.data.gpv_schedule.map((r: { status: number }) => r.status))).toEqual(
      new Set([3]),
    )
  })
})
