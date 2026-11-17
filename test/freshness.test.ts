import { describe, expect, it } from 'vitest'
import { assessFreshness } from '../src/freshness.js'
import { makeDay } from '../src/schedule.js'
import type { DaySchedule, GroupSchedule, RegionSchedule } from '../src/types.js'

const NOW = new Date('2026-11-05T10:00:00+02:00')
const off = (date: string) => makeDay(date, [{ start: 480, end: 720, kind: 'off' }])
const unknown = (date: string): DaySchedule => ({ date, status: 'unknown', intervals: [] })

function region(
  schedules: Record<string, DaySchedule[]>,
  over: Partial<RegionSchedule> = {},
): RegionSchedule {
  return {
    region: 'kyiv',
    groups: Object.keys(schedules),
    schedules,
    updatedAt: '2026-11-05T07:00:00+02:00',
    fetchedAt: '2026-11-05T09:58:00+02:00',
    ...over,
  }
}
const codes = (s: RegionSchedule | GroupSchedule, opts = {}) =>
  assessFreshness(s, { now: NOW, ...opts }).issues.map((i) => i.code)

describe('assessFreshness', () => {
  it('reports a current schedule as fresh, with coverage and ages', () => {
    const f = assessFreshness(
      region({ '1.1': [off('2026-11-05'), off('2026-11-06')], '1.2': [off('2026-11-05')] }),
      { now: NOW },
    )
    expect(f).toEqual({
      state: 'fresh',
      today: 'published',
      tomorrow: 'published',
      coveredThrough: '2026-11-06',
      ageMinutes: 180,
      fetchedMinutesAgo: 2,
      issues: [],
    })
  })

  it('counts no-outages and emergency days as published', () => {
    const f = assessFreshness(
      region({
        '1.1': [{ date: '2026-11-05', status: 'no-outages', intervals: [] }],
        '1.2': [{ date: '2026-11-05', status: 'emergency', intervals: [] }],
      }),
      { now: NOW },
    )
    expect(f).toMatchObject({ state: 'fresh', today: 'published', issues: [] })
  })

  it('says unpublished, not stale, when nothing is published, however old the last word', () => {
    for (const s of [
      region({ '1.1': [unknown('2026-11-05')] }, { updatedAt: '2026-10-01T07:00:00+03:00' }),
      region({}, { updatedAt: null }),
    ]) {
      const f = assessFreshness(s, { now: NOW })
      expect(f).toMatchObject({
        state: 'unpublished',
        today: 'missing',
        tomorrow: 'missing',
        coveredThrough: null,
      })
      expect(f.issues.map((i) => i.code)).toEqual(['nothing-published'])
    }
    expect(assessFreshness(region({}, { updatedAt: null }), { now: NOW }).ageMinutes).toBeNull()
  })

  it('says behind when the newest published day is in the past', () => {
    const s = region(
      { '1.1': [off('2026-11-04'), unknown('2026-11-05')] },
      { updatedAt: '2026-11-04T20:00:00+02:00' },
    )
    const f = assessFreshness(s, { now: NOW })
    expect(f).toMatchObject({ state: 'stale', today: 'missing', coveredThrough: '2026-11-04' })
    expect(f.issues).toEqual([
      { code: 'behind', message: 'The newest published day is 2026-11-04, nothing for 2026-11-05 or later' },
    ])
    // without updatedAt it is still caught
    expect(codes({ ...s, updatedAt: null })).toEqual(['behind'])
  })

  it('turns behind at Kyiv midnight, not UTC midnight', () => {
    const s = region({ '1.1': [off('2026-11-05')] }, { fetchedAt: '2026-11-05T23:50:00+02:00' })
    // 23:59 Kyiv on the 5th
    expect(codes(s, { now: new Date('2026-11-05T21:59:00Z') })).toEqual([])
    // 00:01 Kyiv on the 6th, still the 5th in UTC
    expect(codes(s, { now: new Date('2026-11-05T22:01:00Z') })).toEqual(['behind'])
    // the 25-hour day the clocks go back: 23:30 Kyiv is still that day
    const dst = region(
      { '1.1': [off('2026-10-25')] },
      { updatedAt: null, fetchedAt: '2026-10-25T23:20:00+02:00' },
    )
    expect(codes(dst, { now: new Date('2026-10-25T21:30:00Z') })).toEqual([])
    expect(assessFreshness(dst, { now: new Date('2026-10-24T21:30:00Z') })).toMatchObject({
      today: 'published',
      tomorrow: 'missing',
    })
  })

  it('says not-updated only when updatedAt is old and today is not covered', () => {
    const old = '2026-11-03T20:00:00+02:00' // 38 h before NOW
    // published two days ahead: old, but today is there
    expect(codes(region({ '1.1': [off('2026-11-05')] }, { updatedAt: old }))).toEqual([])
    // today missing while a later day is published
    const ahead = region({ '1.1': [off('2026-11-06')] }, { updatedAt: old })
    expect(assessFreshness(ahead, { now: NOW })).toMatchObject({
      state: 'stale',
      today: 'missing',
      tomorrow: 'published',
    })
    expect(codes(ahead)).toEqual(['not-updated'])
    expect(codes(ahead, { staleAfterHours: 48 })).toEqual([])
    expect(assessFreshness(ahead, { now: NOW, staleAfterHours: 48 }).state).toBe('fresh')
    // exactly at the limit is still fine
    expect(codes(region({ '1.1': [off('2026-11-06')] }, { updatedAt: '2026-11-03T22:00:00+02:00' }))).toEqual(
      [],
    )
    // stuck on a past day and old: both
    expect(codes(region({ '1.1': [off('2026-11-03')] }, { updatedAt: old }))).toEqual([
      'behind',
      'not-updated',
    ])
  })

  it('lists failed and disagreeing sources without changing the state', () => {
    const s = region(
      { '1.1': [off('2026-11-05')] },
      {
        sources: [
          {
            id: 'site',
            url: null,
            ok: false,
            dates: [],
            updatedAt: null,
            error: { code: 'blocked', message: 'bot check' },
          },
          { id: 'telegram:@x', url: null, ok: true, dates: ['2026-11-05'], updatedAt: null },
          { id: 'api', url: null, ok: true, dates: [], updatedAt: null, disagrees: true },
        ],
      },
    )
    const f = assessFreshness(s, { now: NOW })
    expect(f.state).toBe('fresh')
    expect(f.issues).toEqual([
      { code: 'source-failed', message: 'Failed: site (blocked: bot check)' },
      { code: 'sources-disagree', message: 'Different outage times than the newest source: api' },
    ])
    // degraded and behind: the state follows the data
    expect(assessFreshness({ ...s, schedules: { '1.1': [off('2026-11-04')] } }, { now: NOW }).state).toBe(
      'stale',
    )
  })

  it('says last-good for a result that stands in for a failed fetch', () => {
    const s = region(
      { '1.1': [off('2026-11-05')] },
      {
        fetchedAt: '2026-11-05T07:00:00+02:00',
        stale: { since: '2026-11-05T07:00:00+02:00', error: { code: 'network', message: 'down' } },
      },
    )
    const f = assessFreshness(s, { now: NOW })
    expect(f).toMatchObject({ state: 'stale', today: 'published', fetchedMinutesAgo: 180 })
    // its age is part of last-good, not a second issue
    expect(f.issues.map((i) => i.code)).toEqual(['last-good'])
    expect(f.issues[0]!.message).toContain('network: down')
  })

  it('says fetched-long-ago for an object the caller kept', () => {
    const s = region({ '1.1': [off('2026-11-05')] }, { fetchedAt: '2026-11-05T09:29:00+02:00' })
    expect(assessFreshness(s, { now: NOW })).toMatchObject({ state: 'stale', fetchedMinutesAgo: 31 })
    expect(codes(s)).toEqual(['fetched-long-ago'])
    expect(codes({ ...s, fetchedAt: '2026-11-05T09:30:00+02:00' })).toEqual([])
    expect(codes(s, { fetchedStaleAfterMinutes: 60 })).toEqual([])
    // a clock that is behind the fetch doesn't give negative ages
    expect(
      assessFreshness({ ...s, fetchedAt: '2026-11-05T10:05:00+02:00' }, { now: NOW }).fetchedMinutesAgo,
    ).toBe(0)
  })

  it('lists a missing tomorrow only when asked and past the hour', () => {
    const s = region({ '1.1': [off('2026-11-05')] })
    expect(codes(s)).toEqual([])
    expect(codes(s, { tomorrowExpectedAt: '20:00' })).toEqual([])
    expect(codes(s, { tomorrowExpectedAt: '10:00' })).toEqual(['tomorrow-missing'])
    expect(assessFreshness(s, { now: NOW, tomorrowExpectedAt: '09:30' }).state).toBe('fresh')
    // Kyiv wall clock, in summer time too: 17:05 UTC is 20:05 in Kyiv
    const summer = region(
      { '1.1': [off('2026-07-01')] },
      { updatedAt: null, fetchedAt: '2026-07-01T20:00:00+03:00' },
    )
    expect(codes(summer, { now: new Date('2026-07-01T17:05:00Z'), tomorrowExpectedAt: '20:00' })).toEqual([
      'tomorrow-missing',
    ])
    expect(codes(summer, { now: new Date('2026-07-01T16:55:00Z'), tomorrowExpectedAt: '20:00' })).toEqual([])
    expect(
      codes(region({ '1.1': [off('2026-11-05'), off('2026-11-06')] }), { tomorrowExpectedAt: '00:00' }),
    ).toEqual([])
    expect(() => assessFreshness(s, { tomorrowExpectedAt: 'evening' })).toThrow(RangeError)
  })

  it('counts a day the operator cancelled as a publication, not as a source left behind', () => {
    const cancelled = (dates: string[], ok = true) => ({
      id: 'telegram:@x',
      url: null,
      ok,
      dates,
      updatedAt: '2026-11-05T07:00:00+02:00',
    })
    // yesterday's schedule, and today called off this morning: `unknown` for every group
    const days = { '1.1': [off('2026-11-04'), unknown('2026-11-05')], '1.2': [unknown('2026-11-05')] }
    const s = region(days, { sources: [cancelled(['2026-11-05'])] })
    expect(assessFreshness(s, { now: NOW })).toEqual({
      state: 'fresh',
      // nothing to show for today, and nothing out of date either
      today: 'missing',
      tomorrow: 'missing',
      coveredThrough: '2026-11-05',
      ageMinutes: 180,
      fetchedMinutesAgo: 2,
      issues: [],
    })
    // the same days with no channel having supplied today: stuck on yesterday
    expect(codes(region(days))).toEqual(['behind'])
    expect(codes(region(days, { sources: [cancelled([])] }))).toEqual(['behind'])
    expect(codes(region(days, { sources: [cancelled(['2026-11-04'])] }))).toEqual(['behind'])
    // a cancellation alone is something published, and an old one doesn't make today "not updated"
    const only = region(
      { '1.1': [unknown('2026-11-05')] },
      { sources: [cancelled(['2026-11-05'])], updatedAt: '2026-11-03T07:00:00+02:00' },
    )
    expect(assessFreshness(only, { now: NOW })).toMatchObject({ state: 'fresh', issues: [] })
    expect(assessFreshness(region({ '1.1': [unknown('2026-11-05')] }), { now: NOW }).state).toBe(
      'unpublished',
    )
    // tomorrow called off is not "tomorrow missing"
    const both = region(
      { '1.1': [off('2026-11-05'), unknown('2026-11-06')] },
      { sources: [cancelled(['2026-11-05', '2026-11-06'])] },
    )
    expect(codes(both, { tomorrowExpectedAt: '09:00' })).toEqual([])
    expect(assessFreshness(both, { now: NOW })).toMatchObject({
      tomorrow: 'missing',
      coveredThrough: '2026-11-06',
    })
    // one group of such a region
    const group: GroupSchedule = {
      region: 'kyiv',
      group: '1.1',
      days: days['1.1'],
      updatedAt: s.updatedAt,
      fetchedAt: s.fetchedAt,
      sources: s.sources,
    }
    expect(codes(group)).toEqual([])
  })

  it('lists a partly published today', () => {
    const s = region({ '1.1': [off('2026-11-05')], '1.2': [unknown('2026-11-05')], '2.1': [] })
    const f = assessFreshness(s, { now: NOW })
    expect(f.state).toBe('fresh')
    expect(f.issues).toEqual([{ code: 'partial', message: '2026-11-05 is published for 1 of 3 groups' }])
  })

  it('works on one group, carrying the region’s sources and stale mark', () => {
    const g: GroupSchedule = {
      region: 'kyiv',
      group: '1.1',
      days: [off('2026-11-05')],
      updatedAt: null,
      fetchedAt: '2026-11-05T09:58:00+02:00',
      sources: [{ id: 'site', url: null, ok: false, dates: [], updatedAt: null }],
    }
    expect(assessFreshness(g, { now: NOW })).toMatchObject({
      state: 'fresh',
      today: 'published',
      ageMinutes: null,
    })
    expect(codes(g)).toEqual(['source-failed'])
    expect(codes({ ...g, days: [unknown('2026-11-05')], sources: undefined })).toEqual(['nothing-published'])
  })
})
