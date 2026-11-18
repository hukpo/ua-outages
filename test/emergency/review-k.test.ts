import { describe, expect, it } from 'vitest'
import { postRegion } from '../../src/ai/regions.js'
import { AiRuntime } from '../../src/ai/runtime.js'
import type { PostEvent } from '../../src/ai/types.js'
import { channelEvents, EMERGENCY_REGIONS } from '../../src/emergency/regions.js'
import { foldEvents } from '../../src/emergency/status.js'
import type { TelegramPost } from '../../src/emergency/telegram.js'
import { Http } from '../../src/http.js'
import type { RegionId } from '../../src/types.js'
import { ev, fakeText, mockFetch } from '../helpers.js'

/**
 * Posts as [text, ISO time, first reading, second reading?], folded at `now`. A second reading
 * that differs makes the post unclear (no judge)
 */
async function fold(region: RegionId, items: [string, string, PostEvent[], PostEvent[]?][], now: string) {
  const first = new Map(items.map(([text, , events]) => [text, events]))
  const second = new Map(items.map(([text, , events, other]) => [text, other ?? events]))
  const ctx = {
    http: new Http({ fetch: mockFetch([]).fetch }),
    now: () => new Date(now),
    ai: new AiRuntime({
      textProcessor: fakeText((input) => first.get(input.text)),
      verifyProcessor: fakeText((input) => second.get(input.text), 'second'),
    }),
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

const gav = (o: Partial<PostEvent> & Pick<PostEvent, 'action'>) =>
  ev({ kind: 'gav', regions: ['zaporizhzhia'], ...o })

describe('an unread post: the state before it, flagged until a word posted after it', () => {
  it('an apply announced for later, posted before the unread post, does not settle it', async () => {
    const s = await fold(
      'zaporizhzhia',
      [
        [
          'Об 11:00 вводяться ГАВ 1-2',
          '2026-11-18T10:40:00+02:00',
          [gav({ action: 'start', at: '11:00', queues: ['1', '2'] })],
        ],
        ['ГАВ об 11:00 не застосовуватимуться', '2026-11-18T10:50:00+02:00', [gav({ action: 'cancel' })], []],
      ],
      '2026-11-18T11:05:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queues: ['1', '2'], unread: { url: 'https://t.me/x/2' } })
  })

  it('a СГАВ cancel says nothing about a ГАВ in doubt; a ГАВ cancel does', async () => {
    const items: [string, string, PostEvent[], PostEvent[]?][] = [
      ['08:00 ГАВ 1-2', '2026-11-18T08:00:00+02:00', [gav({ action: 'start', queues: ['1', '2'] })]],
      ['незрозуміло', '2026-11-18T09:00:00+02:00', [gav({ action: 'cancel' })], []],
    ]
    const sgav = await fold(
      'zaporizhzhia',
      [...items, ['СГАВ скасовано', '2026-11-18T10:00:00+02:00', [gav({ kind: 'sgav', action: 'cancel' })]]],
      '2026-11-18T10:30:00+02:00',
    )
    expect(sgav).toMatchObject({ state: 'active', unread: { url: 'https://t.me/x/2' } })
    const cancel = await fold(
      'zaporizhzhia',
      [...items, ['ГАВ скасовано', '2026-11-18T10:00:00+02:00', [gav({ action: 'cancel' })]]],
      '2026-11-18T10:30:00+02:00',
    )
    expect(cancel.state).toBe('inactive')
    expect(cancel.unread).toBeUndefined()
  })
})

describe('queue changes', () => {
  it('"заміна черг: тепер 3 та 4" replaces 1 and 2', async () => {
    const s = await fold(
      'zaporizhzhia',
      [
        ['ГАВ 1-2', '2026-11-18T08:00:00+02:00', [gav({ action: 'start', queues: ['1', '2'] })]],
        [
          'заміна черг, тепер 3 та 4',
          '2026-11-18T10:00:00+02:00',
          [gav({ action: 'change', queues: ['3', '4'] })],
        ],
      ],
      '2026-11-18T10:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queues: ['3', '4'] })
  })

  it('"додатково 3" adds to 1 and 2', async () => {
    const s = await fold(
      'zaporizhzhia',
      [
        ['ГАВ 1-2', '2026-11-18T08:00:00+02:00', [gav({ action: 'start', queues: ['1', '2'] })]],
        [
          'додатково 3',
          '2026-11-18T10:00:00+02:00',
          [gav({ action: 'change', queues: ['3'], additive: true })],
        ],
      ],
      '2026-11-18T10:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queues: ['1', '2', '3'] })
  })

  it('some named back on and some not named at all: which stay off is not known', async () => {
    const s = await fold(
      'zaporizhzhia',
      [
        [
          'ГАВ 3-8',
          '2026-11-18T08:00:00+02:00',
          [gav({ action: 'start', queues: ['3', '4', '5', '6', '7', '8'] })],
        ],
        [
          '9,10 знеструмлюємо; 3-6 заживлені',
          '2026-11-18T10:00:00+02:00',
          [gav({ action: 'change', queues: ['9', '10'], queuesRestored: ['3', '4', '5', '6'] })],
        ],
      ],
      '2026-11-18T10:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queues: null })
  })

  it('"тепер відключено 2 черги" with nothing before: on, two queues', async () => {
    const s = await fold(
      'zaporizhzhia',
      [['тепер 2 черги', '2026-11-18T10:00:00+02:00', [gav({ action: 'change', queueCount: 2 })]]],
      '2026-11-18T10:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queueCount: 2 })
  })
})

describe('times', () => {
  const items: [string, string, PostEvent[]][] = [
    ['07:00 ГАВ', '2026-11-18T07:00:00+02:00', [gav({ action: 'start' })]],
    ['о 12:00 ГАВ скасовуються', '2026-11-18T08:00:00+02:00', [gav({ action: 'cancel', at: '12:00' })]],
    ['ГАВ діють', '2026-11-18T09:00:00+02:00', [gav({ action: 'start' })]],
  ]
  it('"ГАВ діють" posted after a cancel announced for 12:00: on before 12:00, not known after (a reminder, or the cancel called off)', async () => {
    expect((await fold('zaporizhzhia', items, '2026-11-18T10:00:00+02:00')).state).toBe('active')
    expect((await fold('zaporizhzhia', items, '2026-11-18T13:00:00+02:00')).state).toBe('unknown')
    // without the word after it, the cancel stands
    expect((await fold('zaporizhzhia', items.slice(0, 2), '2026-11-18T13:00:00+02:00')).state).toBe(
      'inactive',
    )
  })

  it('"до 14:00" of an apply at 23:00 is the next day', async () => {
    const s = await fold(
      'zaporizhzhia',
      [['ГАВ до 14:00', '2026-11-17T23:00:00+02:00', [gav({ action: 'start', until: '14:00' })]]],
      '2026-11-18T12:30:00+02:00',
    )
    expect(s.state).toBe('active')
  })
})

describe('a shared channel: the second reading is asked whatever region the first put it under', () => {
  it('first reads an Odesa cancel as Kyiv, second and judge as Odesa: Odesa gets the cancel', async () => {
    const as = (region: string) => [ev({ kind: 'emergency', action: 'cancel', regions: [region] })]
    const ai = new AiRuntime({
      textProcessor: fakeText(() => as('kyiv')),
      verifyProcessor: fakeText(() => as('odesa'), 'second'),
      judgeProcessor: fakeText(() => as('odesa'), 'judge'),
    })
    const input = {
      url: 'https://t.me/dtek_ua/1',
      source: { kind: 'telegram' as const, channel: 'dtek_ua' },
      publishedAt: '2026-11-18T10:00:00+02:00',
      edited: false,
      title: null,
      text: 'Одеса: скасовано',
      replyTo: null,
      photoCount: 0,
      regions: (['kyiv', 'odesa'] as const).map(postRegion),
    }
    const odesa = await ai.analyzeEmergencyPost('odesa', input)
    expect(odesa.events.map((e) => e.regions)).toEqual([['odesa']])
    const kyiv = await ai.analyzeEmergencyPost('kyiv', input)
    expect(kyiv.events.map((e) => e.regions)).toEqual([['odesa']])
  })
})

describe('round 3', () => {
  it('"ще 2 черги" without ids after 1-3: five, which ones not known', async () => {
    const s = await fold(
      'zaporizhzhia',
      [
        ['ГАВ 1-3', '2026-11-18T08:00:00+02:00', [gav({ action: 'start', queues: ['1', '2', '3'] })]],
        [
          'ще 2 черги',
          '2026-11-18T09:00:00+02:00',
          [gav({ action: 'change', additive: true, queueCount: 2 })],
        ],
      ],
      '2026-11-18T09:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queues: null, queueCount: 5 })
  })

  it('a cancel announced for 12:00 covers another kind or area posted before it took effect', async () => {
    const cancel: [string, string, PostEvent[]] = [
      'о 12:00 скасовуються аварійні',
      '2026-11-18T08:00:00+02:00',
      [gav({ kind: 'emergency', action: 'cancel', at: '12:00' })],
    ]
    const s = await fold(
      'zaporizhzhia',
      [
        ['07:00 ГАВ', '2026-11-18T07:00:00+02:00', [gav({ action: 'start' })]],
        cancel,
        [
          'у м. Запоріжжя діють ГАВ',
          '2026-11-18T09:00:00+02:00',
          [gav({ action: 'start', area: 'м. Запоріжжя' })],
        ],
      ],
      '2026-11-18T13:00:00+02:00',
    )
    expect(s.state).toBe('unknown')
  })

  it('an unread post puts СГАВ in doubt where the operator announces it', async () => {
    const s = await fold(
      'zaporizhzhia',
      [
        ['СГАВ вчора скасовано', '2026-11-18T06:00:00+02:00', [gav({ kind: 'sgav', action: 'cancel' })]],
        ['незрозуміло', '2026-11-18T08:00:00+02:00', [gav({ kind: 'sgav', action: 'start' })], []],
        ['ГАВ 1-2', '2026-11-18T09:00:00+02:00', [gav({ action: 'start', queues: ['1', '2'] })]],
      ],
      '2026-11-18T09:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', kind: 'gav', unread: { url: 'https://t.me/x/2' } })
  })

  it('"1-5 ввімкнені" while only the count was known: fewer', async () => {
    const s = await fold(
      'kyiv',
      [
        [
          'в обсязі 10 черг',
          '2026-11-18T08:00:00+02:00',
          [ev({ kind: 'gav', action: 'start', regions: ['kyiv'], queueCount: 10 })],
        ],
        [
          '1-5 ввімкнені',
          '2026-11-18T09:00:00+02:00',
          [
            ev({
              kind: 'gav',
              action: 'change',
              regions: ['kyiv'],
              queuesRestored: ['1', '2', '3', '4', '5'],
            }),
          ],
        ],
      ],
      '2026-11-18T09:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queueCount: 5 })
  })

  it('a post taking effect later does not run the clock ahead of the posts after it', async () => {
    const s = await fold(
      'zaporizhzhia',
      [
        [
          'ГАВ 1-10',
          '2026-11-17T23:00:00+02:00',
          [gav({ action: 'start', queues: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] })],
        ],
        ['СГАВ з 14:00', '2026-11-18T08:00:00+02:00', [gav({ kind: 'sgav', action: 'start', at: '14:00' })]],
        [
          'скасовано 6-10',
          '2026-11-18T10:00:00+02:00',
          [gav({ action: 'cancel', queues: ['6', '7', '8', '9', '10'] })],
        ],
        ['СГАВ скасовано', '2026-11-18T16:00:00+02:00', [gav({ kind: 'sgav', action: 'cancel' })]],
      ],
      '2026-11-18T17:00:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', kind: 'gav', queues: ['1', '2', '3', '4', '5'] })
  })
})
