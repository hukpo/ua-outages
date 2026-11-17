import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { assessFreshness } from '../../src/freshness.js'
import { parseVinnytsiaMirror, VINNYTSIA_MIRROR_ID } from '../../src/providers/vinnytsia.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-17T14:40:00+02:00')
const MIRROR = 'raw.githubusercontent.com/vn-progr/gpv-voe-vinnytsia'
const FILE = fixture('vinnytsia/mirror-2026-11-17T1425.trimmed.json')
const file = (patch: (f: Record<string, any>) => void = () => {}) => {
  const f = JSON.parse(FILE)
  patch(f)
  return f
}
const client = (body = FILE, unofficialSources = true) => {
  const { fetch, calls } = mockFetch([{ match: MIRROR, body }])
  return { client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, unofficialSources }), calls }
}

describe('Vinnytsia: no official source', () => {
  it('reads nothing by default: no schedule capability, `unsupported`, and no request', async () => {
    const { client: c, calls } = client(FILE, false)
    expect(c.region('vinnytsia').capabilities).toMatchObject({ schedule: false, addressSearch: false })
    await expect(c.getSchedules('vinnytsia')).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringMatching(/unofficialSources: true/),
    })
    expect(calls).toHaveLength(0)
    const health = await c.healthCheck({ regions: ['vinnytsia'] })
    expect(health.ok).toBe(true)
    expect(health.regions[0]).toMatchObject({ status: 'empty', groups: 0 })
  })
})

describe('Vinnytsia: the community mirror, with `unofficialSources`', () => {
  it('reads the hours per queue and marks the source as not official', async () => {
    const { client: c } = client()
    expect(c.region('vinnytsia').capabilities.schedule).toBe(true)
    const s = await c.getSchedules('vinnytsia')
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['2.1']![0]).toEqual({
      date: '2026-11-17',
      status: 'scheduled',
      intervals: [
        { from: '2026-11-17T06:00:00+02:00', to: '2026-11-17T08:00:00+02:00', kind: 'off' },
        { from: '2026-11-17T18:00:00+02:00', to: '2026-11-17T20:00:00+02:00', kind: 'off' },
      ],
    })
    expect(s.sources).toEqual([
      {
        id: VINNYTSIA_MIRROR_ID,
        url: 'https://github.com/vn-progr/gpv-voe-vinnytsia',
        ok: true,
        official: false,
        dates: ['2026-11-17'],
        // the file's own time is when the mirror ran, not when the operator changed anything
        updatedAt: null,
      },
    ])
    expect(s.updatedAt).toBeNull()
  })

  it('a day with no outage in any queue is unknown, not "no outages"', async () => {
    // the mirror's tomorrow before the operator has published it: every hour "yes"
    const s = await client().client.getSchedules('vinnytsia')
    for (const g of s.groups) expect(s.schedules[g]!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(assessFreshness(s, { now: NOW })).toMatchObject({ today: 'published', tomorrow: 'missing' })
    // and when today is like that too, nothing is known
    const empty = file((f) => {
      for (const day of Object.values<Record<string, Record<string, string>>>(f.fact.data))
        for (const g of Object.values(day)) for (const h of Object.keys(g)) g[h] = 'yes'
    })
    const all = await client(JSON.stringify(empty)).client.getSchedules('vinnytsia')
    expect(all.groups).toHaveLength(12)
    for (const g of all.groups)
      expect(all.schedules[g]).toEqual([{ date: '2026-11-17', status: 'unknown', intervals: [] }])
  })

  it('refuses a mirror that stopped being rebuilt, failed its last run or changed its format', () => {
    expect(() => parseVinnytsiaMirror(file(), new Date('2026-11-17T18:00:00+02:00'))).toThrow(
      /not rebuilt since 2026-11-17T14:25/,
    )
    expect(() =>
      parseVinnytsiaMirror(
        file((f) => delete f.lastUpdated),
        NOW,
      ),
    ).toThrow(/time of its last run/)
    expect(() =>
      parseVinnytsiaMirror(
        file((f) => (f.lastUpdateStatus = { ok: false, message: 'HTTP 503' })),
        NOW,
      ),
    ).toThrow(/last run failed \(HTTP 503\)/)
    expect(() =>
      parseVinnytsiaMirror(
        file((f) => delete f.fact),
        NOW,
      ),
    ).toThrow(/format changed/)
    expect(() => parseVinnytsiaMirror(null, NOW)).toThrow(/format changed/)
  })

  it('a stale mirror is a `parse` error of the region, never yesterday shown as today', async () => {
    const { fetch } = mockFetch([{ match: MIRROR, body: FILE }])
    const late = new OutageClient({
      fetch,
      now: () => new Date('2026-11-18T09:00:00+02:00'),
      cacheTtlMs: 0,
      unofficialSources: true,
    })
    await expect(late.getSchedules('vinnytsia')).rejects.toMatchObject({ code: 'parse' })
  })
})
