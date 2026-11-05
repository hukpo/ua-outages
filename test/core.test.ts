import { describe, expect, it } from 'vitest'
import {
  cellsToIntervals,
  compareGroups,
  makeDay,
  minutesOf,
  nextOutage,
  normalizeGroup,
  slotsToIntervals,
  stateAt,
} from '../src/schedule.js'
import { bestMatch, matchScore, normalizeHouse, normalizeStreet } from '../src/text.js'
import { addDays, kyivDate, kyivInstant, kyivOffsetMinutes, parseClock, toKyivIso } from '../src/time.js'

describe('time', () => {
  it('knows winter and summer offsets', () => {
    expect(kyivOffsetMinutes(new Date('2026-01-15T12:00:00Z'))).toBe(120)
    expect(kyivOffsetMinutes(new Date('2026-07-15T12:00:00Z'))).toBe(180)
  })

  it('maps wall-clock minutes to instants', () => {
    expect(toKyivIso(kyivInstant('2026-11-05', 8 * 60))).toBe('2026-11-05T08:00:00+02:00')
    expect(toKyivIso(kyivInstant('2026-07-01', 0))).toBe('2026-07-01T00:00:00+03:00')
    expect(toKyivIso(kyivInstant('2026-11-05', 1440))).toBe('2026-11-06T00:00:00+02:00')
  })

  it('handles the DST change days', () => {
    // 2026-03-29: clocks jump 03:00 → 04:00, the day has 23 hours
    const spring = kyivInstant('2026-03-30', 0).getTime() - kyivInstant('2026-03-29', 0).getTime()
    expect(spring / 3600_000).toBe(23)
    // 2026-10-25: clocks go back 04:00 → 03:00, the day has 25 hours
    const autumn = kyivInstant('2026-10-26', 0).getTime() - kyivInstant('2026-10-25', 0).getTime()
    expect(autumn / 3600_000).toBe(25)
  })

  it('gives the Kyiv calendar day', () => {
    // 23:30 UTC on Nov 4 is already Nov 5 in Kyiv
    expect(kyivDate(new Date('2026-11-04T23:30:00Z'))).toBe('2026-11-05')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('parses clock text', () => {
    expect(parseClock('08:00')).toBe(480)
    expect(parseClock('8.30')).toBe(510)
    expect(parseClock('24:00')).toBe(1440)
    expect(parseClock('24:30')).toBeNull()
    expect(parseClock('nope')).toBeNull()
  })
})

describe('schedule building', () => {
  it('merges adjacent slots and keeps kinds apart', () => {
    const iv = slotsToIntervals('2026-11-05', [
      { start: 0, end: 90, kind: 'off' },
      { start: 90, end: 180, kind: 'off' },
      { start: 180, end: 240, kind: 'maybe' },
      { start: 600, end: 660, kind: 'off' },
    ])
    expect(iv).toEqual([
      { from: '2026-11-05T00:00:00+02:00', to: '2026-11-05T03:00:00+02:00', kind: 'off' },
      { from: '2026-11-05T03:00:00+02:00', to: '2026-11-05T04:00:00+02:00', kind: 'maybe' },
      { from: '2026-11-05T10:00:00+02:00', to: '2026-11-05T11:00:00+02:00', kind: 'off' },
    ])
  })

  it('lets off win over maybe when they overlap', () => {
    const iv = slotsToIntervals('2026-11-05', [
      { start: 0, end: 120, kind: 'maybe' },
      { start: 60, end: 120, kind: 'off' },
    ])
    expect(iv.map((i) => i.kind)).toEqual(['maybe', 'off'])
    expect(iv[1]!.from).toBe('2026-11-05T01:00:00+02:00')
  })

  it('builds from half-hour cells', () => {
    const cells = Array<'off' | null>(48).fill(null)
    cells[1] = 'off' // 00:30-01:00
    cells[2] = 'off' // 01:00-01:30
    expect(cellsToIntervals('2026-11-05', cells)).toEqual([
      { from: '2026-11-05T00:30:00+02:00', to: '2026-11-05T01:30:00+02:00', kind: 'off' },
    ])
  })
})

describe('schedule helpers', () => {
  const days = [
    makeDay('2026-11-05', [
      { start: 8 * 60, end: 12 * 60, kind: 'off' },
      { start: 22 * 60, end: 1440, kind: 'off' },
    ]),
    makeDay('2026-11-06', [{ start: 0, end: 2 * 60, kind: 'off' }]),
  ]

  it('answers the state at a moment', () => {
    expect(stateAt(days, new Date('2026-11-05T07:59:00+02:00'))).toBe('on')
    expect(stateAt(days, new Date('2026-11-05T08:00:00+02:00'))).toBe('off')
    expect(stateAt(days, new Date('2026-11-07T08:00:00+02:00'))).toBe('unknown')
  })

  it('finds the next outage and joins it across midnight', () => {
    expect(nextOutage(days, new Date('2026-11-05T13:00:00+02:00'))).toEqual({
      from: '2026-11-05T22:00:00+02:00',
      to: '2026-11-06T02:00:00+02:00',
      kind: 'off',
    })
    expect(nextOutage(days, new Date('2026-11-05T09:00:00+02:00'), { includeCurrent: true })?.from).toBe(
      '2026-11-05T08:00:00+02:00',
    )
    expect(nextOutage(days, new Date('2026-11-06T03:00:00+02:00'))).toBeNull()
  })

  it('sums outage minutes', () => {
    expect(minutesOf(days[0]!)).toBe(6 * 60)
  })
})

describe('groups', () => {
  it.each([
    ['GPV1.1', '1.1'],
    ['1.2', '1.2'],
    ['Черга 3.1', '3.1'],
    ['Група 4.2.', '4.2'],
    ['1 черга 2 підчерга', '1.2'],
    ['5', '5'],
    ['6,1', '6.1'],
  ])('normalizes %s', (raw, want) => expect(normalizeGroup(raw)).toBe(want))

  it('returns null without a number', () => expect(normalizeGroup('немає')).toBeNull())

  it('sorts naturally', () => {
    expect(['2.1', '10.1', '1.2', '1.1'].sort(compareGroups)).toEqual(['1.1', '1.2', '2.1', '10.1'])
  })
})

describe('address text', () => {
  it('strips street types in any position', () => {
    expect(normalizeStreet('вул. Шевченка')).toBe('шевченка')
    expect(normalizeStreet('Шевченка вулиця')).toBe('шевченка')
    expect(normalizeStreet('просп. Перемоги')).toBe('перемоги')
    expect(normalizeStreet('Б. Хмельницького вул.')).toBe('б хмельницького')
  })

  it('unifies apostrophes', () => {
    expect(matchScore("Січових Стрільців", 'Січових Стрільців')).toBe(1)
    expect(matchScore("Солом'янська", 'Соломʼянська')).toBe(1)
  })

  it('normalizes house numbers', () => {
    expect(normalizeHouse('12-А')).toBe('12а')
    expect(normalizeHouse('12 a')).toBe('12а')
    expect(normalizeHouse('№12А')).toBe('12а')
    expect(normalizeHouse('12 корп. 3')).toBe('12к3')
  })

  it('prefers the tighter match and flags ties', () => {
    const streets = ['Тараса Шевченка', 'Шевченка', 'Шевченківська']
    expect(bestMatch('Шевченка', streets, (s) => s)?.item).toBe('Шевченка')
    const tie = bestMatch('Зелена', ['Зелена 1-а', 'Зелена 2-а'], (s) => s)
    expect(tie?.ambiguous).toBe(true)
  })
})

describe('street initials', () => {
  it('matches a first name to its initial', () => {
    expect(matchScore('вул. Богдана Хмельницького', 'Хмельницького Б.')).toBeGreaterThan(0.6)
    expect(matchScore('Хмельницького', 'Хмельницького Б.')).toBeGreaterThan(0)
    expect(matchScore('вул. Івана Франка', 'Хмельницького Б.')).toBe(0)
  })
})
