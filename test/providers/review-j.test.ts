import { describe, expect, it } from 'vitest'
import { channelInputs } from '../../src/ai/posts.js'
import { AiRuntime } from '../../src/ai/runtime.js'
import type { ImageProcessor, PostEvent, TextProcessor } from '../../src/ai/types.js'
import type { TelegramPost } from '../../src/emergency/telegram.js'
import { Http } from '../../src/http.js'
import { readPicturePosts } from '../../src/providers/picture-posts.js'
import { layerPublications, readSchedulePosts } from '../../src/providers/posts.js'
import { mergeSources } from '../../src/providers/sources.js'
import { STANDARD_GROUPS, type MinuteSlot } from '../../src/schedule.js'
import type { RegionId } from '../../src/types.js'
import { ev, fakeImage, fakeText, fixtureBytes, gpvSchedule, intervalsOf, mockFetch } from '../helpers.js'

const off = (from: number, to: number): MinuteSlot => ({ start: from * 60, end: to * 60, kind: 'off' })
const gpv = (o: Partial<PostEvent>, region: RegionId = 'kharkiv') =>
  ev({ kind: 'gpv', action: 'start', regions: [region], ...o })

const tg = (channel: string, id: number, at: string, text: string, photos = 0): TelegramPost => ({
  channel,
  id,
  url: `https://t.me/${channel}/${id}`,
  at,
  text,
  edited: false,
  replyTo: null,
  photos: Array.from({ length: photos }, (_, i) => `https://cdn4.telesco.pe/file/${id}-${i}.jpg`),
})

function ctxOf(
  now: string,
  text: TextProcessor,
  image?: ImageProcessor,
  files: Record<number, Uint8Array> = {},
) {
  const { fetch } = mockFetch(Object.entries(files).map(([id, body]) => ({ match: `/file/${id}-`, body })))
  return {
    http: new Http({ fetch }),
    now: () => new Date(now),
    ai: new AiRuntime({ textProcessor: text, ...(image ? { imageProcessor: image } : {}) }),
  }
}

describe('an unread post is flagged until a later whole day stands in for it', () => {
  // Kharkiv's updates list the hours ahead: 17.11 20:00 the whole 18th, 18.11 09:00 unread, 14:00
  // "з 14:00 до 18:00"
  const posts = [
    tg('kharkivenergy', 1, '2026-11-17T20:00:00+02:00', 'list for 18'),
    tg('kharkivenergy', 2, '2026-11-18T09:00:00+02:00', 'unreadable'),
    tg('kharkivenergy', 3, '2026-11-18T14:00:00+02:00', 'from 14 to 18'),
  ]
  const text = fakeText((input) => {
    if (input.text === 'list for 18')
      return [gpv({ date: '2026-11-18', schedule: gpvSchedule({ '1.1': '19:00-23:00' }) })]
    if (input.text === 'unreadable') return [gpv({ at: '25:00' })]
    return [gpv({ at: '14:00', until: '18:00', schedule: gpvSchedule({ '1.2': '15:00-16:00' }) })]
  })

  it('an update for part of the day leaves it not known (the evening may have changed)', async () => {
    const ctx = ctxOf('2026-11-18T14:30:00+02:00', text)
    const { days } = await readSchedulePosts(ctx, 'kharkiv', channelInputs(posts, 'kharkiv'), {
      updates: 'layer',
    })
    expect(days.get('2026-11-18')!.unread).toMatchObject({ code: 'parse' })
  })

  it('a whole list after it does', async () => {
    const whole = fakeText((input) =>
      input.text === 'unreadable'
        ? [gpv({ at: '25:00' })]
        : input.text === 'list for 18'
          ? [gpv({ date: '2026-11-18', schedule: gpvSchedule({ '1.1': '19:00-23:00' }) })]
          : [gpv({ date: '2026-11-18', schedule: gpvSchedule({ '1.1': '20:00-22:00' }) })],
    )
    const later = [...posts.slice(0, 2), tg('kharkivenergy', 3, '2026-11-18T14:00:00+02:00', 'whole again')]
    const ctx = ctxOf('2026-11-18T14:30:00+02:00', whole)
    // posted during its day, a list replaces only the hours ahead: from 14:00 on it is not a whole day
    const layered = await readSchedulePosts(ctx, 'kharkiv', channelInputs(later, 'kharkiv'), {
      updates: 'layer',
    })
    expect(layered.days.get('2026-11-18')!.unread).toBeDefined()
    const replaced = await readSchedulePosts(ctx, 'kharkiv', channelInputs(later, 'kharkiv'))
    expect(replaced.days.get('2026-11-18')!.unread).toBeUndefined()
  })
})

describe('layering: a day is whole or not known', () => {
  it('a bounded list after a cancellation is not a whole day', () => {
    const day = layerPublications([
      { from: 0, groups: { '1.1': [off(8, 10)] } },
      { from: 0, groups: {}, cancelled: true },
      { from: 600, to: 720, groups: { '1.1': [] } },
    ])
    expect(day).toMatchObject({ groups: { '1.1': null }, cancelled: false, based: false })
  })

  it("omitted 'unknown': a group the base didn't list is not known after a correction or a window", () => {
    const base = { from: 0, groups: { '1.1': [off(8, 10)] } }
    expect(
      layerPublications([base, { from: 0, add: true, groups: { '2.1': [off(18, 19)] } }], 'unknown').groups[
        '2.1'
      ],
    ).toBeNull()
    expect(
      layerPublications([base, { from: 900, groups: { '2.1': [off(18, 19)] } }], 'unknown').groups['2.1'],
    ).toBeNull()
    // with 'none' the base said 2.1 had none: the correction is its day
    expect(
      layerPublications([base, { from: 0, add: true, groups: { '2.1': [off(18, 19)] } }], 'none').groups[
        '2.1'
      ],
    ).toEqual([off(18, 19)])
  })

  it("a whole re-list at 14:00 keeps the morning as it was, not both versions' mornings", () => {
    const day = layerPublications([
      { from: 0, groups: { '1.1': [off(8, 10)] } },
      { from: 840, groups: { '1.1': [off(9, 11), off(18, 20)] } },
    ])
    expect(day.groups['1.1']).toEqual([off(8, 10), off(18, 20)])
  })
})

describe('merging channels: a day with an unread post', () => {
  it('the last version read stands (read again on the next poll); the channel says what it couldn’t read', async () => {
    const at = (h: number) => `2026-11-18T${String(h).padStart(2, '0')}:00:00+02:00`
    const s = await mergeSources(
      { http: new Http({ fetch: mockFetch([]).fetch }), now: () => new Date(at(15)) },
      'chernihiv',
      [
        {
          id: 'site',
          url: null,
          read: async () => ({
            days: {
              '2026-11-18': {
                schedules: { '1.1': { date: '2026-11-18', status: 'scheduled', intervals: [] } },
                publishedAt: at(8),
              },
            },
          }),
        },
        {
          id: 'telegram',
          url: null,
          read: async () => ({
            days: {
              '2026-11-18': { schedules: {}, publishedAt: at(14), unread: 'the 14:00 poster did not read' },
            },
          }),
        },
      ],
    )
    expect(s.schedules['1.1']![0]!.status).toBe('scheduled')
    expect(s.sources![1]).toMatchObject({ ok: true, dates: [], unread: [{ date: '2026-11-18' }] })
  })
})

describe('pictures', () => {
  const png = fixtureBytes('chernihiv/posters/tg-5718.jpg')
  const reading = (date: string, hours: Record<string, string>) => ({
    date,
    schedule: STANDARD_GROUPS.map((queue) => ({ queue, intervals: intervalsOf(hours[queue] ?? '') })),
  })

  it('"ГПВ скасовано до окремого розпорядження" after tomorrow’s poster cancels tomorrow too', async () => {
    const posts = [
      tg('chernigivoblenergo', 1, '2026-11-17T18:00:00+02:00', 'poster for 18', 1),
      tg('chernigivoblenergo', 2, '2026-11-17T19:00:00+02:00', 'cancelled until further notice'),
    ]
    const text = fakeText((input) =>
      input.text.startsWith('poster')
        ? { photosAreSchedules: true, events: [gpv({ date: '2026-11-18' }, 'chernihiv')] }
        : [gpv({ action: 'cancel', untilFurtherNotice: true }, 'chernihiv')],
    )
    const image = fakeImage(() => reading('2026-11-18', { '1.1': '08:00-10:00' }))
    const ctx = ctxOf('2026-11-17T20:00:00+02:00', text, image, { 1: png })
    const r = await readPicturePosts(ctx, 'chernihiv', posts, { groups: STANDARD_GROUPS, updates: 'layer' })
    expect(r.days.get('2026-11-18')!.cancelled).toBe(true)
  })

  it('a caption saying "діє з 15:00" replaces the day from 15:00, not from the post time', async () => {
    const posts = [
      tg('chernigivoblenergo', 1, '2026-11-17T20:00:00+02:00', 'poster for 18', 1),
      tg('chernigivoblenergo', 2, '2026-11-18T12:00:00+02:00', 'new poster from 15:00', 1),
    ]
    const text = fakeText((input) =>
      input.text.startsWith('poster')
        ? { photosAreSchedules: true, events: [gpv({ date: '2026-11-18' }, 'chernihiv')] }
        : { photosAreSchedules: true, events: [gpv({ date: '2026-11-18', at: '15:00' }, 'chernihiv')] },
    )
    const image = fakeImage((input) =>
      input.url.endsWith('/1')
        ? reading('2026-11-18', { '1.1': '13:00-14:00' })
        : reading('2026-11-18', { '1.1': '16:00-17:00' }),
    )
    const ctx = ctxOf('2026-11-18T12:30:00+02:00', text, image, { 1: png, 2: png })
    const r = await readPicturePosts(ctx, 'chernihiv', posts, { groups: STANDARD_GROUPS, updates: 'layer' })
    // 13:00-14:00 of the first poster is before 15:00: it stands
    expect(r.days.get('2026-11-18')!.groups['1.1']).toEqual([off(13, 14), off(16, 17)])
  })
})
