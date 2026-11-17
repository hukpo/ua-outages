import { describe, expect, it } from 'vitest'
import { OutageClient } from '../src/client.js'
import { OutageError } from '../src/errors.js'
import { decideHouseStatus, type HouseStatusInputs } from '../src/house-status.js'
import type { Provider } from '../src/providers/provider.js'
import type { DaySchedule, EmergencyStatus, GroupMatch, HouseOutage, RegionSchedule } from '../src/types.js'

const NOW = new Date('2026-11-17T22:40:00+02:00')
const iv = (from: string, to: string, kind: 'off' | 'maybe' = 'off') => ({
  from: `2026-11-${from}:00+02:00`,
  to: `2026-11-${to}:00+02:00`,
  kind,
})
const DAYS: DaySchedule[] = [
  {
    date: '2026-11-17',
    status: 'scheduled',
    intervals: [
      iv('17T08:00', '17T11:00'),
      iv('17T22:00', '18T00:00'),
      iv('17T21:30', '17T22:00', 'maybe'),
    ].sort((a, b) => a.from.localeCompare(b.from)),
  },
  {
    date: '2026-11-18',
    status: 'scheduled',
    intervals: [iv('18T00:00', '18T01:30'), iv('18T09:00', '18T12:00')],
  },
]
const MATCH: GroupMatch = {
  region: 'dnipro',
  group: '1.2',
  address: { city: 'м. Дніпро', street: 'вул. Бетховена', house: '32' },
  emergency: { gav: ['3'] },
}
const OUTAGE: HouseOutage = {
  region: 'dnipro',
  address: { city: 'м. Дніпро', street: 'вул. Бетховена', house: '32' },
  kind: 'emergency',
  reason: 'Екстренні відключення (Аварійне без застосування графіку погодинних відключень)',
  scheduleApplies: false,
  from: '2026-11-16T10:40:00+02:00',
  to: '2026-11-18T00:25:00+02:00',
  groups: ['1.2'],
  updatedAt: null,
  url: 'https://www.dtek-dnem.com.ua/ua/shutdowns',
  fetchedAt: '2026-11-17T22:40:00+02:00',
}
const emergency = (o: Partial<EmergencyStatus> = {}): EmergencyStatus => ({
  region: 'dnipro',
  state: 'active',
  kind: 'gav',
  scheduleApplies: null,
  since: '2026-11-17T20:00:00+02:00',
  endedAt: null,
  queues: null,
  queueCount: null,
  area: null,
  inferred: false,
  message: null,
  source: 'telegram',
  fetchedAt: '2026-11-17T22:40:00+02:00',
  ...o,
})
const inputs = (o: Partial<HouseStatusInputs> = {}): HouseStatusInputs => ({
  region: 'dnipro',
  now: new Date('2026-11-17T15:00:00+02:00'),
  match: MATCH,
  outage: null,
  emergency: emergency({ state: 'inactive', kind: null, since: null }),
  days: DAYS,
  gaps: [],
  ...o,
})

describe('decideHouseStatus', () => {
  it("the house's own record wins over everything", () => {
    const s = decideHouseStatus(inputs({ outage: OUTAGE }))
    expect(s).toMatchObject({ state: 'off', basis: 'house-outage', until: '2026-11-18T00:25:00+02:00' })
    // the schedule says on at 15:00, the region's emergency is over: the house is still off
    expect(s.scheduled).toBeNull()
    expect(s.houseOutage).toBe(OUTAGE)
  })

  it('the schedule: on, with the next outage', () => {
    expect(decideHouseStatus(inputs())).toMatchObject({
      state: 'on',
      basis: 'schedule',
      until: null,
      groups: ['1.2'],
      scheduled: null,
      nextOutage: { from: '2026-11-17T22:00:00+02:00', to: '2026-11-18T01:30:00+02:00' },
    })
  })

  it('an outage now runs on past midnight when tomorrow continues it', () => {
    expect(decideHouseStatus(inputs({ now: NOW }))).toMatchObject({
      state: 'off',
      basis: 'schedule',
      until: '2026-11-18T01:30:00+02:00',
      scheduled: { from: '2026-11-17T22:00:00+02:00', kind: 'off' },
      nextOutage: { from: '2026-11-18T09:00:00+02:00' },
    })
  })

  it('a "possible" half hour is maybe', () => {
    expect(decideHouseStatus(inputs({ now: new Date('2026-11-17T21:45:00+02:00') }))).toMatchObject({
      state: 'maybe',
      basis: 'schedule',
      until: '2026-11-17T22:00:00+02:00',
    })
  })

  it('today not published is unknown, never on', () => {
    expect(decideHouseStatus(inputs({ days: [] }))).toMatchObject({ state: 'unknown', basis: 'none' })
    expect(decideHouseStatus(inputs({ days: null }))).toMatchObject({ state: 'unknown', basis: 'none' })
    expect(
      decideHouseStatus(inputs({ days: [{ date: '2026-11-17', status: 'unknown', intervals: [] }] })),
    ).toMatchObject({ state: 'unknown' })
    // the schedule itself marks the day as emergency
    expect(
      decideHouseStatus(inputs({ days: [{ date: '2026-11-17', status: 'emergency', intervals: [] }] })),
    ).toMatchObject({ state: 'maybe', basis: 'emergency' })
  })

  describe('a ГАВ in force', () => {
    it('queues not named: maybe, though the schedule has the house on', () => {
      expect(decideHouseStatus(inputs({ emergency: emergency() }))).toMatchObject({
        state: 'maybe',
        basis: 'emergency',
        until: null,
      })
    })

    it("the house's queue among the named ones: off", () => {
      expect(decideHouseStatus(inputs({ emergency: emergency({ queues: ['1', '2', '3'] }) }))).toMatchObject({
        state: 'off',
        basis: 'emergency',
      })
    })

    it("named, and the house's queue isn't among them: back to the schedule", () => {
      expect(decideHouseStatus(inputs({ emergency: emergency({ queues: ['6', '7'] }) }))).toMatchObject({
        state: 'on',
        basis: 'schedule',
      })
    })

    it('named, but only for an area: maybe', () => {
      expect(
        decideHouseStatus(inputs({ emergency: emergency({ queues: ['6'], area: 'м. Дніпро' }) })),
      ).toMatchObject({ state: 'maybe', basis: 'emergency' })
    })

    it("СГАВ is matched with the house's СГАВ queue", () => {
      const match = { ...MATCH, emergency: { gav: ['3'], sgav: ['2'] } }
      const sgav = (queues: string[]) =>
        decideHouseStatus(inputs({ match, emergency: emergency({ kind: 'sgav', queues }) })).state
      expect(sgav(['2'])).toBe('off')
      expect(sgav(['3'])).toBe('on')
    })

    it("the house's emergency queue unknown: maybe", () => {
      const match = { ...MATCH, emergency: undefined }
      expect(decideHouseStatus(inputs({ match, emergency: emergency({ queues: ['3'] }) })).state).toBe(
        'maybe',
      )
    })

    it('the schedule still applies alongside and has the house off: off by the schedule', () => {
      expect(
        decideHouseStatus(inputs({ now: NOW, emergency: emergency({ scheduleApplies: true }) })),
      ).toMatchObject({ state: 'off', basis: 'schedule' })
      expect(
        decideHouseStatus(inputs({ now: NOW, emergency: emergency({ scheduleApplies: false }) })),
      ).toMatchObject({ state: 'maybe', basis: 'emergency' })
    })
  })

  it('without the address lookup, the groups and address come from the house record', () => {
    expect(decideHouseStatus(inputs({ match: null, outage: OUTAGE, days: null }))).toMatchObject({
      state: 'off',
      groups: ['1.2'],
      address: OUTAGE.address,
    })
    expect(decideHouseStatus(inputs({ match: null, days: null }))).toMatchObject({
      state: 'unknown',
      groups: [],
      address: null,
    })
  })
})

/** A region with every part, each one controllable */
function fakeRegion(o: {
  outage?: HouseOutage | null | Error
  emergency?: EmergencyStatus | Error | false
  houseOutage?: boolean
  group?: GroupMatch | Error
  schedule?: RegionSchedule | Error
}): Provider {
  const fail = <T>(v: T | Error): T => {
    if (v instanceof Error) throw v
    return v
  }
  const schedule: RegionSchedule = {
    region: 'dnipro',
    groups: ['1.2'],
    schedules: { '1.2': DAYS },
    updatedAt: null,
    fetchedAt: '2026-11-17T22:40:00+02:00',
  }
  return {
    info: {
      id: 'dnipro',
      name: 'Test',
      operator: 'Test',
      website: 'https://example.com/',
      capabilities: { schedule: true, addressSearch: true },
    },
    sampleAddress: { street: 'Бетховена', house: '32' },
    getSchedules: async () => fail(o.schedule ?? schedule),
    searchStreets: async () => [{ id: 's1', name: 'вул. Бетховена' }],
    searchHouses: async () => [{ id: 'h32', number: '32', streetId: 's1' }],
    groupOf: async () => fail(o.group ?? MATCH),
    ...(o.houseOutage === false ? {} : { outageOf: async () => fail(o.outage ?? null) }),
    ...(o.emergency === false
      ? {}
      : {
          getEmergency: async () =>
            fail(
              (o.emergency as EmergencyStatus | Error | undefined) ??
                emergency({ state: 'inactive', kind: null, since: null }),
            ),
        }),
  }
}
const ADDRESS = { street: 'Бетховена', house: '32' }
const client = (p: Provider, now = NOW) => new OutageClient({ providers: [p], now: () => now, cacheTtlMs: 0 })

describe('getHouseStatus', () => {
  it('Dnipro, 17.11 evening: the region back on the schedule, the house still off', async () => {
    const s = await client(
      fakeRegion({ outage: OUTAGE }),
      new Date('2026-11-17T15:00:00+02:00'),
    ).getHouseStatus('dnipro', ADDRESS)
    expect(s).toMatchObject({
      region: 'dnipro',
      address: MATCH.address,
      state: 'off',
      basis: 'house-outage',
      until: '2026-11-18T00:25:00+02:00',
      groups: ['1.2'],
      gaps: [],
      fetchedAt: '2026-11-17T15:00:00+02:00',
    })
    expect(s.emergency?.state).toBe('inactive')
  })

  it('parts a region lacks or that fail are gaps; the answer comes from the rest', async () => {
    const s = await client(
      fakeRegion({
        houseOutage: false,
        emergency: new OutageError('network', 'channel down', { region: 'dnipro' }),
      }),
    ).getHouseStatus('dnipro', ADDRESS)
    expect(s).toMatchObject({ state: 'off', basis: 'schedule', houseOutage: null, emergency: null })
    expect(s.gaps).toEqual([
      { part: 'house-outage', code: 'unsupported', message: 'the operator publishes no per-house status' },
      { part: 'emergency', code: 'network', message: 'channel down' },
    ])
  })

  it('a schedule that fails leaves the state unknown, not on', async () => {
    const s = await client(
      fakeRegion({ schedule: new OutageError('blocked', 'bot check', { region: 'dnipro' }) }),
      new Date('2026-11-17T15:00:00+02:00'),
    ).getHouseStatus('dnipro', ADDRESS)
    expect(s).toMatchObject({
      state: 'unknown',
      basis: 'none',
      gaps: [{ part: 'schedule', code: 'blocked' }],
    })
  })

  it('a group the schedule lacks is a gap', async () => {
    const s = await client(fakeRegion({ group: { ...MATCH, group: '6.2' } })).getHouseStatus(
      'dnipro',
      ADDRESS,
    )
    expect(s).toMatchObject({ state: 'unknown', gaps: [{ part: 'schedule', code: 'not-found' }] })
  })

  it('an address nobody finds is not-found, as for findGroup', async () => {
    const p = fakeRegion({ houseOutage: false })
    const c = client({ ...p, searchHouses: async () => [] })
    await expect(c.getHouseStatus('dnipro', ADDRESS)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('a house the lookup gives no group but whose record answers: no throw', async () => {
    const s = await client(
      fakeRegion({ group: new OutageError('not-found', 'no group', { region: 'dnipro' }), outage: OUTAGE }),
    ).getHouseStatus('dnipro', ADDRESS)
    expect(s).toMatchObject({ state: 'off', basis: 'house-outage', groups: ['1.2'] })
  })

  it('a bug is thrown, not hidden in gaps', async () => {
    const s = fakeRegion({ emergency: new TypeError('oops') })
    await expect(client(s).getHouseStatus('dnipro', ADDRESS)).rejects.toThrow(TypeError)
  })

  it('cancelled: rejects with the reason', async () => {
    const ctl = new AbortController()
    ctl.abort(new Error('stop'))
    await expect(
      client(fakeRegion({})).getHouseStatus('dnipro', ADDRESS, { signal: ctl.signal }),
    ).rejects.toThrow('stop')
  })
})

describe('healthCheck({ houseOutage: true })', () => {
  it('runs getHouseOutage with the sample address; an empty record is fine', async () => {
    const r = await client(fakeRegion({}), new Date('2026-11-17T15:00:00+02:00')).healthCheck({
      houseOutage: true,
    })
    expect(r.regions[0]!.houseOutage).toEqual({ ok: true, kind: null })
    expect(r.ok).toBe(true)
    const off = await client(fakeRegion({ outage: OUTAGE })).healthCheck({ houseOutage: true })
    expect(off.regions[0]!.houseOutage).toEqual({ ok: true, kind: 'emergency' })
  })

  it('a failing per-house source fails the report', async () => {
    const r = await client(
      fakeRegion({ outage: new OutageError('parse', 'site changed', { region: 'dnipro' }) }),
    ).healthCheck({ houseOutage: true })
    expect(r.regions[0]!.houseOutage).toEqual({ ok: false, message: 'site changed' })
    expect(r.ok).toBe(false)
  })

  it('not asked, or not supported: not run', async () => {
    expect((await client(fakeRegion({})).healthCheck()).regions[0]!.houseOutage).toBeUndefined()
    expect(
      (await client(fakeRegion({ houseOutage: false })).healthCheck({ houseOutage: true })).regions[0]!
        .houseOutage,
    ).toBeUndefined()
  })
})

/** Cases the review of 0.4.8 found (five testers: Claude and GPT, mocks and live) */
describe('decideHouseStatus: review of 0.4.8', () => {
  const at = (hhmm: string) => new Date(`2026-11-17T${hhmm}:00+02:00`)
  const day = (status: DaySchedule['status'], intervals = [iv('17T10:00', '17T12:00')]): DaySchedule => ({
    date: '2026-11-17',
    status,
    intervals,
  })

  it('only a day published as scheduled gives its slots a say', () => {
    const now = at('11:00')
    expect(decideHouseStatus(inputs({ now, days: [day('emergency')] }))).toMatchObject({
      state: 'maybe',
      basis: 'emergency',
      scheduled: null,
    })
    expect(decideHouseStatus(inputs({ now, days: [day('unknown')] }))).toMatchObject({ state: 'unknown' })
    expect(decideHouseStatus(inputs({ now, days: [day('no-outages')] }))).toMatchObject({ state: 'on' })
  })

  it('an outage runs past midnight only into a published tomorrow; the next outage too', () => {
    const tomorrow = (status: DaySchedule['status']): DaySchedule => ({
      date: '2026-11-18',
      status,
      intervals: [iv('18T00:00', '18T05:00')],
    })
    const today = day('scheduled', [iv('17T23:00', '18T00:00')])
    expect(decideHouseStatus(inputs({ now: at('23:30'), days: [today, tomorrow('unknown')] })).until).toBe(
      '2026-11-18T00:00:00+02:00',
    )
    expect(decideHouseStatus(inputs({ now: at('23:30'), days: [today, tomorrow('scheduled')] })).until).toBe(
      '2026-11-18T05:00:00+02:00',
    )
    const clear = day('scheduled', [])
    expect(
      decideHouseStatus(inputs({ now: at('15:00'), days: [clear, tomorrow('unknown')] })).nextOutage,
    ).toBeNull()
  })

  it('no on when a part the region has failed, or the emergency is unknown', () => {
    const now = at('15:00')
    const gap = (part: 'house-outage' | 'emergency', code: 'network' | 'unsupported') => [
      { part, code, message: 'x' },
    ]
    expect(decideHouseStatus(inputs({ now, gaps: gap('house-outage', 'network') }))).toMatchObject({
      state: 'unknown',
      basis: 'none',
    })
    expect(decideHouseStatus(inputs({ now, emergency: null, gaps: gap('emergency', 'network') })).state).toBe(
      'unknown',
    )
    expect(decideHouseStatus(inputs({ now, emergency: emergency({ state: 'unknown' }) })).state).toBe(
      'unknown',
    )
    // a part the region simply doesn't have is no doubt
    expect(decideHouseStatus(inputs({ now, gaps: gap('house-outage', 'unsupported') })).state).toBe('on')
    // an outage still shows: doubt only stops `on`
    expect(decideHouseStatus(inputs({ now: NOW, gaps: gap('house-outage', 'network') })).state).toBe('off')
  })

  it('a ГАВ with unnamed queues: the schedule decides only when the operator says it still applies', () => {
    expect(
      decideHouseStatus(inputs({ now: NOW, emergency: emergency({ scheduleApplies: null }) })),
    ).toMatchObject({
      state: 'maybe',
      basis: 'emergency',
    })
  })

  it('a ГАВ that leaves the house out while the schedule is suspended: nothing has it off', () => {
    expect(
      decideHouseStatus(
        inputs({ now: NOW, emergency: emergency({ queues: ['6'], scheduleApplies: false }) }),
      ),
    ).toMatchObject({ state: 'on', basis: 'emergency' })
  })

  it('an empty queue list names nothing', () => {
    expect(decideHouseStatus(inputs({ emergency: emergency({ queues: [] }) })).state).toBe('maybe')
  })
})

describe('getHouseStatus: review of 0.4.8', () => {
  it('`fresh` reaches the address lookup', async () => {
    const seen: (boolean | undefined)[] = []
    const p = fakeRegion({})
    const c = client({
      ...p,
      groupOf: async (ctx, ...rest) => {
        seen.push(ctx.fresh)
        return p.groupOf!(ctx, ...rest)
      },
    })
    await c.getHouseStatus('dnipro', ADDRESS, { fresh: true })
    expect(seen).toEqual([true])
  })

  it('a last good schedule is not taken for now: the failure is a gap', async () => {
    let fail = false
    const p = fakeRegion({})
    const c = new OutageClient({
      providers: [
        {
          ...p,
          getSchedules: async (ctx) => {
            if (fail) throw new OutageError('network', 'down', { region: 'dnipro' })
            return p.getSchedules(ctx)
          },
        },
      ],
      now: () => new Date('2026-11-17T15:00:00+02:00'),
      cacheTtlMs: 0,
      staleIfError: true,
    })
    expect((await c.getHouseStatus('dnipro', ADDRESS)).state).toBe('on')
    fail = true
    expect(await c.getHouseStatus('dnipro', ADDRESS)).toMatchObject({
      state: 'unknown',
      gaps: [{ part: 'schedule', code: 'network' }],
    })
  })

  it('the group from the house record when the lookup has none: its schedule is read', async () => {
    const s = await client(
      fakeRegion({ group: new OutageError('network', 'down', { region: 'dnipro' }), outage: OUTAGE }),
      new Date('2026-11-17T15:00:00+02:00'),
    ).getHouseStatus('dnipro', ADDRESS)
    expect(s.nextOutage?.from).toBe('2026-11-17T22:00:00+02:00')
  })

  it('a region whose only lookup is the house record: a typo is not-found', async () => {
    const p = fakeRegion({})
    const { groupOf: _, ...withoutGroups } = p
    const c = client({ ...withoutGroups, searchHouses: async () => [] })
    await expect(c.getHouseStatus('dnipro', ADDRESS)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('healthCheck: a probe rejecting with something not an Error is reported, not thrown', async () => {
    const p = fakeRegion({})
    const c = client({
      ...p,
      outageOf: () => Promise.reject(undefined), // eslint-disable-line prefer-promise-reject-errors
    })
    const r = await c.healthCheck({ houseOutage: true })
    expect(r.regions[0]!.houseOutage).toEqual({ ok: false, message: 'undefined' })
  })
})
