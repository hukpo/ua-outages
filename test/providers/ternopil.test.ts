import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { REPRESENTATIVES, parseGroupGraph, ternopilProvider } from '../../src/providers/ternopil.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-10-17T19:00:00+03:00')
const API = 'https://api-poweron.toe.com.ua/api'

/** Real `a_gpv_g` answers of 17.10.2026 for every representative, keyed by "city/street/house". */
const BY_ADDRESS: Record<string, unknown> = JSON.parse(fixture('ternopil/a_gpv_g.2026-10-17.by-address.json'))

const decodeKey = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))

function client(graph: (address: string) => unknown = (a) => BY_ADDRESS[a] ?? { 'hydra:member': [] }) {
  const { fetch, calls } = mockFetch([
    {
      match: `${API}/a_gpv_g?`,
      body: () => {
        const headers = calls.at(-1)!.init!.headers as Record<string, string>
        return JSON.stringify(graph(decodeKey(headers['X-debug-key']!)))
      },
    },
    { match: `${API}/pw_cities?pagination=false`, body: fixture('ternopil/pw_cities.json') },
    { match: `${API}/pw_streets?pagination=false&city.id=1032`, body: fixture('ternopil/pw_streets.city-1032.json') },
    { match: `${API}/pw-accounts/building-names?cityId=1032&streetId=10035`, body: fixture('ternopil/building-names.city-1032.street-10035.json') },
    {
      match: `${API}/pw-accounts/building-groups?cityId=1032&streetId=10035&buildingNames=1`,
      body: fixture('ternopil/building-groups.city-1032.street-10035.building-1.json'),
    },
    { match: `${API}/pw-accounts/building-groups?`, body: '{"buildingGroups":[{"chergGpv":"1.2"},{"chergGpv":"4.1#2"}]}' },
  ])
  return { client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [ternopilProvider()] }), calls }
}

describe('Ternopiloblenergo', () => {
  it('asks for each group with its representative address, like the official site', async () => {
    const { client: c, calls } = client()
    await c.getSchedules('ternopil')
    const graphCalls = calls.filter((x) => x.url.includes('/a_gpv_g?'))
    expect(graphCalls).toHaveLength(12)
    const first = new URL(graphCalls.find((x) => x.url.includes('group%5B%5D=3.2'))!.url)
    expect(first.searchParams.get('after')).toBe('2026-10-16T12:00:00+00:00')
    expect(first.searchParams.get('before')).toBe('2026-10-18T00:00:00+00:00')
    expect(first.searchParams.get('time')).toBe('1032100351')
    // Cyrillic house numbers are sent as UTF-8 base64
    const r22 = REPRESENTATIVES['2.2']!
    const h = graphCalls.find((x) => x.url.includes('group%5B%5D=2.2'))!.init!.headers as Record<string, string>
    expect(decodeKey(h['X-debug-key']!)).toBe(`${r22.cityId}/${r22.streetId}/2-В`)
  })

  it('reads half-hour slots with possible-outage edges', async () => {
    const s = await client().client.getSchedules('ternopil')
    expect(s.groups).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'])
    expect(s.schedules['3.2']).toEqual([
      {
        date: '2026-10-17',
        status: 'scheduled',
        intervals: [
          { from: '2026-10-17T19:30:00+03:00', to: '2026-10-17T20:00:00+03:00', kind: 'maybe' },
          { from: '2026-10-17T20:00:00+03:00', to: '2026-10-17T22:00:00+03:00', kind: 'off' },
          { from: '2026-10-17T22:00:00+03:00', to: '2026-10-17T22:30:00+03:00', kind: 'maybe' },
        ],
      },
    ])
    expect(s.schedules['1.1']![0]!.intervals.filter((i) => i.kind === 'off')).toEqual([
      { from: '2026-10-17T10:00:00+03:00', to: '2026-10-17T13:00:00+03:00', kind: 'off' },
      { from: '2026-10-17T17:00:00+03:00', to: '2026-10-17T18:00:00+03:00', kind: 'off' },
    ])
  })

  it('reads dateCreate as Kyiv wall-clock time despite the "Z"', async () => {
    // "2026-10-17T18:52:36Z" is shown as 18:52 on the operator's site; the backend also
    // stamps its sync time with Kyiv time labelled +00:00
    const s = await client().client.getSchedules('ternopil')
    expect(s.updatedAt).toBe('2026-10-17T18:52:36+03:00')
  })

  it('treats "nothing scheduled" for every representative as no schedule', async () => {
    const empty = JSON.parse(fixture('ternopil/a_gpv_g.current-empty.json'))
    const s = await client(() => empty).client.getSchedules('ternopil')
    expect(s.groups).toEqual([])
  })

  it('marks a group unknown when only its representative answers nothing', async () => {
    const empty = JSON.parse(fixture('ternopil/a_gpv_g.current-empty.json'))
    const s = await client((a) => (a === '1032/10035/1' ? empty : BY_ADDRESS[a])).client.getSchedules('ternopil')
    expect(s.schedules['3.2']).toEqual([{ date: '2026-10-17', status: 'unknown', intervals: [] }])
    expect(s.schedules['1.2']![0]!.status).toBe('scheduled')
  })

  it('fails when a representative address is gone or moved to another group', async () => {
    await expect(
      client((a) => (a === '1032/10035/1' ? { 'hydra:member': [] } : BY_ADDRESS[a])).client.getSchedules('ternopil'),
    ).rejects.toThrow(expect.objectContaining({ code: 'parse', message: expect.stringContaining('no longer knows') }))

    const moved = BY_ADDRESS['1032/10035/2'] // a 1.2 building answering for 3.2
    await expect(client((a) => (a === '1032/10035/1' ? moved : BY_ADDRESS[a])).client.getSchedules('ternopil')).rejects.toThrow(
      /group 3\.2 .* now returns 1\.2/,
    )
  })

  it('rejects unknown slot values', () => {
    const item = { dateGraph: '2026-10-17T00:00:00Z', dateCreate: '2026-10-17T18:52:36Z', dataJson: { '3.2': { times: { '00:00': '2' } } } }
    expect(() => parseGroupGraph({ 'hydra:member': [item] }, '3.2')).toThrow(expect.objectContaining({ code: 'parse' }))
    expect(() => parseGroupGraph({ items: [] }, '3.2')).toThrow(expect.objectContaining({ code: 'parse' }))
  })

  it('finds the group of an address', async () => {
    const m = await client().client.findGroup('ternopil', { city: 'Тернопіль', street: 'Руська', house: '1' })
    expect(m).toEqual({ region: 'ternopil', group: '3.2', address: { city: 'Тернопіль', street: 'вул. Руська', house: '1' } })
  })

  it('reports both groups of a building with two supplies', async () => {
    const m = await client().client.findGroup('ternopil', { city: 'Тернопіль', street: 'вул. Руська', house: '2-а' })
    expect(m.address.house).toBe('2-А')
    expect(m.group).toBe('1.2')
    expect(m.otherGroups).toEqual(['4.1'])
  })
})
