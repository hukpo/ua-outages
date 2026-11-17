import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { classifyPost, extractQueues, type Dialect } from '../../src/emergency/classify.js'
import { channelEvents, EMERGENCY_REGIONS } from '../../src/emergency/regions.js'
import { mykolaivFeedStatus } from '../../src/emergency/sources.js'
import { foldEvents } from '../../src/emergency/status.js'
import type { TelegramPost } from '../../src/emergency/telegram.js'
import { toKyivIso } from '../../src/time.js'
import type { EmergencyStatus, RegionId } from '../../src/types.js'
import { fixture, mockFetch } from '../helpers.js'
import { previewPage } from './preview.js'

/**
 * The second review round (two more independent reviews). A false "cancelled" is worse than a
 * false "on", and a false "applied" right away is bad too (apps notify on it).
 */
const POSTS: Record<string, { at: string; text: string }> = JSON.parse(fixture('telegram/posts.json')).posts
const AT = new Date('2026-11-15T10:00:00Z')
const channel = (region: RegionId) => EMERGENCY_REGIONS[region]!.channels![0]!
const dialect = (region: RegionId): Dialect => channel(region).dialect ?? {}
const read = (region: RegionId, text: string, at = AT) => classifyPost(text, at, dialect(region))

function fold(region: RegionId, items: ([string] | [string, string])[], now: string) {
  const posts: TelegramPost[] = items.map((item, i) => {
    const [key, at] = item
    const p = at ? { at, text: key } : POSTS[key]
    if (!p) throw new Error(`no post ${key}`)
    return {
      channel: 'x',
      id: i + 1,
      url: at ? `extra/${i}` : `https://t.me/${key}`,
      at: toKyivIso(new Date(p.at)),
      text: p.text,
      edited: false,
      photos: [],
    }
  })
  return foldEvents(
    channelEvents(posts, channel(region)).filter((e) => Date.parse(e.posted) <= Date.parse(now)),
    { region, now: new Date(now), ttlHours: EMERGENCY_REGIONS[region]!.ttlHours ?? 12, source: 'telegram' },
  )
}

describe('A. an expired episode does not carry into the next', () => {
  it('Sumy 02.11 (all ten) then 03.11 "в обсязі однієї черги": a new episode with one queue', () => {
    const s = fold(
      'sumy',
      [['SumyEnergo/3813'], ['SumyEnergo/3816'], ['SumyEnergo/3817'], ['SumyEnergo/3829']],
      '2026-11-03T08:00:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queues: null, queueCount: 1 })
    expect(Date.parse(s.since!)).toBe(Date.parse(POSTS['SumyEnergo/3829']!.at))
  })

  it('Sumy 03.11 "для всіх 10 черг" then 05.11 "для 1-5 черг": 1–5, since 05.11', () => {
    const s = fold('sumy', [['SumyEnergo/3831'], ['SumyEnergo/3847']], '2026-11-05T10:00:00+02:00')
    expect(s).toMatchObject({ state: 'active', queues: ['1', '2', '3', '4', '5'], queueCount: 5 })
    expect(Date.parse(s.since!)).toBe(Date.parse(POSTS['SumyEnergo/3847']!.at))
  })

  it('Poltava 03.11 "в повному обсязі" then 05.11 "в обсязі 5 черг": count 5', () => {
    const s = fold('poltava', [['poltavaOE/4467'], ['poltavaOE/4479']], '2026-11-05T10:00:00+02:00')
    expect(s).toMatchObject({
      state: 'active',
      queueCount: 5,
      queues: null,
      since: '2026-11-05T09:11:00+02:00',
    })
  })

  it('a count announcement within an episode drops queue ids that no longer fit', () => {
    const s = fold(
      'poltava',
      [
        ['poltavaOE/4504'],
        [
          'В області застосовано ГАВ! О 10:00 отримана команда НЕК ввести ГАВ в обсязі 10 черг.',
          '2026-11-09T08:01:00Z',
        ],
      ],
      '2026-11-09T10:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queueCount: 10, queues: null })
  })
})

describe('B. an orphan partial or scoped cancel is not a region-wide "cancelled"', () => {
  it('"О 11:00 скасовано ГАВ для 6-10 черг." alone → unknown', () => {
    const s = fold(
      'poltava',
      [['ГАВ скасовано! О 11:00 скасовано ГАВ для 6-10 черг.', '2026-11-09T09:01:00Z']],
      '2026-11-09T12:00:00+02:00',
    )
    expect(s).toMatchObject({ state: 'unknown', kind: 'gav' })
    expect(s.message).not.toBeNull()
  })

  it('an area cancel alone → unknown, with the area', () => {
    const s = fold(
      'dnipro-cek',
      [
        [
          '📢 Шановні споживачі м. ПАВЛОГРАД ‼️ Повідомляємо про скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ ‼️',
          '2026-11-13T14:54:00Z',
        ],
      ],
      '2026-11-13T18:00:00+02:00',
    )
    expect(s).toMatchObject({ state: 'unknown', area: 'м. Павлоград' })
  })

  it('a full cancel alone is still a cancellation', () => {
    expect(fold('poltava', [['poltavaOE/4546']], '2026-11-16T03:00:00+02:00').state).toBe('inactive')
  })
})

describe('C. YASNO', () => {
  const shutdowns = fixture('yasno/planned-outages-EmergencyShutdowns.community-2025-11-25.json')
  const applies = JSON.stringify(
    Object.fromEntries(
      Object.entries(JSON.parse(shutdowns))
        .filter(([k]) => /^\d/.test(k))
        .map(([k, g]) => {
          const group = g as { today: object; tomorrow: object }
          return [
            k,
            {
              today: { ...group.today, status: 'ScheduleApplies' },
              tomorrow: { ...group.tomorrow, status: 'ScheduleApplies' },
              updatedOn: '2025-11-25T09:00:00+00:00',
            },
          ]
        }),
    ),
  )

  it('a YASNO-ended episode stays ended while only older posts exist', async () => {
    let yasno = shutdowns
    const { fetch } = mockFetch([
      {
        match: 't.me/s/dtek_ua',
        body: previewPage('dtek_ua', [
          {
            id: 1,
            at: '2025-11-25T07:00:00Z',
            text:
              POSTS['dtek_ua/4577']?.text ?? '‼️Київ: за командою Укренерго застосовані екстрені відключення',
          },
        ]),
      },
      { match: '/regions/25/dsos/902/planned-outages', body: () => yasno },
    ])
    const c = new OutageClient({ fetch, now: () => new Date('2025-11-25T12:00:00+02:00'), cacheTtlMs: 0 })
    expect((await c.getEmergency('kyiv')).state).toBe('active')
    yasno = applies
    expect(await c.getEmergency('kyiv')).toMatchObject({ state: 'inactive', source: 'yasno' })
    // the second reading of ScheduleApplies used to revive the old Telegram apply
    expect(await c.getEmergency('kyiv')).toMatchObject({
      state: 'inactive',
      source: 'yasno',
      endedAt: '2025-11-25T11:00:00+02:00',
    })
  })

  it('a newer apply post after YASNO ended it is a new episode', async () => {
    let posts = [
      {
        id: 1,
        at: '2025-11-25T07:00:00Z',
        text: '‼️Київ: за командою Укренерго застосовані екстрені відключення',
      },
    ]
    let yasno = shutdowns
    const { fetch } = mockFetch([
      { match: 't.me/s/dtek_ua', body: () => previewPage('dtek_ua', posts) },
      { match: '/regions/25/dsos/902/planned-outages', body: () => yasno },
    ])
    const c = new OutageClient({ fetch, now: () => new Date('2025-11-25T12:00:00+02:00'), cacheTtlMs: 0 })
    await c.getEmergency('kyiv', { fresh: true })
    yasno = applies
    await c.getEmergency('kyiv', { fresh: true })
    posts = [
      ...posts,
      {
        id: 2,
        at: '2025-11-25T09:50:00Z',
        text: '‼️Київ: за командою Укренерго запроваджені екстрені відключення',
      },
    ]
    expect(await c.getEmergency('kyiv', { fresh: true })).toMatchObject({
      state: 'active',
      source: 'telegram',
    })
  })

  it('after a restart, `previous` lets a YASNO-only episode end', async () => {
    const { fetch } = mockFetch([
      {
        match: 't.me/s/dtek_ua',
        body: previewPage('dtek_ua', [{ id: 1, at: '2025-11-24T07:00:00Z', text: 'Підписуйтесь на канал' }]),
      },
      { match: '/regions/25/dsos/902/planned-outages', body: applies },
    ])
    const previous: EmergencyStatus = {
      region: 'kyiv',
      state: 'active',
      kind: 'emergency',
      scheduleApplies: false,
      since: '2025-11-25T09:11:46+02:00',
      endedAt: null,
      queues: null,
      queueCount: null,
      area: null,
      inferred: false,
      message: { text: 'YASNO: EmergencyShutdowns', url: null, at: '2025-11-25T09:11:46+02:00' },
      source: 'yasno',
      fetchedAt: '2025-11-25T10:00:00+02:00',
    }
    const now = () => new Date('2025-11-25T12:00:00+02:00')
    expect((await new OutageClient({ fetch, now, cacheTtlMs: 0 }).getEmergency('kyiv')).message).toBeNull()
    const s = await new OutageClient({ fetch, now, cacheTtlMs: 0 }).getEmergency('kyiv', { previous })
    expect(s).toMatchObject({ state: 'inactive', source: 'yasno', since: '2025-11-25T09:11:46+02:00' })
    expect(s.endedAt).toBeTruthy()
  })
})

describe('D. what takes effect later is not in force yet', () => {
  it('Sumy 3921 "О 19:00 - заміна черг" posted 18:52: at 18:55 still 1–5', () => {
    const ids: [string][] = [['SumyEnergo/3919'], ['SumyEnergo/3921']]
    expect(fold('sumy', ids, '2026-11-15T18:55:00+02:00')).toMatchObject({
      queues: ['1', '2', '3', '4', '5'],
    })
    expect(fold('sumy', ids, '2026-11-15T19:01:00+02:00')).toMatchObject({
      queues: ['6', '7', '8', '9', '10'],
    })
  })

  it('"З 18:00 будуть застосовуватися…" posted at noon: today 18:00, pending until then', () => {
    const text =
      'За вказівкою НЕК «Укренерго» з 18:00 на Сумщині будуть застосовуватися графіки аварійних відключень.'
    expect(read('sumy', text, new Date('2026-11-15T10:00:00Z'))!.at).toBe('2026-11-15T18:00:00+02:00')
    expect(fold('sumy', [[text, '2026-11-15T10:00:00Z']], '2026-11-15T13:00:00+02:00')).toMatchObject({
      state: 'inactive',
      kind: null,
    })
    expect(fold('sumy', [[text, '2026-11-15T10:00:00Z']], '2026-11-15T18:10:00+02:00')).toMatchObject({
      state: 'active',
    })
  })

  it('"з 16.11" is a date, not 16:11', () => {
    const a = read(
      'sumy',
      'На Сумщині з 16.11 застосовані графіки аварійних відключень.',
      new Date('2026-11-15T08:00:00Z'),
    )
    expect(a!.at).not.toBe('2026-11-14T16:11:00+02:00')
    expect(a!.timed).toBe(false)
    // a dot time that can't be a date still reads: Ternopil "з 18.00", "з 22.27"
    expect(
      read('ternopil', POSTS['ternopiloblenerho/1141']!.text, new Date(POSTS['ternopiloblenerho/1141']!.at))!
        .at,
    ).toBe('2025-10-15T22:27:00+03:00')
  })
})

describe('E. ordinary wording is not a cancellation', () => {
  for (const text of [
    'Графіки аварійних відключень діятимуть до завершення ремонтних робіт.',
    'На Харківщині тривають аварійні відключення до завершення відновлювальних робіт.',
    'В області застосовано ГАВ до припинення дефіциту потужності.',
    'Інформація про скасування аварійних відключень на Харківщині не відповідає дійсності.',
  ])
    it(text, () => {
      expect(read('kharkiv', text)?.action).not.toBe('cancel')
    })

  for (const text of [
    'Графіки погодинних відключень скасовано, натомість застосовано графіки аварійних відключень.',
    'ГПВ скасовано, діють ГАВ.',
    'ГПВ на Харківщині замінено на графіки аварійних відключень.',
    'ГПВ відмінено та застосовано ГАВ в обсязі 5 черг.',
  ])
    it(`${text} → apply`, () => {
      expect(read('kharkiv', text)).toMatchObject({ action: 'apply' })
    })

  it('ГПВ cancelled means ГПВ is suspended', () => {
    expect(
      read(
        'kharkiv',
        'Графіки погодинних відключень скасовано, натомість застосовано графіки аварійних відключень.',
      ),
    ).toMatchObject({
      scheduleApplies: false,
    })
  })

  it('"ГАВ замінено на графіки погодинних відключень" is still a cancel', () => {
    expect(read('kharkiv', 'ОНОВЛЕНО: ГАВ замінено на графіки погодинних відключень')).toMatchObject({
      action: 'cancel',
    })
  })
})

describe('F. hypothetical, conditional and past wording is not an apply', () => {
  for (const [region, text] of [
    ['kharkiv', 'У разі перевищення лімітів споживання будуть застосовані графіки аварійних відключень.'],
    ['kharkiv', 'Завтра в області можуть бути застосовані ГАВ.'],
    ['kharkiv', 'Можливе застосування графіків аварійних відключень.'],
    ['kharkiv', 'Економте електроенергію, щоб уникнути застосування аварійних відключень.'],
    ['kharkiv', 'Дякуємо за терпіння під час застосування ГАВ.'],
    ['kharkiv', 'Вчора на Харківщині було застосовано ГАВ.'],
    [
      'kirovohrad',
      'Зверніть увагу: у разі одночасного введення в дію ГАВ та ГПВ час відключення може бути збільшено.',
    ],
  ] as const)
    it(text.slice(0, 70), () => {
      expect(read(region, text)?.action ?? null).not.toBe('apply')
    })

  it('real applies with the noun still are', () => {
    expect(read('poltava', POSTS['poltavaOE/4467']!.text)).toMatchObject({ action: 'apply' })
    expect(read('dnipro-cek', POSTS['cek_info/4340']!.text)).toMatchObject({ action: 'apply', kind: 'sgav' })
    expect(
      read(
        'ivano-frankivsk',
        'До уваги споживачів! Від НЕК «Укренерго» надійшла вказівка про введення графіків аварійних вимкнень в Івано-Франківській області.',
      ),
    ).toMatchObject({ action: 'apply' })
  })
})

describe('G. Mykolaiv feed ends are inferred', () => {
  it('rows that finished give inactive with inferred: true', () => {
    const s = mykolaivFeedStatus(
      [
        {
          id: 1,
          type: 'GAO',
          start_at: '2026-11-03T00:30:00Z',
          finish_at: '2026-11-03T02:50:00Z',
          reason: 'Графік аварійних відключень | ГАВ черга 1',
        },
      ],
      'mykolaiv',
      new Date('2026-11-03T06:00:00Z'),
    )
    expect(s).toMatchObject({ state: 'inactive', inferred: true })
  })
})

describe('H. an unreadable post while one runs', () => {
  it('keeps it active', () => {
    const s = fold(
      'poltava',
      [['poltavaOE/4504'], ['Оновлена інформація щодо ГАВ на Полтавщині.', '2026-11-09T08:30:00Z']],
      '2026-11-09T11:00:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queues: ['1', '2', '3', '4', '5'] })
  })

  it('"ГАВ: вимкнено 6 та 7 черги" is an update with those queues off', () => {
    expect(read('poltava', 'ГАВ: вимкнено 6 та 7 черги.')).toMatchObject({
      action: 'update',
      queues: ['6', '7'],
    })
    const s = fold(
      'poltava',
      [['poltavaOE/4504'], ['ГАВ: вимкнено 6 та 7 черги.', '2026-11-09T08:30:00Z']],
      '2026-11-09T11:00:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queues: ['1', '2', '3', '4', '5', '6', '7'] })
  })

  it('Mykolaiv "Ситуація по ГАВ станом на 12:45: …"', () => {
    const text =
      'Ситуація по ГАВ станом на 12:45:\n♦️9,10,1,2 черги знеструмлюємо;\n♦️7,8 - залишаються відключеними;\n♦️3,4,5,6 - будуть заживлені.'
    expect(read('mykolaiv', text, new Date('2024-11-11T10:50:00Z'))).toMatchObject({
      action: 'update',
      queues: ['1', '2', '7', '8', '9', '10'],
      restored: ['3', '4', '5', '6'],
    })
  })
})

describe('I. a queue number is not a count', () => {
  it('"Застосовано 3 чергу ГАВ", "ГАВ для 3 черги" name queue 3', () => {
    expect(extractQueues('Застосовано 3 чергу ГАВ')).toMatchObject({ list: ['3'], count: 1 })
    expect(extractQueues('введено ГАВ для 3 черги')).toMatchObject({ list: ['3'] })
  })

  it('counts stay counts: "1 чергу", "2 черги", "10 черг"', () => {
    expect(extractQueues('застосовано 1 чергу Графіка аварійних відключень')).toEqual({
      list: null,
      count: 1,
      all: false,
    })
    expect(extractQueues('вводяться в дію 2 черги графіків аварійних відключень')).toEqual({
      list: null,
      count: 2,
      all: false,
    })
    expect(extractQueues('застосовано 10 черг')).toEqual({ list: null, count: 10, all: false })
  })
})

describe('J. Kharkiv TTL', () => {
  it('stays 12 h: its own episodes ran up to ~16 h (10.10 07:56 → cancelled "станом на 23:54")', () => {
    expect(EMERGENCY_REGIONS.kharkiv!.ttlHours).toBeUndefined()
  })
})
