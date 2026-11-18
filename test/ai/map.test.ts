import { describe, expect, it } from 'vitest'
import { eventInstant, toAnnouncements } from '../../src/ai/map.js'
import { postRegion } from '../../src/ai/regions.js'
import { layerPublications } from '../../src/providers/posts.js'
import { ev } from '../helpers.js'

const poltava = postRegion('poltava')

describe('eventInstant', () => {
  it('puts a stated time on the post day, or the day before when that would be far ahead', () => {
    expect(eventInstant({ date: null, at: '14:05' }, '2026-11-17T14:25:14+02:00')).toEqual({
      at: '2026-11-17T14:05:00+02:00',
      timed: true,
    })
    // posted 00:20 about "23:55": last night
    expect(eventInstant({ date: null, at: '23:55' }, '2026-11-18T00:20:00+02:00').at).toBe(
      '2026-11-17T23:55:00+02:00',
    )
    // a stated date wins
    expect(eventInstant({ date: '2026-11-18', at: '00:00' }, '2026-11-17T22:00:00+02:00').at).toBe(
      '2026-11-18T00:00:00+02:00',
    )
    expect(eventInstant({ date: null, at: null }, '2026-11-17T14:25:14+02:00')).toEqual({
      at: '2026-11-17T14:25:14+02:00',
      timed: false,
    })
  })
})

describe('toAnnouncements', () => {
  const posted = '2026-11-02T07:53:00+02:00'

  it('"в повному обсязі" is all ten queues of an oblenergo', () => {
    const [a] = toAnnouncements(
      [ev({ kind: 'gav', action: 'start', regions: ['poltava'], allQueues: true })],
      'poltava',
      poltava,
      posted,
    )
    expect(a).toMatchObject({
      action: 'apply',
      queues: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
      count: 10,
      partial: false,
    })
  })

  it('a cancel naming queues is partial; one for all is not', () => {
    const [part] = toAnnouncements(
      [ev({ kind: 'gav', action: 'cancel', regions: ['poltava'], queues: ['6', '7', '8', '9', '10'] })],
      'poltava',
      poltava,
      posted,
    )
    expect(part).toMatchObject({ action: 'cancel', partial: true, count: 5 })
    const [all] = toAnnouncements(
      [ev({ kind: 'sgav', action: 'cancel', regions: ['poltava'], allQueues: true })],
      'poltava',
      poltava,
      posted,
    )
    expect(all).toMatchObject({ action: 'cancel', partial: false, count: null })
  })

  it('keeps only events about the region asked, and none of the ГПВ or other ones', () => {
    const list = toAnnouncements(
      [
        ev({ kind: 'emergency', action: 'start', regions: ['kyiv-region'] }),
        ev({ kind: 'gpv', action: 'start', regions: ['kyiv'] }),
        ev({ kind: 'emergency', action: 'cancel', regions: ['kyiv'], gpvApplies: true, until: null }),
      ],
      'kyiv',
      postRegion('kyiv'),
      posted,
    )
    expect(list).toEqual([
      expect.objectContaining({ action: 'cancel', kind: 'emergency', scheduleApplies: true }),
    ])
  })

  it('"до кінця доби" lasts to the next midnight', () => {
    const [a] = toAnnouncements(
      [ev({ kind: 'gav', action: 'start', regions: ['poltava'], until: '24:00' })],
      'poltava',
      poltava,
      posted,
    )
    expect(a!.until).toBe('2026-11-03T00:00:00+02:00')
  })
})

describe('layerPublications: a correction adds to the schedule', () => {
  it('adds slots to the groups it names, makes unknown the ones without both ends, keeps the rest', () => {
    const day = layerPublications(
      [
        { from: 0, groups: { '1.1': [{ start: 600, end: 720, kind: 'off' }], '1.2': [], '4.1': [] } },
        { from: 0, add: true, groups: { '1.1': [{ start: 360, end: 480, kind: 'off' }], '4.1': null } },
      ],
      'unknown',
    )
    expect(day.groups).toEqual({
      '1.1': [
        { start: 600, end: 720, kind: 'off' },
        { start: 360, end: 480, kind: 'off' },
      ],
      '1.2': [],
      '4.1': null,
    })
  })
})

describe('eventInstant: a day of its own, and a day named for certain', () => {
  it('"завтра діятимуть ГАВ" without a time starts that day, not at the post', () => {
    expect(eventInstant({ date: '2026-11-19', at: null }, '2026-11-18T20:00:00+02:00')).toEqual({
      at: '2026-11-19T00:00:00+02:00',
      timed: true,
    })
  })

  it('"сьогодні о 19:00" posted at 00:30 is tonight, not last night', () => {
    expect(eventInstant({ date: null, at: '19:00', dateNamed: true }, '2026-11-18T00:30:00+02:00').at).toBe(
      '2026-11-18T19:00:00+02:00',
    )
    // no day named: still last night
    expect(eventInstant({ date: null, at: '19:00' }, '2026-11-18T00:30:00+02:00').at).toBe(
      '2026-11-17T19:00:00+02:00',
    )
  })

  it('a start at 23:59 is 23:59, not the next midnight', () => {
    expect(eventInstant({ date: null, at: '23:59' }, '2026-11-18T20:00:00+02:00').at).toBe(
      '2026-11-18T23:59:00+02:00',
    )
  })
})

describe('hourlySchedule: a ГАВ table is not the day’s hours', () => {
  it('takes gpv and an unnamed kind, not gav or sgav', async () => {
    const { hourlySchedule } = await import('../../src/providers/image-schedule.js')
    const r = (kind: 'gpv' | 'gav' | 'sgav' | null) => ({
      isSchedule: true,
      kind,
      date: null,
      statedAt: null,
      schedule: [],
    })
    expect([r('gpv'), r(null), r('gav'), r('sgav')].map(hourlySchedule)).toEqual([true, true, false, false])
  })
})
