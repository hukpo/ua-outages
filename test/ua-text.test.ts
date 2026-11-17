import { describe, expect, it } from 'vitest'
import { findTimeRanges, findUaDate, parseGroupLines, parseGroupPost } from '../src/providers/ua-text.js'

const NOW = new Date('2026-11-05T12:00:00+02:00')

describe('Ukrainian schedule text', () => {
  it('finds dates with and without a year', () => {
    expect(findUaDate('ГПВ на 6 листопада 2026 року', NOW)).toBe('2026-11-06')
    expect(findUaDate('Графік на 06 листопада', NOW)).toBe('2026-11-06')
    expect(findUaDate('оновлено 05.11', NOW)).toBe('2026-11-05')
    expect(findUaDate('на 31 грудня', new Date('2027-01-01T08:00:00+02:00'))).toBe('2026-12-31')
    expect(findUaDate('без дати', NOW)).toBeNull()
  })

  it('reads time ranges in their many spellings', () => {
    expect(findTimeRanges('з 08:00 до 12:00, 18.00–22.00; 22:00 - 24:00')).toEqual([
      [480, 720],
      [1080, 1320],
      [1320, 1440],
    ])
    expect(findTimeRanges('23:00 – 00:00, 22:00-23:59')).toEqual([
      [1380, 1440],
      [1320, 1440],
    ])
  })

  it('parses group lines', () => {
    const text = `
      <p><b>Група 1.1.</b> Електроенергії немає з 08:00 до 12:00, з 18:00 до 22:00.</p>
      <p>1.2: 10:00 – 14:00</p>
      <p>Група 2.1. Електроенергія є.</p>
      Групи 3.1, 3.2: 00:00-04:00`
    const g = parseGroupLines(text)
    expect(g['1.1']).toEqual([
      { start: 480, end: 720, kind: 'off' },
      { start: 1080, end: 1320, kind: 'off' },
    ])
    expect(g['1.2']).toEqual([{ start: 600, end: 840, kind: 'off' }])
    expect(g['2.1']).toEqual([])
    expect(g['3.2']).toEqual([{ start: 0, end: 240, kind: 'off' }])
  })

  it('does not read times as groups', () => {
    expect(Object.keys(parseGroupLines('Оновлено о 21.25'))).toEqual([])
  })
})

describe('dates vs group numbers', () => {
  it('does not read a group as a date', () => {
    expect(findUaDate('3.1 00:00-03:00', NOW)).toBeNull()
    expect(findUaDate('о 21.25, графік на 06.11', NOW)).toBe('2026-11-06')
  })
})

describe('parseGroupPost', () => {
  const slots = (...hours: [number, number][]) =>
    hours.map(([a, b]) => ({ start: a * 60, end: b * 60, kind: 'off' }))

  it('reads the lines parseGroupLines reads', () => {
    const text =
      '1.1 00:00-03:00; 08:00-13:30\nПідчерга 1.2 – 10:00-14:00; 20:00-24:00.\n2.1: графік уточнюється\nГрупа 2.2. Електроенергія є.'
    expect(parseGroupPost(text)).toEqual(parseGroupLines(text))
  })

  it('reads a group on its own line with its times below', () => {
    const g = parseGroupPost(
      '⚡ Черга 1.1\nз 10:00 до 15:00\nз 23:30 до 24:00\n\n⚡️ Черга 1.2\nз 02:30 до 07:30',
    )
    expect(g['1.1']).toEqual([
      { start: 600, end: 900, kind: 'off' },
      { start: 1410, end: 1440, kind: 'off' },
    ])
    expect(g['1.2']).toEqual([{ start: 150, end: 450, kind: 'off' }])
  })

  it('ends a block at the first line that is not only times', () => {
    // the sentence about industry after the last group has a time range of its own
    const g = parseGroupPost(
      '⚡ Черга 6.2\nз 01:00 до 06:00\nТакож з 00:00 до 24:00 для промисловості та бізнесу діятимуть ГОП у повному обсязі (5 черг).\nз 10:00 до 12:00',
    )
    expect(g).toEqual({ '6.2': slots([1, 6]) })
  })

  it('leaves a block without times, and a group with times in two places, unknown', () => {
    expect(parseGroupPost('⚡ Черга 1.1\n⚡ Черга 1.2\nз 02:30 до 07:30')).toEqual({
      '1.1': null,
      '1.2': slots([2.5, 7.5]),
    })
    expect(parseGroupPost('1.1 08:00-10:00\n1.2 09:00-11:00\n1.1 18:00-20:00')).toEqual({
      '1.1': null,
      '1.2': slots([9, 11]),
    })
    expect(parseGroupPost('⚡ Черга 1.1\nз 08:00 до 10:00\n⚡ Черга 1.1\nз 18:00 до 20:00')['1.1']).toBeNull()
  })
})

describe('parseGroupPost: times it cannot read exactly', () => {
  it('leaves a group not known rather than with part of its hours', () => {
    for (const line of [
      '5.1 до 12:00, 18:00-22:00',
      '5.1 00:00-03:30 та з 21:30',
      'Черга 5.1: 7:00 - 10:00 та 19-22',
      '5.1 з 20:00',
      '⚡ Черга 5.1\nз 10:00 до 15:00\nз 21:30',
    ])
      expect(parseGroupPost(line), line).toEqual({ '5.1': null })
    // two groups with their own times on one line: neither gets the other's
    expect(parseGroupPost('1.1 – 07:00-10:00; 1.2 – 10:00-13:00')).toEqual({ '1.1': null, '1.2': null })
    // and what was read before or is read after doesn't make it known again
    expect(parseGroupPost('5.1 08:00-10:00\n5.1 до 12:00, 18:00-22:00\n5.2 08:00-10:00')).toEqual({
      '5.1': null,
      '5.2': [{ start: 480, end: 600, kind: 'off' }],
    })
  })

  it('still reads the usual lines and a sentence after the last block', () => {
    expect(parseGroupPost('Підчерга 3.1 – 17:00-19:00; 22:00-24:00.')).toEqual({
      '3.1': [
        { start: 1020, end: 1140, kind: 'off' },
        { start: 1320, end: 1440, kind: 'off' },
      ],
    })
    expect(
      parseGroupPost(
        '⚡ Черга 6.2\nз 07:30 до 12:30\nТакож з 00:00 до 24:00 для промисловості діятимуть ГОП',
      ),
    ).toEqual({ '6.2': [{ start: 450, end: 750, kind: 'off' }] })
  })
})
