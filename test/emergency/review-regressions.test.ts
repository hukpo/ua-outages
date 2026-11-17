import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { classifyPost, type Dialect } from '../../src/emergency/classify.js'
import { cekArea, channelEvents, EMERGENCY_REGIONS, headParts } from '../../src/emergency/regions.js'
import { foldEvents } from '../../src/emergency/status.js'
import type { TelegramPost } from '../../src/emergency/telegram.js'
import { toKyivIso } from '../../src/time.js'
import type { RegionId } from '../../src/types.js'
import { fixture, mockFetch } from '../helpers.js'
import { previewPage } from './preview.js'

/**
 * One test per defect found by the independent review of 0.3.0. Guiding rule: a false
 * "cancelled" is worse than a false "still on" (the TTL ends that).
 */
const POSTS: Record<string, { at: string; text: string }> = JSON.parse(fixture('telegram/posts.json')).posts
const AT = new Date('2026-11-15T10:00:00Z')

const channel = (region: RegionId) => EMERGENCY_REGIONS[region]!.channels![0]!
const dialect = (region: RegionId): Dialect => channel(region).dialect ?? {}
const read = (region: RegionId, text: string, at = AT) => classifyPost(text, at, dialect(region))

/** Folds posts given as [channel/id] or [text, ISO time] for a region at `now`. */
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
  const c = channel(region)
  return foldEvents(
    channelEvents(posts, c).filter((e) => Date.parse(e.posted) <= Date.parse(now)),
    { region, now: new Date(now), ttlHours: EMERGENCY_REGIONS[region]!.ttlHours ?? 12, source: 'telegram' },
  )
}

describe('1. YASNO', () => {
  it('ЦЕК has no YASNO source (3/303 never shows EmergencyShutdowns)', async () => {
    expect(EMERGENCY_REGIONS['dnipro-cek']!.yasno).toBeUndefined()
    const { fetch, calls } = mockFetch([
      { match: 't.me/s/cek_info', body: fixture('telegram/cek_info-4315-4316.trimmed.html') },
    ])
    const c = new OutageClient({ fetch, now: () => new Date('2026-11-04T14:00:00+02:00'), cacheTtlMs: 0 })
    await c.getEmergency('dnipro-cek')
    expect(calls.some((x) => x.url.includes('yasno'))).toBe(false)
  })
  // the other YASNO cases are in get-emergency.test.ts ("YASNO ends only an emergency it showed itself")
})

describe('2. negations, conditions and the future are not cancellations', () => {
  const notCancel = [
    'Графіки аварійних відключень не скасовано, вони продовжують діяти.',
    'ГАВ поки що не скасовано.',
    '‼️ За вказівкою НЕК "Укренерго" 16 листопада з 00:00 до 24:00 у Харківській області будуть діяти графіки погодинних відключень (ГПВ). Графіки аварійних відключень скасовано не буде.',
    'Графіки аварійних відключень можуть бути скасовані у будь-який момент.',
    'Скасування ГАВ залежить від ситуації в енергосистемі.',
    'Після скасування ГАВ будуть діяти графіки погодинних відключень (ГПВ).',
    'Графіки аварійних відключень діятимуть до окремої вказівки НЕК «Укренерго» про їх скасування.',
  ]
  for (const text of notCancel)
    it(text.slice(0, 70), () => {
      expect(read('kharkiv', text)?.action).not.toBe('cancel')
    })

  it('"не скасовано, вони продовжують діяти" says it is still on', () => {
    expect(read('kharkiv', notCancel[0]!)).toMatchObject({ action: 'apply' })
  })

  it('"аварійні відключення не застосовуються" is neither an apply nor a cancel (ignored)', () => {
    // research/kharkiv/gav/jsonapi-newsforlenta-title-avariin.json
    expect(
      read(
        'kharkiv',
        'Наразі в усіх постраждалих від обстрілу регіонах аварійні відключення не застосовуються.',
      ),
    ).toBeNull()
    expect(read('kharkiv', 'Аварійні відключення на Харківщині не застосовуються.')).toBeNull()
    expect(read('kharkiv', 'ГАВ на Харківщині наразі не діють.')).toBeNull()
  })

  it('real cancellations still are', () => {
    expect(read('poltava', POSTS['poltavaOE/4456']!.text)).toMatchObject({ action: 'cancel' })
    expect(read('dnipro-cek', POSTS['cek_info/4316']!.text)).toMatchObject({ action: 'cancel' })
    // cek_info/4419, 17.11.2026: the present tense, read as "emergency outages in force" for hours
    expect(
      read(
        'dnipro-cek',
        '📢 Шановні споживачі м. ДНІПРО‼️\n\nПопереджаємо, що за командою диспетчерського центру НЕК "Укренерго" скасовуються ЕКСТРЕНІ ВІДКЛЮЧЕННЯ‼️ Повертаємося до ГРАФІКІВ ПОГОДИННИХ ВІДКЛЮЧЕНЬ‼️',
      ),
    ).toMatchObject({ action: 'cancel' })
    // SvitloKropyvnytskyiMisto/1834, 17.11.2026: the noun, ГАВ stayed "in force" all afternoon
    expect(read('kirovohrad', 'В 14:05 відміна дії графіку ГАВ')).toMatchObject({
      action: 'cancel',
    })
    // the future and the conditional still don't cancel
    expect(
      read('kharkiv', 'Аварійні відключення будуть скасовуватись після стабілізації ситуації.'),
    ).not.toMatchObject({ action: 'cancel' })
    expect(read('kharkiv', 'Застосування графіків аварійних відключень припинено.')).toMatchObject({
      action: 'cancel',
    })
  })
})

describe('2b. verbs about ГПВ, "завершено", "частково"', () => {
  it('"не застосовуються, діють графіки погодинних відключень": the "діють" is ГПВ', () => {
    expect(
      read('kharkiv', 'Аварійні відключення не застосовуються, діють графіки погодинних відключень.'),
    ).toBeNull()
  })

  it('"відбувається зміна черг" means it is in force', () => {
    expect(
      read(
        'khmelnytskyi',
        'Шановні споживачі!\n\n❗️Протягом доби відбувається зміна черг спеціального графіку аварійних відключень електроенергії.',
      ),
    ).toMatchObject({ action: 'apply', kind: 'sgav' })
  })

  it('"Аварійні відключення завершено" cancels', () => {
    expect(
      read('kharkiv', 'Аварійні відключення завершено. Діють графіки погодинних відключень.'),
    ).toMatchObject({
      action: 'cancel',
      scheduleApplies: true,
    })
  })

  it('"скасовано частково: увімкнено 6-10 черги, 1-5 черги залишаються вимкненими" lifts 6-10 only', () => {
    const text = 'ГАВ скасовано частково: з 19:09 увімкнено 6-10 черги, 1-5 черги залишаються вимкненими.'
    expect(read('poltava', text)).toMatchObject({
      action: 'cancel',
      partial: true,
      queues: ['6', '7', '8', '9', '10'],
    })
    const s = fold(
      'poltava',
      [['poltavaOE/4446'], [text, '2026-11-02T17:10:00Z']],
      '2026-11-02T19:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', queues: ['1', '2', '3', '4', '5'] })
  })
})

describe('3. one episode per area', () => {
  it('ЦЕК: a Pavlohrad cancel leaves Dnipro on', () => {
    const s = fold(
      'dnipro-cek',
      [
        ['cek_info/4390'],
        [
          '📢 Шановні споживачі м. ПАВЛОГРАД‼️ Повідомляємо, що зараз за вашими адресами діють ЕКСТРЕНІ ВІДКЛЮЧЕННЯ‼️',
          '2026-11-14T10:30:00Z',
        ],
        [
          '📢 Шановні мешканці м. ПАВЛОГРАД‼️ Повідомляємо про скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ ‼️',
          '2026-11-14T10:50:00Z',
        ],
      ],
      '2026-11-14T13:00:00+02:00',
    )
    expect(s).toMatchObject({ state: 'active', area: 'м. Дніпро', since: '2026-11-14T12:19:53+02:00' })
  })

  it('a whole-region cancel ends every area', () => {
    const s = fold(
      'dnipro-cek',
      [
        ['cek_info/4390'],
        [
          '📢 Шановні споживачі‼️ Повідомляємо про скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ ‼️',
          '2026-11-14T11:00:00Z',
        ],
      ],
      '2026-11-14T13:30:00+02:00',
    )
    expect(s).toMatchObject({ state: 'inactive', endedAt: '2026-11-14T13:00:00+02:00' })
  })

  it('cekArea reads "мешканці м." too', () => {
    expect(cekArea('📢 Шановні мешканці м. ПАВЛОГРАД‼️')).toBe('м. Павлоград')
  })

  it('DTEK keeps the district of "Київщина, Бучанський район:"', () => {
    expect(read('kyiv-region', POSTS['dtek_ua/4648']!.text)).toMatchObject({
      action: 'apply',
      area: 'Бучанський район',
    })
    expect(read('kyiv-region', POSTS['dtek_ua/4637']!.text)).toMatchObject({
      area: 'Бучанському, Обухівському, Фастівському районах',
    })
  })
})

describe('4. a verb-less announcement after a headline', () => {
  it('Zhytomyr 1905 "на Житомирщині аварійні знеструмлення … графіки погодинних … не діють"', () => {
    expect(read('zhytomyr', POSTS['ztoe_ua/1905']!.text)).toMatchObject({
      action: 'apply',
      kind: 'emergency',
      scheduleApplies: false,
    })
  })
})

describe('5. hyphenated oblast names', () => {
  it('"Івано-Франківській" is the home oblast', () => {
    expect(
      read(
        'ivano-frankivsk',
        'За розпорядженням НЕК «Укренерго» в Івано-Франківській області застосовані графіки аварійних вимкнень (ГАВ).',
      ),
    ).toMatchObject({ action: 'apply', kind: 'gav' })
    expect(read('ivano-frankivsk', 'В Івано-Франківській області скасовано ГАВ.')).toMatchObject({
      action: 'cancel',
    })
  })

  it('3070 keeps its time and count', () => {
    expect(
      read(
        'ivano-frankivsk',
        POSTS['prykarpattyaoblenergo_official/3070']!.text,
        new Date(POSTS['prykarpattyaoblenergo_official/3070']!.at),
      ),
    ).toMatchObject({
      action: 'apply',
      at: '2025-10-15T18:00:00+03:00',
      count: 2,
    })
  })

  it('headParts keeps commas inside parentheses', () => {
    expect(headParts('Лівий берег Києва (Дніпровський, Деснянський, Дарницький райони)')).toEqual([
      'Лівий берег Києва (Дніпровський, Деснянський, Дарницький райони)',
    ])
    expect(headParts('Київ, Київська та Дніпропетровська область')).toEqual([
      'Київ',
      'Київська',
      'Дніпропетровська область',
    ])
  })
})

describe('6. an explicit (ГАВ) / (СГАВ) label decides the kind', () => {
  it('Kirovohrad 1499 "дію графіка аварійних відключень (СГАВ) скасовано" ends СГАВ', () => {
    expect(read('kirovohrad', POSTS['SvitloKropyvnytskyiMisto/1499']!.text)).toMatchObject({
      action: 'cancel',
      kind: 'sgav',
    })
    const s = fold(
      'kirovohrad',
      [
        ['SvitloKropyvnytskyiMisto/1495'],
        ['SvitloKropyvnytskyiMisto/1498'],
        ['SvitloKropyvnytskyiMisto/1499'],
      ],
      '2026-02-23T09:00:00+02:00',
    )
    expect(s).toMatchObject({ state: 'inactive', kind: 'sgav' })
  })
})

describe('7. Kyiv\'s "Дніпровський район" is not Dnipro', () => {
  for (const text of [
    '‼️Київ, Дніпровський район: за командою Укренерго застосовані екстрені відключення',
    '‼️Лівий берег Києва (Дніпровський, Деснянський, Дарницький райони): застосовані екстрені відключення',
  ])
    it(text.slice(0, 60), () => {
      expect(channel('dnipro').about!(text)).toBe(false)
      expect(channel('kyiv').about!(text)).toBe(true)
    })

  it('Dnipro posts still are', () => {
    expect(
      channel('dnipro').about!(
        POSTS['dtek_ua/4721']?.text ??
          '‼️Дніпро та Дніпровський район: за командою Укренерго застосовані екстрені відключення',
      ),
    ).toBe(true)
    expect(channel('dnipro').about!(POSTS['dtek_ua/4716']!.text)).toBe(true)
    expect(
      read('kyiv', '‼️Київ, Дніпровський район: за командою Укренерго застосовані екстрені відключення'),
    ).toMatchObject({
      area: 'Дніпровський район',
    })
  })
})

describe('8. partial cancels', () => {
  it('Poltava 10.11: 1-5 stay off after "скасовано 5 черг ГАВ (6-10 черги)"', () => {
    const s = fold(
      'poltava',
      [['poltavaOE/4522'], ['poltavaOE/4523'], ['poltavaOE/4524'], ['poltavaOE/4526']],
      '2026-11-10T21:30:00+02:00',
    )
    expect(s).toMatchObject({
      state: 'active',
      queues: ['1', '2', '3', '4', '5'],
      since: '2026-11-10T14:10:00+02:00',
    })
  })

  it('a partial cancel after an apply without numbers keeps it on', () => {
    const s = fold(
      'poltava',
      [
        ['В області застосовано ГАВ!', '2026-11-10T08:00:00Z'],
        ['ГАВ скасовано! О 10:30 скасовано 5 черг ГАВ.', '2026-11-10T08:31:00Z'],
      ],
      '2026-11-10T11:00:00+02:00',
    )
    expect(s.state).toBe('active')
  })

  it('a partial cancel that empties the known set ends it', () => {
    const s = fold(
      'poltava',
      [['poltavaOE/4504'], ['ГАВ скасовано! О 11:00 скасовано ГАВ (1-5 черга).', '2026-11-09T09:01:00Z']],
      '2026-11-09T12:00:00+02:00',
    )
    expect(s).toMatchObject({ state: 'inactive', endedAt: '2026-11-09T11:00:00+02:00' })
  })
})

describe('9. local damage is not an emergency schedule', () => {
  for (const [region, text] of [
    [
      'lviv',
      '⚠️Через аварійне відключення в електромережах 110кВ частково знеструмлені споживачі в центральній частині Львова.',
    ],
    ['lviv', 'У Сихівському районі триває аварійне відключення через пошкодження кабелю.'],
    ['sumy', '💡Маємо масштабне аварійне знеструмлення в частині Сумщини. Працюємо над відновленням.'],
    ['sumy', 'Внаслідок обстрілу діють аварійні відключення у Шосткинському районі.'],
  ] as const)
    it(text.slice(0, 60), () => {
      expect(read(region, text)).toBeNull()
    })
})

describe('10. Mykolaiv feed and channel', () => {
  const feed = (rows: object[], last = 1) => JSON.stringify({ current_page: 1, last_page: last, data: rows })

  it("finished feed rows don't hide an active channel post", async () => {
    const { fetch } = mockFetch([
      {
        match: 'energy.mk.ua/outage/api/v1/outage',
        method: 'POST',
        body: feed([
          {
            id: 1,
            type: 'GAO',
            start_at: '2026-11-03T00:30:00Z',
            finish_at: '2026-11-03T02:00:00Z',
            reason: 'Графік аварійних відключень | ГАВ черга 1',
          },
        ]),
      },
      {
        match: 't.me/s/mk_energy_ua',
        body: previewPage('mk_energy_ua', [
          {
            id: 7,
            at: '2026-11-03T05:00:00Z',
            text: 'УВАГА! За командою НЕК "УКРЕНЕРГО" відключили 1,2,3 та 4 черги ГАВ.',
          },
        ]),
      },
    ])
    const s = await new OutageClient({
      fetch,
      now: () => new Date('2026-11-03T08:00:00+02:00'),
      cacheTtlMs: 0,
    }).getEmergency('mykolaiv')
    expect(s).toMatchObject({ state: 'active', source: 'telegram', queues: ['1', '2', '3', '4'] })
  })

  it('reads the newest pages when the window has many', async () => {
    const pages: number[] = []
    const { fetch } = mockFetch([
      {
        match: 'energy.mk.ua/outage/api/v1/outage',
        method: 'POST',
        body: () => '',
      },
      {
        match: 't.me/s/mk_energy_ua',
        body: previewPage('mk_energy_ua', [{ id: 1, at: '2026-11-03T05:00:00Z', text: 'Розклад ОНОВЛЕНО' }]),
      },
    ])
    const wrapped: typeof fetch = async (url, init) => {
      if (url.includes('energy.mk.ua')) {
        const n = JSON.parse(String(init!.body)).page as number
        pages.push(n)
        const rows =
          n === 20
            ? [
                {
                  id: 9,
                  type: 'GAO',
                  start_at: '2026-11-03T05:30:00Z',
                  finish_at: null,
                  reason: 'Графік аварійних відключень | ГАВ черга 7',
                },
              ]
            : [
                {
                  id: n,
                  type: 'GAO',
                  start_at: '2026-11-03T00:00:00Z',
                  finish_at: '2026-11-03T01:00:00Z',
                  reason: 'Графік погодинних відключень | ГПВ 2.2 черга',
                },
              ]
        return new Response(feed(rows, 20))
      }
      return fetch(url, init)
    }
    const s = await new OutageClient({
      fetch: wrapped,
      now: () => new Date('2026-11-03T08:00:00+02:00'),
      cacheTtlMs: 0,
    }).getEmergency('mykolaiv')
    expect(pages[0]).toBe(1)
    expect(pages.at(-1)).toBe(20)
    expect(pages).not.toContain(5)
    expect(s).toMatchObject({ state: 'active', source: 'api', queues: ['7'] })
  })
})

describe('11. times in the text are not in the future', () => {
  it('"О 23:55 скасовано ГАВ." posted at noon is last night', () => {
    expect(read('kharkiv', 'О 23:55 скасовано ГАВ.', new Date('2026-11-15T10:00:00Z'))).toMatchObject({
      action: 'cancel',
      at: '2026-11-14T23:55:00+02:00',
    })
  })

  it('a start shortly ahead stays today', () => {
    expect(
      read('ternopil', POSTS['ternopiloblenerho/1140']!.text, new Date(POSTS['ternopiloblenerho/1140']!.at))!
        .at,
    ).toBe('2025-10-15T18:00:00+03:00')
  })
})

describe('12. the whole area of a DTEK post', () => {
  it('4716 "в місті Дніпрі, прилеглих … районах та в частині Павлоградського району"', () => {
    expect(read('dnipro', POSTS['dtek_ua/4716']!.text)!.area).toBe(
      'місті Дніпрі, прилеглих до обласного центру районах та в частині Павлоградського району',
    )
  })
})

describe('the status contract', () => {
  it('a cancellation always has message and endedAt; nothing found has neither', () => {
    const cancelled = fold('poltava', [['poltavaOE/4546']], '2026-11-16T03:00:00+02:00')
    expect(cancelled).toMatchObject({ state: 'inactive', endedAt: '2026-11-15T19:09:00+02:00' })
    expect(cancelled.message?.url).toBe('https://t.me/poltavaOE/4546')
    const nothing = fold('poltava', [], '2026-11-16T03:00:00+02:00')
    expect(nothing).toMatchObject({ state: 'inactive', kind: null, message: null, endedAt: null })
  })

  it('a failed source makes "inactive" from the others unknown', async () => {
    const { fetch } = mockFetch([
      { match: 't.me/s/dtek_ua', body: 'down', status: 502 },
      { match: '/regions/25/dsos/902/planned-outages', body: fixture('yasno/planned-outages-25-902.json') },
    ])
    const s = await new OutageClient({
      fetch,
      now: () => new Date('2026-11-05T23:40:00+02:00'),
      cacheTtlMs: 0,
    }).getEmergency('kyiv')
    expect(s.state).toBe('unknown')
  })
})
