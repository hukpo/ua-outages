import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { STANDARD_GROUPS } from '../../src/image/table.js'
import { parseChernihivPoster } from '../../src/providers/chernihiv.js'
import type { DaySchedule } from '../../src/types.js'
import { fixtureBytes, mockFetch } from '../helpers.js'

// posters with the times read off them by hand: the full-size 06.11 original, a downscaled
// copy of 05.11, and ~500 px Telegram copies from October (scripts/train-digits.ts uses the same set)
const labels = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/chernihiv/posters/labels.json', import.meta.url)), 'utf8'),
) as Record<string, { date: string; cards: string[] }>

const noonOf = (date: string) => new Date(`${date}T12:00:00+02:00`)
const hhmm = (d: DaySchedule) =>
  d.intervals
    .map((i) => `${i.from.slice(11, 16)}-${i.to.slice(0, 10) > d.date ? '00:00' : i.to.slice(11, 16)}`)
    .join(' ')

describe('Chernihivoblenergo poster', () => {
  it.each(Object.entries(labels))('reads %s', (file, want) => {
    const s = parseChernihivPoster(fixtureBytes(`chernihiv/posters/${file}`), noonOf(want.date))
    expect(s.groups).toEqual(STANDARD_GROUPS)
    STANDARD_GROUPS.forEach((g, i) => {
      const day = s.schedules[g]![0]!
      expect(day.date).toBe(want.date)
      expect(hhmm(day), `${g}`).toBe(want.cards[i])
    })
  })

  it('marks "відключень не прогнозується" cards as no outages', () => {
    const s = parseChernihivPoster(fixtureBytes('chernihiv/posters/2026-10-06-tg.jpg'), noonOf('2026-10-06'))
    expect(s.schedules['2.1']![0]).toMatchObject({ status: 'no-outages', intervals: [] })
    expect(s.schedules['1.1']![0]!.status).toBe('scheduled')
  })

  it('refuses a poster whose date is not current', () => {
    expect(() =>
      parseChernihivPoster(fixtureBytes('chernihiv/posters/2026-10-06-tg.jpg'), noonOf('2026-11-06')),
    ).toThrow(/no current date/)
  })

  it('refuses an image that is not the card poster', () => {
    expect(() => parseChernihivPoster(fixtureBytes('image/sample-444.jpg'), noonOf('2026-11-06'))).toThrow(
      expect.objectContaining({ code: 'parse' }),
    )
  })

  it('fetches the poster and takes the update time from Last-Modified', async () => {
    const { fetch } = mockFetch([
      {
        match: 'schedule_groups.jpg',
        body: fixtureBytes('chernihiv/posters/2026-11-06.jpg'),
        headers: { 'Last-Modified': 'Fri, 06 Nov 2026 06:11:42 GMT' },
      },
    ])
    const c = new OutageClient({ fetch, now: () => noonOf('2026-11-06'), cacheTtlMs: 0 })
    const s = await c.getSchedule('chernihiv', '6.2')
    expect(s.updatedAt).toBe('2026-11-06T08:11:42+02:00')
    expect(hhmm(s.days[0]!)).toBe('06:00-09:30 13:00-20:00 23:30-00:00')
    expect((await c.healthCheck({ regions: ['chernihiv'] })).regions[0]!.status).toBe('ok')
  })
})
