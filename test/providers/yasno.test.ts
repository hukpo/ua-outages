import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { parsePlanned } from '../../src/providers/yasno.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-05T23:30:00+02:00')
const API = 'app.yasno.ua/api/blackout-service/public/shutdowns'

function client() {
  const { fetch, calls } = mockFetch([
    { match: `${API}/regions/25/dsos/902/planned-outages`, body: fixture('yasno/planned-outages-25-902.json') },
    { match: `${API}/regions/3/dsos/301/planned-outages`, body: fixture('yasno/planned-outages-3-301.json') },
    { match: `${API}/addresses/v2/streets?regionId=25`, body: fixture('yasno/streets-kyiv-902-khresh.json') },
    { match: `${API}/addresses/v2/houses?regionId=25`, body: fixture('yasno/houses-kyiv-902-915.json') },
    { match: `${API}/addresses/v2/group?regionId=25`, body: fixture('yasno/group-kyiv-902-915-41296.json') },
    { match: `${API}/addresses/v2/cities?regionId=3`, body: fixture('yasno/cities-dnipro-301.json') },
    { match: `${API}/addresses/v2/streets?regionId=3`, body: fixture('yasno/streets-dnipro-301-city6-yavorn.json') },
    { match: `${API}/addresses/v2/houses?regionId=3`, body: fixture('yasno/houses-dnipro-301-city6-1587.json') },
    { match: `${API}/addresses/v2/group?regionId=3`, body: fixture('yasno/group-dnipro-301-city6-1587-85578.json') },
  ])
  return { client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0 }), calls }
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

  it('rejects a changed format', () => {
    expect(() => parsePlanned('kyiv', [] as never, NOW)).toThrow(/expected an object/)
    expect(() => parsePlanned('kyiv', { foo: 1 } as never, NOW)).toThrow(/no groups/)
  })

  it('finds a Kyiv group by address', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('kyiv', { street: 'Хрещатик', house: '6' })
    expect(m).toEqual({ region: 'kyiv', group: '20.1', address: { city: undefined, street: 'вул. Хрещатик', house: '6' } })
    expect(calls.find((x) => x.url.includes('/streets'))!.url).toContain('query=%D0%A5%D1%80%D0%B5%D1%89%D0%B0%D1%82%D0%B8%D0%BA')
  })

  it('finds a Dnipro group through the city', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('dnipro', { city: 'Дніпро', street: 'просп. Дмитра Яворницького', house: '41' })
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
    await expect(client().client.findGroup('dnipro', { street: 'Яворницького', house: '41' })).rejects.toThrow(
      /specify a city/,
    )
  })
})
