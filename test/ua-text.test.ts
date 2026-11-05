import { describe, expect, it } from 'vitest'
import { findTimeRanges, findUaDate, parseGroupLines } from '../src/providers/ua-text.js'

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
