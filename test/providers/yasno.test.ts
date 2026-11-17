import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { assessFreshness } from '../../src/freshness.js'
import { parsePlanned } from '../../src/providers/yasno.js'
import type { FetchLike } from '../../src/http.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-05T23:30:00+02:00')
const API = 'app.yasno.ua/api/blackout-service/public/shutdowns'

function client() {
  const { fetch, calls } = mockFetch([
    {
      match: `${API}/regions/25/dsos/902/planned-outages`,
      body: fixture('yasno/planned-outages-25-902.json'),
    },
    { match: `${API}/regions/3/dsos/301/planned-outages`, body: fixture('yasno/planned-outages-3-301.json') },
    { match: `${API}/addresses/v2/streets?regionId=25`, body: fixture('yasno/streets-kyiv-902-khresh.json') },
    { match: `${API}/addresses/v2/houses?regionId=25`, body: fixture('yasno/houses-kyiv-902-915.json') },
    { match: `${API}/addresses/v2/group?regionId=25`, body: fixture('yasno/group-kyiv-902-915-41296.json') },
    { match: `${API}/addresses/v2/cities?regionId=3`, body: fixture('yasno/cities-dnipro-301.json') },
    {
      match: `${API}/addresses/v2/streets?regionId=3`,
      body: fixture('yasno/streets-dnipro-301-city6-yavorn.json'),
    },
    {
      match: `${API}/addresses/v2/houses?regionId=3`,
      body: fixture('yasno/houses-dnipro-301-city6-1587.json'),
    },
    {
      match: `${API}/addresses/v2/group?regionId=3`,
      body: fixture('yasno/group-dnipro-301-city6-1587-85578.json'),
    },
  ])
  return { client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0 }), calls }
}

const SITE_1117 = fixture('dtek/kem-ajax-checkDisconUpdate-2026-11-17.trimmed.json')

/**
 * `inner`, plus a DTEK site's /ua/ajax: the first POST (no token) is refused with the CSRF
 * cookie, the next ones get `body`. `down` = the bot check on both of the site's routes.
 */
function withSite(inner: FetchLike, code: string, body: string, down = false): FetchLike {
  const host = `https://www.dtek-${code}.com.ua`
  const cookie = encodeURIComponent(
    `${'a'.repeat(64)}a:2:{i:0;s:${10 + code.length + 1};"_csrf-dtek-${code}";i:1;s:4:"abcd";}`,
  )
  return async (url, init) => {
    if (!url.startsWith(host)) return inner(url, init)
    if (down) return new Response(fixture('dtek/blocked.html'))
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (!headers['X-CSRF-Token'])
      return new Response('Bad Request (#400)', {
        status: 400,
        headers: { 'set-cookie': `_csrf-dtek-${code}=${cookie}; path=/` },
      })
    return new Response(body)
  }
}

describe('YASNO', () => {
  it('parses every Kyiv group with today and tomorrow', async () => {
    const s = await client().client.getSchedules('kyiv')
    expect(s.groups.length).toBe(60)
    expect(s.groups[0]).toBe('1.1')
    expect(s.updatedAt).toBe('2026-11-05T21:15:03+02:00')
    const days = s.schedules['1.1']!
    expect(days.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
    expect(days[0]!.status).toBe('scheduled')
  })

  it('turns Definite slots into off intervals in Kyiv time', async () => {
    const s = await client().client.getSchedule('dnipro', '1.1')
    expect(s.days[0]!.intervals).toEqual([
      { from: '2026-11-05T00:00:00+02:00', to: '2026-11-05T02:30:00+02:00', kind: 'off' },
      { from: '2026-11-05T09:00:00+02:00', to: '2026-11-05T13:00:00+02:00', kind: 'off' },
      { from: '2026-11-05T19:30:00+02:00', to: '2026-11-06T00:00:00+02:00', kind: 'off' },
    ])
  })

  it('maps statuses and unknown slot types', () => {
    const s = parsePlanned(
      'kyiv',
      {
        '1.1': {
          today: { date: '2026-11-05T00:00:00+02:00', status: 'EmergencyShutdowns', slots: [] },
          tomorrow: {
            date: '2026-11-06T00:00:00+02:00',
            status: 'ScheduleApplies',
            slots: [{ start: 60, end: 120, type: 'Possible' }],
          },
        },
      },
      NOW,
    )
    expect(s.schedules['1.1']![0]!.status).toBe('emergency')
    expect(s.schedules['1.1']![1]!.intervals[0]!.kind).toBe('maybe')
  })

  it('asks past the CDN cache, and names the API first among its sources', async () => {
    const { client: c, calls } = client()
    const s = await c.getSchedules('kyiv')
    // the CDN keeps an answer for 5 minutes; an extra parameter reaches the origin
    expect(calls.find((x) => x.url.includes('app.yasno.ua'))!.url).toMatch(
      /\/regions\/25\/dsos\/902\/planned-outages\?_=\d{10}$/,
    )
    // the operator's site (the second source) has no route in this mock: it failed, and costs nothing
    expect(s.sources).toHaveLength(2)
    expect(s.sources![1]).toMatchObject({ id: 'site', ok: false })
    expect(s.sources!.slice(0, 1)).toEqual([
      {
        id: 'api',
        url: 'https://static.yasno.ua/kyiv/outages',
        ok: true,
        dates: ['2026-11-05', '2026-11-06'],
        // `updatedOn`, the same for every group
        updatedAt: '2026-11-05T21:15:03+02:00',
      },
    ])
  })

  it('dates days by their own date: a copy from before midnight is not relabelled', async () => {
    // the 05.11 answer (today 05.11, tomorrow 06.11) read at 00:02 on 06.11
    const now = new Date('2026-11-06T00:02:00+02:00')
    const s = parsePlanned('kyiv', JSON.parse(fixture('yasno/planned-outages-25-902.json')), now)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
    expect(assessFreshness(s, { now })).toMatchObject({
      state: 'fresh',
      today: 'published',
      tomorrow: 'missing',
    })
    // and one that stopped moving is behind, not today's
    const stuck = new Date('2026-11-08T12:00:00+02:00')
    expect(assessFreshness({ ...s, fetchedAt: '2026-11-08T12:00:00+02:00' }, { now: stuck })).toMatchObject({
      state: 'stale',
      today: 'missing',
      coveredThrough: '2026-11-06',
    })
  })

  it('leaves tomorrow unknown while YASNO waits for the schedule', async () => {
    // live, 17.11.2026 00:43: today ScheduleApplies, tomorrow WaitingForSchedule with no slots
    const now = new Date('2026-11-17T00:45:00+02:00')
    const { fetch } = mockFetch([
      {
        match: `${API}/regions/25/dsos/902/planned-outages`,
        body: fixture('yasno/planned-outages-25-902-2026-11-17T0043.json'),
      },
    ])
    const s = await new OutageClient({
      fetch: withSite(fetch, 'kem', SITE_1117),
      now: () => now,
      cacheTtlMs: 0,
    }).getSchedules('kyiv')
    expect(s.groups).toHaveLength(60)
    expect(s.schedules['1.1']!.map((d) => [d.date, d.status])).toEqual([
      ['2026-11-17', 'scheduled'],
      ['2026-11-18', 'unknown'],
    ])
    // published at 00:00:01 on the day itself
    expect(s.updatedAt).toBe('2026-11-17T00:00:01+02:00')
    expect(s.sources![0]).toMatchObject({ dates: ['2026-11-17'], updatedAt: '2026-11-17T00:00:01+02:00' })
    expect(assessFreshness(s, { now })).toMatchObject({ state: 'fresh', tomorrow: 'missing', issues: [] })
  })

  it('takes slots only from a schedule that applies', () => {
    const day = (date: string, status: string) => ({
      date: `${date}T00:00:00+02:00`,
      status,
      slots: [{ start: 60, end: 120, type: 'Definite' }],
    })
    const read = (today: string, tomorrow: string) =>
      parsePlanned(
        'kyiv',
        { '1.1': { today: day('2026-11-05', today), tomorrow: day('2026-11-06', tomorrow) } },
        NOW,
      ).schedules['1.1']!.map((d) => [d.status, d.intervals.length])
    // a preliminary list under WaitingForSchedule isn't the schedule: unknown, without intervals
    expect(read('ScheduleApplies', 'WaitingForSchedule')).toEqual([
      ['scheduled', 1],
      ['unknown', 0],
    ])
    // an emergency today says nothing about tomorrow, though YASNO copies the status there
    expect(read('EmergencyShutdowns', 'EmergencyShutdowns')).toEqual([
      ['emergency', 0],
      ['unknown', 0],
    ])
    expect(read('NoOutages', 'SomethingNew')).toEqual([
      ['no-outages', 0],
      ['unknown', 0],
    ])
  })

  it('rejects a changed format', () => {
    expect(() => parsePlanned('kyiv', [] as never, NOW)).toThrow(/expected an object/)
    expect(() => parsePlanned('kyiv', { foo: 1 } as never, NOW)).toThrow(/no groups/)
  })

  it('finds a Kyiv group by address', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('kyiv', { street: 'Хрещатик', house: '6' })
    expect(m).toEqual({
      region: 'kyiv',
      group: '20.1',
      address: { city: undefined, street: 'вул. Хрещатик', house: '6' },
    })
    expect(calls.find((x) => x.url.includes('/streets'))!.url).toContain(
      'query=%D0%A5%D1%80%D0%B5%D1%89%D0%B0%D1%82%D0%B8%D0%BA',
    )
  })

  it('finds a Dnipro group through the city', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('dnipro', {
      city: 'Дніпро',
      street: 'просп. Дмитра Яворницького',
      house: '41',
    })
    expect(m.group).toBe('5.1')
    // the group endpoint 404s without cityId
    expect(calls.find((x) => x.url.includes('/group'))!.url).toContain('cityId=6')
  })

  it('asks to be more specific when the street type is missing', async () => {
    await expect(
      client().client.findGroup('dnipro', { city: 'Дніпро', street: 'Яворницького', house: '41' }),
    ).rejects.toThrow(/matches several/)
  })

  it('requires a city in multi-settlement regions', async () => {
    await expect(
      client().client.findGroup('dnipro', { street: 'Яворницького', house: '41' }),
    ).rejects.toThrow(/specify a city/)
  })
})

describe("Kyiv and Dnipro: YASNO and the grid operator's own site together", () => {
  const now = new Date('2026-11-17T00:45:00+02:00')
  const YASNO_1117 = fixture('yasno/planned-outages-25-902-2026-11-17T0043.json')
  const yasno = (body: string, status = 200) =>
    mockFetch([{ match: `${API}/regions/25/dsos/902/planned-outages`, body, status }]).fetch
  const kyiv = (fetch: FetchLike) => new OutageClient({ fetch, now: () => now, cacheTtlMs: 0, retries: 0 })
  const hours = (s: Awaited<ReturnType<OutageClient['getSchedules']>>, g: string) =>
    s.schedules[g]![0]!.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`).join(' ')

  it('the two agree (17.11.2026, every queue): YASNO, stamped later, supplies the day', async () => {
    const s = await kyiv(withSite(yasno(YASNO_1117), 'kem', SITE_1117)).getSchedules('kyiv')
    expect(s.sources).toEqual([
      {
        id: 'api',
        url: 'https://static.yasno.ua/kyiv/outages',
        ok: true,
        dates: ['2026-11-17'],
        updatedAt: '2026-11-17T00:00:01+02:00',
      },
      {
        id: 'site',
        url: 'https://www.dtek-kem.com.ua/ua/ajax',
        ok: true,
        dates: [],
        updatedAt: '2026-11-16T23:46:00+02:00',
      },
    ])
    expect(s.updatedAt).toBe('2026-11-17T00:00:01+02:00')
  })

  it("YASNO down: the operator's site alone gives the day", async () => {
    const s = await kyiv(withSite(yasno('upstream error', 502), 'kem', SITE_1117)).getSchedules('kyiv')
    expect(s.groups).toHaveLength(60)
    expect(s.schedules['1.1']![0]).toMatchObject({ date: '2026-11-17', status: 'scheduled' })
    expect(s.sources).toMatchObject([
      { id: 'api', ok: false, error: { code: 'http' } },
      { id: 'site', ok: true, dates: ['2026-11-17'] },
    ])
    expect(assessFreshness(s, { now }).issues.map((i) => i.code)).toContain('source-failed')
  })

  it('the site down: YASNO alone, as before', async () => {
    const s = await kyiv(withSite(yasno(YASNO_1117), 'kem', SITE_1117, true)).getSchedules('kyiv')
    expect(s.sources).toMatchObject([
      { id: 'api', ok: true, dates: ['2026-11-17'] },
      { id: 'site', ok: false, error: { code: 'blocked' } },
    ])
  })

  it('a change the site has first wins the day, and YASNO is marked as disagreeing', async () => {
    const changed = JSON.parse(SITE_1117)
    changed.fact.update = '17.11.2026 00:30'
    const day = Object.keys(changed.fact.data)[0]!
    for (let h = 1; h <= 24; h++) changed.fact.data[day]['GPV1.1'][h] = h === 20 || h === 21 ? 'no' : 'yes'
    const s = await kyiv(withSite(yasno(YASNO_1117), 'kem', JSON.stringify(changed))).getSchedules('kyiv')
    expect(hours(s, '1.1')).toBe('19:00-21:00')
    expect(s.updatedAt).toBe('2026-11-17T00:30:00+02:00')
    expect(s.sources).toMatchObject([
      { id: 'api', dates: [], disagrees: true },
      { id: 'site', dates: ['2026-11-17'] },
    ])
  })

  it("both down is an error of the region: the API's", async () => {
    await expect(
      kyiv(withSite(yasno('upstream error', 502), 'kem', SITE_1117, true)).getSchedules('kyiv'),
    ).rejects.toMatchObject({ code: 'http' })
  })
})
