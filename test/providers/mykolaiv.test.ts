import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { parseActive } from '../../src/providers/mykolaiv.js'
import { fixture, mockFetch } from '../helpers.js'

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
    { match: `${API}/addr/dom/121142/outage-queue`, body: fixture('mykolaiv/addr-dom-121142-outage-queue.json') },
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
    expect(s.groups).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'])
    expect(s.updatedAt).toMatch(/^2026-11-05T/)
  })

  it('treats an empty active list as no schedule', () => {
    const slots = JSON.parse(fixture('mykolaiv/time-series.json'))
    const queues = JSON.parse(fixture('mykolaiv/outage-queue-by-type-3.json'))
    expect(parseActive(slots, queues, [], NOW).groups).toEqual([])
  })

  it('rejects a broken time series', () => {
    expect(() => parseActive([], [], [], NOW)).toThrow(/48 slots/)
  })

  it('finds the group of a house through district and settlement', async () => {
    const m = await client().client.findGroup('mykolaiv', { city: 'Миколаїв', street: 'вул. Соборна', house: '1' })
    expect(m).toEqual({
      region: 'mykolaiv',
      group: '2.2',
      address: { city: 'м. Миколаїв', street: 'вул. Соборна', house: '1' },
    })
  })

  it('tells вулиця from площа with the same name', async () => {
    await expect(
      client().client.findGroup('mykolaiv', { city: 'Миколаїв', street: 'Соборна', house: '1' }),
    ).rejects.toThrow(/matches several/)
  })
})
