import { describe, expect, it } from 'vitest'
import { findTimeRanges, findUaDate } from '../src/providers/ua-text.js'

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
})

describe('dates vs group numbers', () => {
  it('does not read a group as a date', () => {
    expect(findUaDate('3.1 00:00-03:00', NOW)).toBeNull()
    expect(findUaDate('о 21.25, графік на 06.11', NOW)).toBe('2026-11-06')
  })
})
