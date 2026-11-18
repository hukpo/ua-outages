import { describe, expect, it } from 'vitest'
import { AiRuntime } from '../../src/ai/runtime.js'
import type { PostEvent } from '../../src/ai/types.js'
import { channelEvents, EMERGENCY_REGIONS } from '../../src/emergency/regions.js'
import { foldEvents } from '../../src/emergency/status.js'
import type { TelegramPost } from '../../src/emergency/telegram.js'
import { Http } from '../../src/http.js'
import type { RegionId } from '../../src/types.js'
import { ev, fakeText, mockFetch } from '../helpers.js'

/** Posts given as [text, ISO time, what the text processor reads in it], folded for a region at `now` */
async function fold(region: RegionId, items: [string, string, PostEvent[]][], now: string) {
  const byText = new Map(items.map(([text, , events]) => [text, events]))
  const ctx = {
    http: new Http({ fetch: mockFetch([]).fetch }),
    now: () => new Date(now),
    ai: new AiRuntime({ textProcessor: fakeText((input) => byText.get(input.text)) }),
  }
  const posts: TelegramPost[] = items.map(([text, at], i) => ({
    channel: 'x',
    id: i + 1,
    url: `https://t.me/x/${i + 1}`,
    at,
    text,
    edited: false,
    photos: [],
    replyTo: null,
  }))
  return foldEvents(await channelEvents(ctx, region, posts), {
    region,
    now: new Date(now),
    ttlHours: EMERGENCY_REGIONS[region]!.ttlHours ?? 12,
    source: 'telegram',
  })
}

describe('several announcements in force: queues only when they are the whole picture', () => {
  it('one ГАВ naming its queues: those queues', async () => {
    const s = await fold(
      'kirovohrad',
      [
        [
          'В 06:10 застосовано ГАВ 3 чергу',
          '2026-11-18T06:11:00+02:00',
          [ev({ kind: 'gav', action: 'start', regions: ['kirovohrad'], at: '06:10', queues: ['3'] })],
        ],
      ],
      '2026-11-18T06:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', kind: 'gav', queues: ['3'] })
  })

  it('a ГАВ and a newer СГАВ, each with queues of its own: no list (the ГАВ one would be lost)', async () => {
    const s = await fold(
      'kirovohrad',
      [
        [
          'В 06:10 застосовано ГАВ 3 чергу',
          '2026-11-18T06:11:00+02:00',
          [ev({ kind: 'gav', action: 'start', regions: ['kirovohrad'], at: '06:10', queues: ['3'] })],
        ],
        [
          'В 06:20 застосовано СГАВ 5 чергу',
          '2026-11-18T06:21:00+02:00',
          [ev({ kind: 'sgav', action: 'start', regions: ['kirovohrad'], at: '06:20', queues: ['5'] })],
        ],
      ],
      '2026-11-18T06:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queues: null, queueCount: null })
  })
})
