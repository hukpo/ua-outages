import { describe, expect, it } from 'vitest'
import { OutageClient } from '../src/client.js'
import type { Provider } from '../src/providers/provider.js'
import { cellsToIntervals, makeDay, slotsToIntervals, unpublished } from '../src/schedule.js'
import type { DaySchedule, Interval, RegionSchedule } from '../src/types.js'
import { validateSchedule } from '../src/validate.js'

const NOW = new Date('2026-11-05T10:00:00+02:00')
const D = '2026-11-05'

function schedule(
  days: unknown[] = [makeDay(D, [{ start: 480, end: 720, kind: 'off' }])],
  over: object = {},
) {
  return {
    region: 'kyiv',
    groups: ['1.1'],
    schedules: { '1.1': days },
    updatedAt: '2026-11-05T07:00:00+02:00',
    fetchedAt: '2026-11-05T10:00:00+02:00',
    ...over,
  } as unknown as RegionSchedule
}
const withIntervals = (intervals: unknown[], date = D, status = 'scheduled') =>
  schedule([{ date, status, intervals }])
const iv = (from: string, to: string, kind = 'off') => ({ from, to, kind })
const check = (s: RegionSchedule) => () => validateSchedule(s, 'kyiv', NOW)

describe('validateSchedule', () => {
  it('accepts well-formed schedules', () => {
    expect(check(schedule())).not.toThrow()
    expect(check(schedule([], { updatedAt: null }))).not.toThrow()
    expect(check({ ...unpublished('kyiv', ['1.1', '1.2'], NOW) })).not.toThrow()
    expect(check(schedule([], { groups: [], schedules: {} }))).not.toThrow()
    // a whole day off ends at the next midnight; UTC spellings are instants like any other
    expect(check(schedule([makeDay(D, [{ start: 0, end: 1440, kind: 'off' }])]))).not.toThrow()
    expect(
      check(withIntervals([iv('2026-11-04T22:00:00Z', '2026-11-05T22:00:00.000Z', 'maybe')])),
    ).not.toThrow()
    // touching intervals of different kinds
    expect(
      check(
        withIntervals([
          iv(`${D}T08:00:00+02:00`, `${D}T09:00:00+02:00`),
          iv(`${D}T09:00:00+02:00`, `${D}T10:00:00+02:00`, 'maybe'),
        ]),
      ),
    ).not.toThrow()
    // YASNO's preliminary schedule: unknown with intervals; emergency with or without
    expect(check(schedule([makeDay(D, [{ start: 0, end: 60, kind: 'maybe' }], 'unknown')]))).not.toThrow()
    expect(check(schedule([makeDay(D, [], 'emergency')]))).not.toThrow()
    // provenance fields don't get in the way
    expect(
      check(
        schedule(undefined, { sources: [{ id: 'site', url: null, ok: true, dates: [D], updatedAt: null }] }),
      ),
    ).not.toThrow()
  })

  it('names the region and the first violation in a parse error', () => {
    expect(check(schedule(undefined, { region: 'lviv' }))).toThrow(
      expect.objectContaining({
        name: 'OutageError',
        code: 'parse',
        message: 'kyiv: the provider returned an invalid schedule: region is "lviv"',
        details: { region: 'kyiv' },
      }),
    )
  })

  it.each<[string, RegionSchedule, RegExp]>([
    ['nothing', null as unknown as RegionSchedule, /not an object/],
    ['a missing fetchedAt', schedule(undefined, { fetchedAt: undefined }), /fetchedAt is undefined/],
    ['a fetchedAt that is not a date', schedule(undefined, { fetchedAt: 'now' }), /fetchedAt is "now"/],
    [
      'an updatedAt that is not a date',
      schedule(undefined, { updatedAt: '05.11.2026 07:00' }),
      /updatedAt is/,
    ],
    [
      'an updatedAt without a zone',
      schedule(undefined, { updatedAt: '2026-11-05T07:00:00' }),
      /updatedAt is/,
    ],
    [
      'an updatedAt far in the future',
      schedule(undefined, { updatedAt: '2026-11-06T10:00:01+02:00' }),
      /in the future/,
    ],
    ['groups that are not a list', schedule(undefined, { groups: '1.1' }), /groups is not a list/],
    ['schedules that is a list', schedule(undefined, { schedules: [] }), /schedules is not an object/],
    ['a repeated group', schedule(undefined, { groups: ['1.1', '1.1'] }), /group 1.1 is listed twice/],
    ['an empty group name', schedule(undefined, { groups: ['1.1', ''] }), /group "" is not a name/],
    ['a group without days', schedule(undefined, { groups: ['1.1', '1.2'] }), /group 1.2 has no days/],
    ['a schedule of an unlisted group', schedule(undefined, { groups: [] }), /schedules has group 1.1/],
    ['a day that is not an object', schedule([null]), /a day that is not an object/],
    [
      'a date in another format',
      schedule([makeDay('2026-11-05', [])].map((d) => ({ ...d, date: '05.11.2026' }))),
      /has the date "05.11.2026"/,
    ],
    ['a date that does not exist', withIntervals([], '2026-02-30'), /has the date "2026-02-30"/],
    ['a repeated date', schedule([makeDay(D, []), makeDay(D, [])]), /2026-11-05: the date is listed twice/],
    ['an unknown status', withIntervals([], D, 'off'), /status is "off"/],
    [
      'intervals that are not a list',
      schedule([{ date: D, status: 'scheduled' }]),
      /intervals is not a list/,
    ],
    [
      'a no-outages day with intervals',
      withIntervals([iv(`${D}T08:00:00+02:00`, `${D}T09:00:00+02:00`)], D, 'no-outages'),
      /no-outages day has intervals/,
    ],
    ['an interval that is not ISO', withIntervals([iv('08:00', '09:00')]), /is not ISO/],
    ['an interval without a zone', withIntervals([iv(`${D}T08:00:00`, `${D}T09:00:00`)]), /is not ISO/],
    [
      'an unknown kind',
      withIntervals([iv(`${D}T08:00:00+02:00`, `${D}T09:00:00+02:00`, 'on')]),
      /kind is "on"/,
    ],
    [
      'an interval that ends before it starts',
      withIntervals([iv(`${D}T09:00:00+02:00`, `${D}T08:00:00+02:00`)]),
      /doesn't end after it starts/,
    ],
    [
      'an empty interval',
      withIntervals([iv(`${D}T09:00:00+02:00`, `${D}T09:00:00+02:00`)]),
      /doesn't end after it starts/,
    ],
    [
      'an interval that starts the day before',
      withIntervals([iv('2026-11-04T23:00:00+02:00', `${D}T01:00:00+02:00`)]),
      /outside its day/,
    ],
    [
      'an interval that runs past midnight',
      withIntervals([iv(`${D}T23:00:00+02:00`, '2026-11-06T00:30:00+02:00')]),
      /outside its day/,
    ],
    [
      'an interval of another day',
      withIntervals([iv('2026-11-06T08:00:00+02:00', '2026-11-06T09:00:00+02:00')]),
      /outside its day/,
    ],
    [
      'overlapping intervals',
      withIntervals([
        iv(`${D}T08:00:00+02:00`, `${D}T10:00:00+02:00`),
        iv(`${D}T09:00:00+02:00`, `${D}T11:00:00+02:00`),
      ]),
      /overlaps/,
    ],
    [
      'unsorted intervals',
      withIntervals([
        iv(`${D}T10:00:00+02:00`, `${D}T11:00:00+02:00`),
        iv(`${D}T08:00:00+02:00`, `${D}T09:00:00+02:00`),
      ]),
      /out of order/,
    ],
  ])('rejects %s', (_name, s, message) => {
    expect(check(s)).toThrow(message)
    expect(check(s)).toThrow(expect.objectContaining({ code: 'parse' }))
  })

  it('allows updatedAt up to a day ahead of the clock', () => {
    expect(check(schedule(undefined, { updatedAt: '2026-11-06T10:00:00+02:00' }))).not.toThrow()
  })

  describe('days when the clocks change', () => {
    const hours = (i: Interval) => (Date.parse(i.to) - Date.parse(i.from)) / 3600_000
    const day = (date: string, intervals: Interval[]): DaySchedule => ({
      date,
      status: 'scheduled',
      intervals,
    })

    it('accepts the 25-hour day in October, whole and in hourly cells', () => {
      const date = '2026-10-25'
      const whole = slotsToIntervals(date, [{ start: 0, end: 1440, kind: 'off' }])
      expect(whole).toEqual([
        { from: '2026-10-25T00:00:00+03:00', to: '2026-10-26T00:00:00+02:00', kind: 'off' },
      ])
      expect(hours(whole[0]!)).toBe(25)
      expect(check(schedule([day(date, whole)]))).not.toThrow()
      const everyOther = cellsToIntervals(
        date,
        Array.from({ length: 24 }, (_, i) => (i % 2 ? 'off' : null)),
      )
      expect(everyOther).toHaveLength(12)
      expect(check(schedule([day(date, everyOther)]))).not.toThrow()
      // 25 h and a minute is past the day's end
      expect(
        check(
          schedule([day(date, [iv('2026-10-25T00:00:00+03:00', '2026-10-26T00:01:00+02:00') as Interval])]),
        ),
      ).toThrow(/outside its day/)
    })

    it('accepts the 23-hour day in March, and drops the hour that does not exist', () => {
      const date = '2026-03-29'
      const whole = slotsToIntervals(date, [{ start: 0, end: 1440, kind: 'off' }])
      expect(whole).toEqual([
        { from: '2026-03-29T00:00:00+02:00', to: '2026-03-30T00:00:00+03:00', kind: 'off' },
      ])
      expect(hours(whole[0]!)).toBe(23)
      expect(check(schedule([day(date, whole)]))).not.toThrow()
      // 03:00–04:00 is skipped by the clocks: no empty interval comes out of it
      expect(slotsToIntervals(date, [{ start: 180, end: 240, kind: 'off' }])).toEqual([])
      const cells = cellsToIntervals(
        date,
        Array.from({ length: 24 }, (_, i) => (i % 2 ? 'off' : null)),
      )
      expect(cells.every((i) => hours(i) === 1)).toBe(true)
      expect(cells).toHaveLength(11)
      expect(check(schedule([day(date, cells)]))).not.toThrow()
      // the last hour before midnight still ends at midnight
      expect(check(schedule([makeDay(date, [{ start: 1380, end: 1440, kind: 'maybe' }])]))).not.toThrow()
    })
  })
})

describe('the client validates what providers return', () => {
  const provider = (result: () => RegionSchedule): Provider => ({
    info: {
      id: 'kyiv',
      name: 'Київ',
      operator: 'Test',
      website: 'https://example.com',
      capabilities: { schedule: true, addressSearch: false },
    },
    getSchedules: async () => result(),
  })

  it('throws parse for garbage from a custom provider, and does not cache it', async () => {
    let n = 0
    const client = new OutageClient({
      now: () => NOW,
      providers: [provider(() => (n++ === 0 ? withIntervals([iv('25:00', '26:00')]) : schedule()))],
    })
    await expect(client.getSchedules('kyiv')).rejects.toMatchObject({
      code: 'parse',
      message: expect.stringMatching(
        /^kyiv: the provider returned an invalid schedule: group 1.1, 2026-11-05: interval/,
      ),
    })
    await expect(client.getSchedule('kyiv', '1.1')).resolves.toMatchObject({ group: '1.1' })
  })

  it('reports it as an error in the health check', async () => {
    const client = new OutageClient({
      now: () => NOW,
      providers: [provider(() => schedule(undefined, { region: 'lviv' }))],
    })
    const report = await client.healthCheck()
    expect(report.ok).toBe(false)
    expect(report.regions[0]).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/^parse: kyiv: the provider returned/),
    })
  })

  it('judges "in the future" by the later of its clock and the system clock', async () => {
    // a clock set back to replay saved responses: their timestamps are ahead of it, and fine
    const client = new OutageClient({
      now: () => new Date('2020-01-01T00:00:00Z'),
      providers: [provider(() => schedule())],
    })
    await expect(client.getSchedules('kyiv')).resolves.toBeTruthy()
    const ahead = new Date(Date.now() + 48 * 3600_000).toISOString()
    const bad = new OutageClient({ providers: [provider(() => schedule(undefined, { updatedAt: ahead }))] })
    await expect(bad.getSchedules('kyiv')).rejects.toThrow(/in the future/)
  })
})
