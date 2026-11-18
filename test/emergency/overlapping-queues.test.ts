import { describe, expect, it } from 'vitest'
import { channelEvents, EMERGENCY_REGIONS } from '../../src/emergency/regions.js'
import { foldEvents } from '../../src/emergency/status.js'
import type { TelegramPost } from '../../src/emergency/telegram.js'
import type { RegionId } from '../../src/types.js'

/** Posts given as [text, ISO time], folded for a region at `now` */
function fold(region: RegionId, items: [string, string][], now: string) {
  const c = EMERGENCY_REGIONS[region]!.channels![0]!
  const posts: TelegramPost[] = items.map(([text, at], i) => ({
    channel: 'x',
    id: i + 1,
    url: `https://t.me/x/${i + 1}`,
    at,
    text,
    edited: false,
    photos: [],
  }))
  return foldEvents(channelEvents(posts, c), {
    region,
    now: new Date(now),
    ttlHours: EMERGENCY_REGIONS[region]!.ttlHours ?? 12,
    source: 'telegram',
  })
}

describe('several announcements in force: queues only when they are the whole picture', () => {
  it('one ГАВ naming its queues: those queues', () => {
    const s = fold(
      'kirovohrad',
      [['В 06:10 застосовано ГАВ 3 чергу', '2026-11-18T06:11:00+02:00']],
      '2026-11-18T06:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', kind: 'gav', queues: ['3'] })
  })

  it('a ГАВ and a newer СГАВ, each with queues of its own: no list (the ГАВ one would be lost)', () => {
    const s = fold(
      'kirovohrad',
      [
        ['В 06:10 застосовано ГАВ 3 чергу', '2026-11-18T06:11:00+02:00'],
        ['В 06:20 застосовано СГАВ 5 чергу', '2026-11-18T06:21:00+02:00'],
      ],
      '2026-11-18T06:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queues: null, queueCount: null })
  })
})
