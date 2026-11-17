import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { assessFreshness } from '../../src/freshness.js'
import { parseActive } from '../../src/providers/mykolaiv.js'
import { fixture, mockFetch, expectUnpublished } from '../helpers.js'

const NOW = new Date('2026-11-05T23:30:00+02:00')
const API = 'https://off.energy.mk.ua/api'

function client() {
  const { fetch, calls } = mockFetch([
    { match: `${API}/schedule/time-series`, body: fixture('mykolaiv/time-series.json') },
    { match: `${API}/outage-queue/by-type/3`, body: fixture('mykolaiv/outage-queue-by-type-3.json') },
    { match: `${API}/v2/schedule/active`, body: fixture('mykolaiv/schedule-active-2026-11-05.json') },
    { match: `${API}/addr/filii/15/ns`, body: fixture('mykolaiv/addr-filii-15-ns.json') },
    { match: /\/addr\/filii\/\d+\/ns$/, body: '[]' },
    { match: `${API}/addr/filii`, body: fixture('mykolaiv/addr-filii.json') },
    { match: `${API}/addr/ns/171/street`, body: fixture('mykolaiv/addr-ns-171-street.json') },
    { match: `${API}/addr/street/3057/dom`, body: fixture('mykolaiv/addr-street-3057-dom.json') },
    {
      match: `${API}/addr/dom/121142/outage-queue`,
      body: fixture('mykolaiv/addr-dom-121142-outage-queue.json'),
    },
  ])
  return { client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0 }), calls }
}

describe('Mykolaivoblenergo', () => {
  it('builds half-hour schedules with possible-outage edges', async () => {
    const s = await client().client.getSchedule('mykolaiv', '2.2')
    expect(s.days.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
    expect(s.days[0]!.intervals.slice(0, 3)).toEqual([
      { from: '2026-11-05T01:30:00+02:00', to: '2026-11-05T02:00:00+02:00', kind: 'maybe' },
      { from: '2026-11-05T02:00:00+02:00', to: '2026-11-05T04:30:00+02:00', kind: 'off' },
      { from: '2026-11-05T04:30:00+02:00', to: '2026-11-05T05:00:00+02:00', kind: 'maybe' },
    ])
  })

  it('lists all twelve groups', async () => {
    const s = await client().client.getSchedules('mykolaiv')
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
    expect(s.updatedAt).toMatch(/^2026-11-05T/)
  })

  it('reports the API as its one source, published when the rows last changed', async () => {
    const s = await client().client.getSchedules('mykolaiv')
    // the newest `series[].updated_at` (UTC in the API)
    expect(s.updatedAt).toBe('2026-11-05T21:32:43+02:00')
    expect(s.sources).toEqual([
      {
        id: 'api',
        url: 'https://off.energy.mk.ua/',
        ok: true,
        dates: ['2026-11-05', '2026-11-06'],
        updatedAt: '2026-11-05T21:32:43+02:00',
      },
    ])
    expect(assessFreshness(s, { now: NOW })).toMatchObject({
      state: 'fresh',
      tomorrow: 'published',
      issues: [],
    })
  })

  it('is stale when no day of the answer covers now', () => {
    const slots = JSON.parse(fixture('mykolaiv/time-series.json'))
    const queues = JSON.parse(fixture('mykolaiv/outage-queue-by-type-3.json'))
    const active = JSON.parse(fixture('mykolaiv/schedule-active-2026-11-05.json'))
    // the answer of 05.11 (days 05.11 and 06.11) still served on 07.11: days keep their own dates
    const now = new Date('2026-11-07T10:00:00+02:00')
    const s = parseActive(slots, queues, active, now)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
    const f = assessFreshness(s, { now })
    expect(f).toMatchObject({ state: 'stale', today: 'missing', coveredThrough: '2026-11-06' })
    expect(f.issues.map((i) => i.code)).toContain('behind')
  })

  it('treats an empty active list as nothing published: groups unknown, not "no outages"', () => {
    const slots = JSON.parse(fixture('mykolaiv/time-series.json'))
    const queues = JSON.parse(fixture('mykolaiv/outage-queue-by-type-3.json'))
    expectUnpublished(parseActive(slots, queues, [], NOW), queues.length)
  })

  it('rejects a broken time series', () => {
    expect(() => parseActive([], [], [], NOW)).toThrow(/48 slots/)
  })

  it('finds the group of a house through district and settlement', async () => {
    const m = await client().client.findGroup('mykolaiv', {
      city: 'Миколаїв',
      street: 'вул. Соборна',
      house: '1',
    })
    expect(m).toEqual({
      region: 'mykolaiv',
      group: '2.2',
      address: { city: 'м. Миколаїв', street: 'вул. Соборна', house: '1' },
      // outageType 2 = СГАВ; this house has no ГАВ queue
      emergency: { sgav: ['2'] },
    })
  })

  it('tells вулиця from площа with the same name', async () => {
    await expect(
      client().client.findGroup('mykolaiv', { city: 'Миколаїв', street: 'Соборна', house: '1' }),
    ).rejects.toThrow(/matches several/)
  })
})
