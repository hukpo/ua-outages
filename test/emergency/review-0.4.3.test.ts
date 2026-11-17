import { describe, expect, it } from 'vitest'
import {
  classifyPost,
  classifyPostAll,
  classifyUkrenergo,
  type Dialect,
} from '../../src/emergency/classify.js'
import { channelEvents, EMERGENCY_REGIONS } from '../../src/emergency/regions.js'
import { foldEvents } from '../../src/emergency/status.js'
import type { TelegramPost } from '../../src/emergency/telegram.js'
import type { RegionId } from '../../src/types.js'

/**
 * The independent review of 0.4.3 (six reviewers, 17.11.2026) and the day's two real misses.
 * The rule stays: a false "cancelled" is worse than a false "still on" (the TTL ends that).
 * Texts marked "real" were posted by the operator; the rest are in operators' wording.
 */
const channel = (region: RegionId) => EMERGENCY_REGIONS[region]!.channels![0]!
const dialect = (region: RegionId): Dialect => channel(region).dialect ?? {}
const kyiv = (hhmm: string, day = '2026-11-17') => `${day}T${hhmm}:00+02:00`
const read = (region: RegionId, text: string, at = kyiv('12:00')) =>
  classifyPost(text, new Date(at), dialect(region))

/** Folds [text, Kyiv "HH:MM" or ISO] posts for a region at `now` (Kyiv "HH:MM" or ISO). */
function fold(region: RegionId, items: [string, string][], now: string, ttlHours = 12) {
  const iso = (t: string) => (t.length === 5 ? kyiv(t) : t)
  const posts: TelegramPost[] = items.map(([text, at], i) => ({
    channel: 'x',
    id: i + 1,
    url: `https://t.me/x/${i + 1}`,
    at: iso(at),
    text,
    edited: false,
    photos: [],
  }))
  return foldEvents(channelEvents(posts, channel(region)), {
    region,
    now: new Date(iso(now)),
    ttlHours,
    source: 'telegram',
  })
}

const APPLY: [string, string] = ['Застосовано ГАВ для 1-5 черг.', '10:00']

describe('words of cancelling that cancel nothing', () => {
  const hedges = [
    // the two patterns added on 17.11 must not fire on these
    'Відміна дії графіку ГАВ не планується.',
    'Очікується відміна дії графіку ГАВ.',
    'Відміна ГАВ очікується після стабілізації ситуації в енергосистемі.',
    'Відміна дії графіку ГАВ можлива лише за командою НЕК «Укренерго».',
    'Відміна графіків аварійних відключень залежить від ситуації в енергосистемі.',
    'Орієнтовно о 18:00 буде відміна ГАВ.',
    'Завтра скасовуються графіки аварійних відключень.',
    'Графіки аварійних відключень скасовуються лише за командою НЕК «Укренерго».',
    'ГАВ скасовуються тільки після команди диспетчера Укренерго.',
    'Щойно ситуація стабілізується, графіки аварійних відключень скасовуються.',
    'ГАВ скасовуватимуться поступово, у міру стабілізації.',
    // and the older stems, which had no guard
    'Про скасування ГАВ повідомимо додатково.',
    'Команда про скасування ГАВ поки не надходила.',
    'Чекаємо на команду Укренерго про скасування графіків аварійних відключень.',
    'Інформації про скасування аварійних відключень наразі немає.',
    'Аварійні відключення будуть відмінені після стабілізації ситуації в енергосистемі.',
    'ГАВ буде припинено після стабілізації.',
    'ГАВ буде відмінено орієнтовно о 18:00.',
    'Дію ГАВ буде завершено о 20:00.',
  ]
  for (const text of hedges)
    it(text, () => {
      expect(read('poltava', text)?.action).not.toBe('cancel')
      expect(fold('poltava', [APPLY, [text, '12:00']], '14:00')).toMatchObject({ state: 'active' })
    })

  it('"припинено електропостачання споживачів 1 та 2 черг ГАВ" is the outage, not its end', () => {
    const text = 'За командою Укренерго припинено електропостачання споживачів 1 та 2 черг ГАВ.'
    expect(read('poltava', text)?.action).not.toBe('cancel')
    expect(
      fold(
        'poltava',
        [
          ['Застосовано ГАВ для 1 та 2 черг.', '10:00'],
          [text, '10:20'],
        ],
        '11:00',
      ),
    ).toMatchObject({ state: 'active' })
  })

  it('DTEK: "поки не повертаємось до графіків", "завтра повертаємось"', () => {
    const on: [string, string] = ['Київ: застосовані екстрені відключення.', '10:00']
    for (const text of ['Київ: поки не повертаємось до графіків.', 'Київ: завтра повертаємось до графіків.'])
      expect(fold('kyiv', [on, [text, '12:00']], '13:00')).toMatchObject({ state: 'active' })
    expect(fold('kyiv', [on, ['Київ: повертаємось до графіків.', '12:00']], '13:00')).toMatchObject({
      state: 'inactive',
    })
  })
})

describe('cancellations in other words', () => {
  const cancels = [
    // real, 17.11.2026: cek_info/4419 and SvitloKropyvnytskyiMisto/1834
    'Попереджаємо, що за командою диспетчерського центру НЕК "Укренерго" скасовуються графіки аварійних відключень‼️ Повертаємося до ГРАФІКІВ ПОГОДИННИХ ВІДКЛЮЧЕНЬ‼️',
    'В 11:05 відміна дії графіку ГАВ',
    'З 11:05 припиняється дія графіків аварійних відключень.',
    'Укренерго скасувало графіки аварійних відключень.',
    'Диспетчери відмінили ГАВ.',
    'ГАВ зняті.',
    'Відбій ГАВ!',
    'Дія ГАВ закінчилась о 11:00.',
    'Аварійні відключення: повертаємось до ГПВ.',
    // when it was applied, or what replaces it, said in the same sentence
    'Графіки аварійних відключень, які були застосовані о 10:00, скасовано.',
    'Аварійні відключення скасовано, графіки погодинних відключень діють згідно з оприлюдненим розкладом.',
    'Скасовано ГАВ, введені сьогодні о 10:00.',
    'В 11:05 відміна дії графіку ГАВ, введеного о 10:00.',
    'ГАВ, застосовані о 10:00, скасовано о 11:05.',
    'ГАВ скасовано, ГПВ діють.',
    'Скасовано ГАВ та введено в дію ГПВ.',
    'ГАВ скасовано, діють графіки.',
  ]
  for (const text of cancels)
    it(text, () => {
      expect(read('poltava', text)).toMatchObject({ action: 'cancel' })
      expect(fold('poltava', [APPLY, [text, '12:00']], '14:00')).toMatchObject({ state: 'inactive' })
    })

  it('the other way round still applies', () => {
    for (const text of [
      'Графіки погодинних відключень скасовано, введені графіки аварійних відключень.',
      'ГПВ відмінено та застосовано ГАВ.',
      'Скасовано ГПВ, застосовано ГАВ для 1-5 черг.',
    ])
      expect(read('poltava', text)).toMatchObject({ action: 'apply' })
  })

  it('an edit under the text: "UPD: ГАВ скасовано"', () => {
    const text = 'Застосовано ГАВ.\n\nUPD: ГАВ скасовано.'
    expect(read('poltava', text)).toMatchObject({ action: 'cancel', edited: true })
    expect(fold('poltava', [[text, '10:00']], '14:00')).toMatchObject({ state: 'inactive' })
  })
})

describe('applying in other words', () => {
  for (const text of [
    'Запроваджуються графіки аварійних відключень.',
    'Уведено ГАВ для 1-3 черг.',
    'Застосовуємо ГАВ.',
  ])
    it(text, () => expect(read('poltava', text)).toMatchObject({ action: 'apply' }))

  it('"ГАВ діятимуть з 18:00": on from 18:00', () => {
    const post: [string, string] = ['ГАВ діятимуть з 18:00.', '12:00']
    expect(fold('poltava', [post], '17:00').state).not.toBe('active')
    expect(fold('poltava', [post], '19:00')).toMatchObject({ state: 'active', since: kyiv('18:00') })
  })
})

describe('times', () => {
  it('the present tense with a time ahead is tonight, not last night', () => {
    const cancel: [string, string] = ['З 18:00 скасовуються графіки аварійних відключень.', '14:00']
    expect(fold('poltava', [APPLY, cancel], '14:30')).toMatchObject({ state: 'active' })
    expect(fold('poltava', [APPLY, cancel], '18:30')).toMatchObject({
      state: 'inactive',
      endedAt: kyiv('18:00'),
    })
    expect(read('poltava', 'З 20:00 застосовуються ГАВ для 1-3 черг.', kyiv('14:10'))).toMatchObject({
      action: 'apply',
      at: kyiv('20:00'),
    })
    // a late report stays in the past
    expect(read('poltava', 'З 21:00 застосовуються ГАВ.', kyiv('02:00'))).toMatchObject({
      at: kyiv('21:00', '2026-11-16'),
    })
  })

  it('"О 18: 52" (a space after the colon) is a time', () => {
    expect(read('poltava', 'О 18: 52 скасовано 2 черги СГАВ.', kyiv('19:36'))).toMatchObject({
      action: 'cancel',
      at: kyiv('18:52'),
      count: 2,
    })
  })

  it('"до кінця доби" outlives the TTL', () => {
    const post: [string, string] = ['Застосовано ГАВ до кінця доби.', '06:00']
    expect(fold('poltava', [post], '19:00')).toMatchObject({ state: 'active' })
    expect(fold('poltava', [post], kyiv('00:30', '2026-11-18'))).toMatchObject({
      state: 'inactive',
      inferred: true,
    })
  })
})

describe('two schedules in one post', () => {
  it('Poltava 16.11.2026 (real posts 4554–4558): СГАВ ends with "О 20:45 відміна СГАВ"', () => {
    const d = '2026-11-16'
    const posts: [string, string][] = [
      ['О 17:02 застосовано СГАВ.', kyiv('17:05', d)],
      ['СГАВ скасовано!\nО 18: 52 скасовано 2 черги СГАВ.', kyiv('19:36', d)],
      ['ГАВ скасовано!\nО 21:07 скасовано ГАВ (6-10 черги. О 20:45 відміна СГАВ.', kyiv('21:10', d)],
      ['О 21:35 скасовано ГАВ в повному обсязі.', kyiv('21:36', d)],
    ]
    expect(classifyPostAll(posts[2]![0], new Date(posts[2]![1]), dialect('poltava'))).toMatchObject([
      {
        action: 'cancel',
        kind: 'gav',
        queues: ['6', '7', '8', '9', '10'],
        partial: true,
        at: kyiv('21:07', d),
      },
      { action: 'cancel', kind: 'sgav', partial: false, at: kyiv('20:45', d) },
    ])
    expect(fold('poltava', posts.slice(0, 2), kyiv('20:00', d))).toMatchObject({
      state: 'active',
      kind: 'sgav',
    })
    expect(fold('poltava', posts, kyiv('22:00', d))).toMatchObject({ state: 'inactive' })
  })

  it('"Застосовано ГАВ та СГАВ", then "Скасовано ГАВ": СГАВ stays', () => {
    const both: [string, string] = ['Застосовано ГАВ та СГАВ.', '10:00']
    expect(fold('poltava', [both, ['Скасовано ГАВ.', '13:00']], '14:00')).toMatchObject({
      state: 'active',
      kind: 'sgav',
    })
    expect(fold('poltava', [both, ['Скасовано ГАВ і СГАВ.', '13:00']], '14:00')).toMatchObject({
      state: 'inactive',
    })
  })
})

describe('partial cancels', () => {
  it('"частково" in the next sentence', () => {
    const s = fold('poltava', [APPLY, ['Дію ГАВ скасовано.\nЧастково, для 1 та 2 черг.', '13:00']], '14:00')
    expect(s).toMatchObject({ state: 'active' })
  })

  it('the same queues lifted twice are lifted once', () => {
    const cancel = 'Скасовано ГАВ для 1, 2 та 3 черг.'
    const s = fold(
      'poltava',
      [
        ['Застосовано ГАВ в обсязі 5 черг.', '10:00'],
        [cancel, '11:00'],
        [cancel, '12:00'],
      ],
      '12:30',
    )
    expect(s).toMatchObject({ state: 'active', queueCount: 2 })
  })

  it("the ГПВ volume in a cancel is not the cancel's queues", () => {
    const text = 'ГАВ скасовано, з 16:00 діють погодинні відключення в обсязі 1,5 черги.'
    expect(read('poltava', text, kyiv('14:00'))).toMatchObject({
      action: 'cancel',
      partial: false,
      queues: null,
      timed: false,
    })
    expect(read('poltava', 'ГАВ скасовано, застосовано ГПВ в обсязі 2 черг.')).toMatchObject({
      action: 'cancel',
      partial: false,
    })
  })
})

describe('areas', () => {
  it('a district named at the start of the sentence', () => {
    const s = fold(
      'chernihiv',
      [
        ['Застосовано ГАВ у Ніжинському районі.', '10:00'],
        ['Застосовано ГАВ у Прилуцькому районі.', '10:10'],
        ['У Ніжинському районі ГАВ скасовано.', '12:00'],
      ],
      '13:00',
    )
    expect(s).toMatchObject({ state: 'active', area: 'Прилуцькому районі' })
  })

  it('"і" and "та" name the same districts', () => {
    const s = fold(
      'chernihiv',
      [
        ['Застосовано ГАВ у Ніжинському і Прилуцькому районах.', '10:00'],
        ['ГАВ скасовано у Ніжинському та Прилуцькому районах.', '12:00'],
      ],
      '13:00',
    )
    expect(s).toMatchObject({ state: 'inactive' })
  })

  it("a cancel for one city leaves another's on", () => {
    const s = fold(
      'poltava',
      [
        ['Застосовано ГАВ у м. Полтава.', '10:00'],
        ['Скасовано ГАВ у м. Кременчук.', '13:00'],
      ],
      '14:00',
    )
    expect(s).toMatchObject({ state: 'active', area: 'м. Полтава' })
    expect(
      fold(
        'poltava',
        [
          ['Застосовано ГАВ у м. Полтава.', '10:00'],
          ['Скасовано ГАВ у м. Полтаві.', '13:00'],
        ],
        '14:00',
      ),
    ).toMatchObject({ state: 'inactive' })
  })

  it('Sumy, real (17.11.2026): "по м. Суми введені графіки аварійних відключень для 1-10 черг"', () => {
    expect(
      read('sumy', 'О 10:50 по м. Суми введені графіки аварійних відключень для 1-10 черг споживачів.'),
    ).toMatchObject({ action: 'apply', area: 'м. Суми' })
  })

  it('DTEK: "у зв\'язку з обстрілом" is not a place', () => {
    const s = fold(
      'kyiv',
      [
        ["Київ: застосовані екстрені відключення у зв'язку з обстрілом.", '10:00'],
        ["Київ: скасовані екстрені відключення у зв'язку зі стабілізацією.", '12:00'],
      ],
      '13:00',
    )
    expect(s).toMatchObject({ state: 'inactive' })
  })
})

describe('"крім", "окрім": said about everyone else', () => {
  it("the operator's own post", () => {
    const on: [string, string] = ['На Харківщині застосовано аварійні відключення.', '10:00']
    const s = fold(
      'kharkiv',
      [on, ['Аварійні відключення скасовані в усіх регіонах, окрім Харківщини.', '12:00']],
      '13:00',
    )
    expect(s).toMatchObject({ state: 'active' })
  })

  it('Ukrenergo', () => {
    const at = new Date(kyiv('12:00'))
    expect(
      classifyUkrenergo(
        'Аварійні відключення скасовано в усіх областях, крім Харківської.',
        at,
        'Харківськ|Харківщин',
      ),
    ).toBeNull()
    expect(
      classifyUkrenergo(
        'В усіх регіонах України, крім Закарпатської області, застосовані аварійні відключення.',
        at,
        'Закарпатськ|Закарпатт',
      ),
    ).toBeNull()
    expect(
      classifyUkrenergo(
        'Про скасування аварійних відключень у Закарпатській області повідомимо додатково.',
        at,
        'Закарпатськ|Закарпатт',
      ),
    ).toBeNull()
  })
})
