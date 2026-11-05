import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { Http } from '../../src/http.js'
import { kirovohradProvider, parseGraphs } from '../../src/providers/kirovohrad.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-05T23:40:00+02:00')
const B = 'https://kiroe.com.ua/electricity-blackout'
const EMPTY = '{"success":true,"data":[]}'
const TOKEN = '00000000000000000000000000000000'

function setup(opts: { graphs?: string; sessionDead?: boolean } = {}) {
  const dead = opts.sessionDead ?? false
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
      body: () =>
        dead ? EMPTY : (opts.graphs ?? fixture('kirovohrad/blackout-actual-gpv-graphs.2026-11-05.json')),
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
  ])
  const provider = kirovohradProvider()
  return {
    client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [provider] }),
    ctx: { http: new Http({ fetch }), now: () => NOW },
    provider,
    calls,
  }
}

const spans = (s: ReturnType<typeof parseGraphs>, group: string) =>
  s.schedules[group]![0]!.intervals.map((i) => `${i.from.slice(11, 16)}–${i.to.slice(11, 16)} ${i.kind}`)

describe('Kirovohradoblenergo', () => {
  const graphs = JSON.parse(fixture('kirovohrad/blackout-actual-gpv-graphs.2026-11-05.json')).data

  it('reads today’s half-hour cells with possible-outage edges', () => {
    const s = parseGraphs(graphs, NOW)
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
    // the operator publishes no change time
    expect(s.updatedAt).toBeNull()
    expect(s.fetchedAt).toBe('2026-11-05T23:40:00+02:00')
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

  it('returns no groups when the schedule is empty but the session works', async () => {
    const { client, calls } = setup({ graphs: EMPTY })
    expect((await client.getSchedules('kirovohrad')).groups).toEqual([])
    // the empty answer was double-checked against a known ОТГ
    expect(calls.some((c) => c.url.endsWith('/city/86'))).toBe(true)
  })

  it('does not mistake a rejected session for "no outages"', async () => {
    await expect(setup({ sessionDead: true }).client.getSchedules('kirovohrad')).rejects.toMatchObject({
      code: 'blocked',
      message: expect.stringMatching(/ignores our session/),
    })
  })

  it('renews an expired session instead of reporting no outages', async () => {
    let pages = 0
    const graphs = fixture('kirovohrad/blackout-actual-gpv-graphs.2026-11-05.json')
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
        body: () => (pages === 1 && calls.length > 2 ? EMPTY : graphs),
      },
    ])
    const client = new OutageClient({
      fetch,
      now: () => NOW,
      cacheTtlMs: 0,
      providers: [kirovohradProvider()],
    })
    await client.getSchedules('kirovohrad')
    await new Promise((r) => setTimeout(r, 2))
    expect((await client.getSchedules('kirovohrad')).groups).toHaveLength(12)
    expect(pages).toBe(2)
  })

  it('fails loudly when the cell format changes', () => {
    const odd = structuredClone(graphs)
    odd['1.1'].times['00:00'] = '2'
    expect(() => parseGraphs(odd, NOW)).toThrow(expect.objectContaining({ code: 'parse' }))
    const short = structuredClone(graphs)
    delete short['3.2'].times['23:30']
    expect(() => parseGraphs(short, NOW)).toThrow(/47 cells, expected 48/)
    expect(() => parseGraphs(['1.1'], NOW)).toThrow(expect.objectContaining({ code: 'parse' }))
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
