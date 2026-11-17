import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { classifyPost, classifyUkrenergo, type Dialect } from '../../src/emergency/classify.js'
import { channelEvents, EMERGENCY_REGIONS } from '../../src/emergency/regions.js'
import { parseYasnoEmergency } from '../../src/emergency/sources.js'
import { foldEvents } from '../../src/emergency/status.js'
import { readChannelWindow, type TelegramPost } from '../../src/emergency/telegram.js'
import { Http } from '../../src/http.js'
import { toKyivIso } from '../../src/time.js'
import type { EmergencyStatus, RegionId } from '../../src/types.js'
import { fixture, mockFetch, type Route } from '../helpers.js'
import { previewPage, type PreviewPost } from './preview.js'

/**
 * The third review round (0.3.1): each case was found by independent reviewers and reproduced on
 * real posts where there are some. A false "cancelled" is worse than a false "still on"; when
 * unsure, `unknown`.
 */
const POSTS: Record<string, { at: string; text: string }> = JSON.parse(fixture('telegram/posts.json')).posts
const channel = (region: RegionId) => EMERGENCY_REGIONS[region]!.channels![0]!
const dialect = (region: RegionId): Dialect => channel(region).dialect ?? {}
const read = (region: RegionId, text: string, at: string) => classifyPost(text, new Date(at), dialect(region))
const post = (key: string) => {
  const p = POSTS[key]
  if (!p) throw new Error(`no post ${key}`)
  return p
}

/** Verbatim posts (by key) or [text, at] pairs, folded at `now` like getEmergency does. */
function fold(region: RegionId, items: (string | [string, string])[], now: string) {
  const posts: TelegramPost[] = items.map((item, i) => {
    const p = typeof item === 'string' ? post(item) : { text: item[0], at: item[1] }
    return {
      channel: 'x',
      id: i + 1,
      url: typeof item === 'string' ? `https://t.me/${item}` : `extra/${i}`,
      at: toKyivIso(new Date(p.at)),
      text: p.text,
      edited: false,
      photos: [],
    }
  })
  return foldEvents(
    channelEvents(posts, channel(region)).filter((e) => Date.parse(e.posted) <= Date.parse(now)),
    {
      region,
      now: new Date(now),
      ttlHours: EMERGENCY_REGIONS[region]!.ttlHours ?? 12,
      source: 'telegram',
    },
  )
}

/** Verbatim posts of a channel as its preview page */
function page(handle: string, ids: number[], extra: PreviewPost[] = []): string {
  const posts = ids.map((id) => ({ id, ...post(`${handle}/${id}`) }))
  return previewPage(
    handle,
    [...posts, ...extra].sort((a, b) => a.id - b.id),
  )
}

const client = (now: string, routes: Route[]) =>
  new OutageClient({
    fetch: mockFetch(routes).fetch,
    now: () => new Date(now),
    cacheTtlMs: 0,
  })

const feed = (rows: object[]) => JSON.stringify({ current_page: 1, last_page: 1, data: rows })
const MK_FEED = 'energy.mk.ua/outage/api/v1/outage'

describe('1. Mykolaiv: the feed’s own end wins over an older channel cancel', () => {
  const rows = feed([
    {
      id: 1,
      type: 'GAO',
      start_at: '2026-11-03T00:30:00Z',
      finish_at: '2026-11-03T02:50:00Z',
      reason: 'Графік аварійних відключень | ГАВ черга 1',
    },
  ])
  const cancel = (at: string): PreviewPost => ({
    id: 9,
    at,
    text: 'О 19:09 скасовано графіки аварійних відключень.',
  })

  it("yesterday's 19:09 cancel is not today's end", async () => {
    const s = await client('2026-11-03T08:00:00+02:00', [
      { match: MK_FEED, method: 'POST', body: rows },
      {
        match: 't.me/s/mk_energy_ua',
        body: previewPage('mk_energy_ua', [cancel('2026-11-02T17:10:00Z')]),
      },
    ]).getEmergency('mykolaiv')
    expect(s).toMatchObject({
      state: 'inactive',
      source: 'api',
      inferred: true,
      endedAt: '2026-11-03T04:50:00+02:00',
    })
  })

  it('a cancel posted after the feed episode started still wins', async () => {
    const s = await client('2026-11-03T08:00:00+02:00', [
      { match: MK_FEED, method: 'POST', body: rows },
      {
        match: 't.me/s/mk_energy_ua',
        body: previewPage('mk_energy_ua', [
          {
            id: 9,
            at: '2026-11-03T03:00:00Z',
            text: 'Скасовано графіки аварійних відключень.',
          },
        ]),
      },
    ]).getEmergency('mykolaiv')
    expect(s).toMatchObject({
      state: 'inactive',
      source: 'telegram',
      inferred: false,
    })
  })
})

describe('2. an apply post edited into "UPD: … скасовано"', () => {
  const routes = [
    {
      match: 't.me/s/ztoe_ua',
      body: fixture('telegram/ztoe_ua-before-1875.trimmed.html'),
    },
  ]
  const active: EmergencyStatus = {
    region: 'zhytomyr',
    state: 'active',
    kind: 'gav',
    scheduleApplies: null,
    since: '2026-11-03T14:50:38+02:00',
    endedAt: null,
    queues: null,
    queueCount: null,
    area: null,
    inferred: false,
    message: {
      text: 'На Житомирщині застосовано ГАВ',
      url: 'https://t.me/ztoe_ua/1873',
      at: '2026-11-03T14:50:38+02:00',
    },
    source: 'telegram',
    fetchedAt: '2026-11-04T14:00:00+02:00',
  }

  it('previous was that post in force: it ended by this reading', async () => {
    const s = await client('2026-11-04T15:00:00+02:00', routes).getEmergency('zhytomyr', { previous: active })
    expect(s).toMatchObject({
      state: 'inactive',
      endedAt: '2026-11-04T15:00:00+02:00',
      inferred: false,
    })
    // and stays so on the next reading
    const next = await client('2026-11-04T16:00:00+02:00', routes).getEmergency('zhytomyr', { previous: s })
    expect(next.endedAt).toBe('2026-11-04T15:00:00+02:00')
  })

  it('without such a previous: the post time, as before', async () => {
    const s = await client('2026-11-04T15:00:00+02:00', routes).getEmergency('zhytomyr', {
      previous: {
        ...active,
        message: { ...active.message!, url: 'https://t.me/ztoe_ua/1' },
      },
    })
    expect(s.endedAt).toBe('2026-11-03T14:50:38+02:00')
  })
})

describe('3. YASNO groups without a known status are not an end', () => {
  const shutdowns = fixture('yasno/planned-outages-EmergencyShutdowns.community-2025-11-25.json')
  const noStatus = JSON.stringify(
    Object.fromEntries(
      Object.entries(JSON.parse(shutdowns))
        .filter(([k]) => /^\d/.test(k))
        .map(([k]) => [k, { today: { slots: [] }, updatedOn: '2025-11-25T09:00:00+00:00' }]),
    ),
  )

  it('parse fails', () => {
    expect(() => parseYasnoEmergency(JSON.parse(noStatus), 'kyiv')).toThrow(/status/)
    expect(() => parseYasnoEmergency({ '1.1': { today: { status: 'SomethingNew' } } }, 'kyiv')).toThrow()
    expect(parseYasnoEmergency({ '1.1': { today: { status: 'WaitingForSchedule' } } }, 'kyiv').active).toBe(
      false,
    )
  })

  it('an episode YASNO showed is not ended by it', async () => {
    let yasno = shutdowns
    const { fetch } = mockFetch([
      {
        match: 't.me/s/dtek_ua',
        body: previewPage('dtek_ua', [{ id: 1, at: '2025-11-24T07:00:00Z', text: 'Підписуйтесь на канал' }]),
      },
      { match: '/regions/25/dsos/902/planned-outages', body: () => yasno },
    ])
    const c = new OutageClient({
      fetch,
      now: () => new Date('2025-11-25T12:00:00+02:00'),
      cacheTtlMs: 0,
    })
    expect((await c.getEmergency('kyiv')).state).toBe('active')
    yasno = noStatus
    const s = await c.getEmergency('kyiv')
    expect(s.state).not.toBe('inactive')
    expect(s.message?.text ?? '').not.toMatch(/→/)
  })
})

describe('4. a channel read that runs out of pages before the TTL window', () => {
  // 120 posts, 5 min apart: 5 pages of 20 cover 8 h; the apply is on page 6, 9 h ago
  const now = Date.parse('2026-11-10T12:00:00+02:00')
  const all: PreviewPost[] = Array.from({ length: 120 }, (_, i) => ({
    id: 1000 + i,
    at: new Date(now - (120 - i) * 5 * 60_000).toISOString(),
    text:
      i === 5
        ? 'В області застосовано ГАВ!\n\nО 03:00 отримана команда НЕК “Укренерго” ввести ГАВ в обсязі 5 черг.'
        : `Допис ${i}`,
  }))
  const routes: Route[] = []
  for (let p = 1; p < 6; p++) {
    const before = 1000 + 120 - p * 20
    routes.push({
      match: `t.me/s/poltavaOE?before=${before}`,
      body: previewPage('poltavaOE', all.slice(before - 1000 - 20, before - 1000)),
    })
  }
  routes.push({
    match: 't.me/s/poltavaOE',
    body: previewPage('poltavaOE', all.slice(100)),
  })

  it('says how far back it got', async () => {
    const ctx = {
      http: new Http({ fetch: mockFetch(routes).fetch }),
      now: () => new Date(now),
    }
    const r = await readChannelWindow(ctx, 'poltavaOE', {
      region: 'poltava',
      since: new Date(now - 48 * 3600_000),
    })
    expect(r.posts).toHaveLength(100)
    expect(Date.parse(r.from)).toBe(Date.parse(all[20]!.at))
  })

  it('"nothing found" from a short read is unknown, not inactive', async () => {
    const s = await client('2026-11-10T12:00:00+02:00', routes).getEmergency('poltava')
    expect(s.state).toBe('unknown')
  })
})

describe('5. queue rotations replace, not add up', () => {
  it('Sumy 3847 "для 1-5 черг" then 3848 "для 6-10 черг (1-5 ввімкнені)": 6–10', () => {
    expect(read('sumy', post('SumyEnergo/3848').text, post('SumyEnergo/3848').at)).toMatchObject({
      queues: ['6', '7', '8', '9', '10'],
      restored: ['1', '2', '3', '4', '5'],
    })
    const s = fold('sumy', ['SumyEnergo/3847', 'SumyEnergo/3848'], '2026-11-05T12:30:00+02:00')
    expect(s).toMatchObject({
      state: 'active',
      queues: ['6', '7', '8', '9', '10'],
      queueCount: 5,
    })
  })

  it('Sumy 08.11: full volume at 10:10, then 13:16 "знову введені ГАВ (для 6-10 черг)": 6–10', () => {
    const ids = ['SumyEnergo/3861', 'SumyEnergo/3862', 'SumyEnergo/3863']
    expect(fold('sumy', ids.slice(0, 2), '2026-11-08T11:00:00+02:00').queueCount).toBe(10)
    expect(fold('sumy', ids, '2026-11-08T13:40:00+02:00')).toMatchObject({
      state: 'active',
      queues: ['6', '7', '8', '9', '10'],
      queueCount: 5,
      since: '2026-11-08T08:30:00+02:00',
    })
  })

  it('Poltava: "ввести ГАВ (6-10)" after "скасовано 6-10" while 1-5 run still adds up', () => {
    const s = fold(
      'poltava',
      ['poltavaOE/4522', 'poltavaOE/4523', 'poltavaOE/4524'],
      '2026-11-10T18:00:00+02:00',
    )
    expect(s.queueCount).toBe(10)
  })

  it('Mykolaiv 11.11.2024: 7337 keeps 5–6 off, 1–4 back on', () => {
    expect(read('mykolaiv', post('mk_energy_ua/7337').text, post('mk_energy_ua/7337').at)).toMatchObject({
      action: 'update',
      queues: ['5', '6', '7', '8', '9', '10'],
      restored: ['1', '2', '3', '4'],
    })
    const s = fold(
      'mykolaiv',
      ['mk_energy_ua/7334', 'mk_energy_ua/7335', 'mk_energy_ua/7336', 'mk_energy_ua/7337'],
      '2024-11-11T09:00:00+02:00',
    )
    expect(s).toMatchObject({
      state: 'active',
      queues: ['5', '6', '7', '8', '9', '10'],
    })
  })

  it('Mykolaiv 7340 "замість 1 та 2 черг будуть знеструмлені 7 та 8": 1, 2 on; 3–8 off', () => {
    expect(read('mykolaiv', post('mk_energy_ua/7340').text, post('mk_energy_ua/7340').at)).toMatchObject({
      action: 'update',
      queues: ['3', '4', '5', '6', '7', '8'],
      restored: ['1', '2'],
    })
    const ids = [7334, 7335, 7336, 7337, 7338, 7339, 7340].map((id) => `mk_energy_ua/${id}`)
    expect(fold('mykolaiv', ids.slice(0, 5), '2024-11-11T10:00:00+02:00').queues).toEqual([
      '1',
      '2',
      '7',
      '8',
      '9',
      '10',
    ])
    expect(fold('mykolaiv', ids.slice(0, 6), '2024-11-11T11:00:00+02:00').queues).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ])
    expect(fold('mykolaiv', ids, '2024-11-11T11:30:00+02:00').queues).toEqual(['3', '4', '5', '6', '7', '8'])
  })
})

describe('6. the end shown is of the schedule that ended last', () => {
  const ids = [
    'SvitloKropyvnytskyiMisto/1325',
    'SvitloKropyvnytskyiMisto/1327',
    'SvitloKropyvnytskyiMisto/1328',
  ]

  it('Kirovohrad 22.01: СГАВ cancelled 12:58, ГАВ never: from 20:24 the ГАВ end (inferred)', () => {
    expect(fold('kirovohrad', ids, '2026-01-22T20:00:00+02:00')).toMatchObject({
      state: 'active',
      kind: 'gav',
    })
    expect(fold('kirovohrad', ids, '2026-01-22T20:26:00+02:00')).toMatchObject({
      state: 'inactive',
      kind: 'gav',
      inferred: true,
      endedAt: '2026-01-22T20:25:06+02:00',
      message: { url: 'https://t.me/SvitloKropyvnytskyiMisto/1325' },
    })
  })
})

describe('7. an orphan area or partial cancel older than the TTL is history', () => {
  const routes = [{ match: 't.me/s/cek_info', body: page('cek_info', [4406, 4407]) }]

  it('ЦЕК 15.11 4406/4407 "м. ДНІПРО": inactive on 17.11 after the apply left the window', async () => {
    const during = await client('2026-11-15T16:00:00+02:00', routes).getEmergency('dnipro-cek')
    expect(during).toMatchObject({
      state: 'inactive',
      endedAt: '2026-11-15T15:27:32+02:00',
    })
    const later = await client('2026-11-17T13:40:00+02:00', routes).getEmergency('dnipro-cek')
    expect(later).toMatchObject({
      state: 'inactive',
      endedAt: '2026-11-15T15:27:32+02:00',
      message: { url: 'https://t.me/cek_info/4407' },
    })
  })

  it('Poltava 4526 "скасовано 5 черг ГАВ (6-10 черги)" alone: unknown within the TTL, then inferred', () => {
    expect(fold('poltava', ['poltavaOE/4526'], '2026-11-10T22:00:00+02:00').state).toBe('unknown')
    expect(fold('poltava', ['poltavaOE/4526'], '2026-11-12T18:00:00+02:00')).toMatchObject({
      state: 'inactive',
      kind: 'gav',
      inferred: true,
      endedAt: '2026-11-11T09:06:33+02:00',
    })
  })
})

describe('8. a city-tagged cancel ends the one untagged apply', () => {
  it('ЦЕК 09.11: 4348 "Шановні споживачі‼️ Діють…" 18:42, 4349 "…м. ДНІПРО‼️ …скасування" 20:49', () => {
    const s = fold('dnipro-cek', ['cek_info/4348', 'cek_info/4349'], '2026-11-09T21:00:00+02:00')
    expect(s).toMatchObject({
      state: 'inactive',
      endedAt: '2026-11-09T20:49:17+02:00',
      inferred: false,
    })
  })

  it('with areas followed separately it ends only its own', () => {
    const s = fold(
      'dnipro-cek',
      [
        'cek_info/4348',
        ['📢 Шановні споживачі м. ПАВЛОГРАД‼️ Діють ЕКСТРЕНІ ВІДКЛЮЧЕННЯ‼️', '2026-11-09T17:00:00Z'],
        'cek_info/4349',
      ],
      '2026-11-09T21:00:00+02:00',
    )
    expect(s.state).toBe('active')
  })
})

describe('9. a source down mid-episode keeps the episode’s details', () => {
  const shutdowns = fixture('yasno/planned-outages-EmergencyShutdowns.community-2025-11-25.json')
  const kyiv: EmergencyStatus = {
    region: 'kyiv',
    state: 'active',
    kind: 'emergency',
    scheduleApplies: false,
    since: '2025-11-25T08:30:00+02:00',
    endedAt: null,
    queues: null,
    queueCount: null,
    area: 'частині Голосіївського району',
    inferred: false,
    message: {
      text: '‼️Київ: застосовані екстрені відключення',
      url: 'https://t.me/dtek_ua/1',
      at: '2025-11-25T08:30:00+02:00',
    },
    source: 'yasno',
    fetchedAt: '2025-11-25T09:55:00+02:00',
  }
  const down: Route[] = [
    { match: 't.me/s/dtek_ua', body: 'down', status: 502 },
    { match: '/regions/25/dsos/902/planned-outages', body: shutdowns },
  ]

  it('Kyiv: t.me down, YASNO still EmergencyShutdowns', async () => {
    const s = await client('2025-11-25T10:00:00+02:00', down).getEmergency('kyiv', { previous: kyiv })
    expect(s).toMatchObject({
      state: 'active',
      kind: 'emergency',
      since: kyiv.since,
      area: kyiv.area,
      message: kyiv.message,
      source: 'yasno',
    })
    // without previous: as before
    const bare = await client('2025-11-25T10:00:00+02:00', down).getEmergency('kyiv')
    expect(bare.message?.text).toBe('YASNO: EmergencyShutdowns')
  })

  it('Mykolaiv: the feed down while the channel’s older apply stands', async () => {
    const previous: EmergencyStatus = {
      region: 'mykolaiv',
      state: 'active',
      kind: 'gav',
      scheduleApplies: null,
      since: '2026-11-03T05:00:00+02:00',
      endedAt: null,
      queues: ['2', '3'],
      queueCount: 2,
      area: null,
      inferred: false,
      message: {
        text: 'Графік аварійних відключень | ГАВ черга 3',
        url: null,
        at: '2026-11-03T06:00:00+02:00',
      },
      source: 'api',
      fetchedAt: '2026-11-03T07:50:00+02:00',
    }
    const s = await client('2026-11-03T08:00:00+02:00', [
      { match: MK_FEED, method: 'POST', body: 'down', status: 502 },
      {
        match: 't.me/s/mk_energy_ua',
        body: previewPage('mk_energy_ua', [
          {
            id: 7,
            at: '2026-11-03T01:00:00Z',
            text: 'УВАГА! За командою НЕК "УКРЕНЕРГО" відключили 1,2,3 та 4 черги ГАВ.',
          },
        ]),
      },
    ]).getEmergency('mykolaiv', { previous })
    expect(s).toMatchObject({
      state: 'active',
      queues: ['2', '3'],
      queueCount: 2,
      since: '2026-11-03T03:00:00+02:00',
    })
  })
})

describe('10. several areas on at once', () => {
  const items: [string, string][] = [
    ['Застосовано ГАВ (1-5 черга) в Полтавському районі.', '2026-11-10T08:00:00Z'],
    ['Застосовано ГАВ (6-10 черга) в Кременчуцькому районі.', '2026-11-10T08:30:00Z'],
  ]

  it('areas in the order they started; no one area’s queues for the region', () => {
    const s = fold('poltava', items, '2026-11-10T11:00:00+02:00')
    expect(s).toMatchObject({
      state: 'active',
      area: 'Полтавському районі; Кременчуцькому районі',
      queues: null,
      queueCount: null,
    })
    // a newer post about the first one doesn't reorder them
    const touched = fold(
      'poltava',
      [...items, ['Тривають ГАВ (1-5 черга) в Полтавському районі.', '2026-11-10T08:50:00Z']],
      '2026-11-10T11:00:00+02:00',
    )
    expect(touched.area).toBe('Полтавському районі; Кременчуцькому районі')
  })

  it('areas that agree keep the queues', () => {
    const s = fold(
      'poltava',
      [items[0]!, ['Застосовано ГАВ (1-5 черга) в Кременчуцькому районі.', '2026-11-10T08:30:00Z']],
      '2026-11-10T11:00:00+02:00',
    )
    expect(s).toMatchObject({
      queues: ['1', '2', '3', '4', '5'],
      queueCount: 5,
    })
  })
})

describe('11. Chernivtsi: the channel and @Ukrenergo merged by time', () => {
  it('a cancel 28 h ago doesn’t hide a newer Ukrenergo apply naming the oblast', async () => {
    const s = await client('2026-11-08T13:00:00+02:00', [
      {
        match: 't.me/s/oe_cv_ua',
        body: previewPage('oe_cv_ua', [
          {
            id: 5,
            at: '2026-11-07T07:00:00Z',
            text: 'На Буковині скасовано графіки аварійних відключень.',
          },
        ]),
      },
      {
        match: 't.me/s/Ukrenergo',
        body: previewPage('Ukrenergo', [
          {
            id: 5700,
            at: '2026-11-08T10:00:00Z',
            text: '❗️ УВАГА! На цю годину у Чернівецькій області вимушено запроваджені аварійні відключення електроенергії.',
          },
        ]),
      },
    ]).getEmergency('chernivtsi')
    expect(s).toMatchObject({
      state: 'active',
      source: 'ukrenergo',
      message: { url: 'https://t.me/Ukrenergo/5700' },
    })
  })
})

describe('12. an `unknown` previous keeps the YASNO end', () => {
  it('after a restart, YASNO’s end made unknown by a failed source still stands', async () => {
    const applies = JSON.stringify(
      Object.fromEntries(
        Object.entries(
          JSON.parse(fixture('yasno/planned-outages-EmergencyShutdowns.community-2025-11-25.json')),
        )
          .filter(([k]) => /^\d/.test(k))
          .map(([k]) => [
            k,
            {
              today: { status: 'ScheduleApplies' },
              updatedOn: '2025-11-25T09:00:00+00:00',
            },
          ]),
      ),
    )
    const previous: EmergencyStatus = {
      region: 'kyiv',
      state: 'unknown',
      kind: 'emergency',
      scheduleApplies: true,
      since: '2025-11-25T09:00:00+02:00',
      endedAt: '2025-11-25T11:00:00+02:00',
      queues: null,
      queueCount: null,
      area: null,
      inferred: false,
      message: {
        text: 'YASNO: EmergencyShutdowns → ScheduleApplies',
        url: null,
        at: '2025-11-25T11:00:00+02:00',
      },
      source: 'yasno',
      fetchedAt: '2025-11-25T11:30:00+02:00',
    }
    const s = await client('2025-11-25T12:00:00+02:00', [
      {
        match: 't.me/s/dtek_ua',
        body: previewPage('dtek_ua', [
          {
            id: 1,
            at: '2025-11-25T07:00:00Z',
            text: '‼️Київ: за командою Укренерго застосовані екстрені відключення',
          },
        ]),
      },
      { match: '/regions/25/dsos/902/planned-outages', body: applies },
    ]).getEmergency('kyiv', { previous })
    expect(s).toMatchObject({
      state: 'inactive',
      source: 'yasno',
      endedAt: '2025-11-25T11:00:00+02:00',
    })
  })
})

describe('13. national alerts are not the operator’s own', () => {
  for (const key of ['Ukrenergo/5603', 'Ukrenergo/5499'])
    for (const region of ['zhytomyr', 'khmelnytskyi', 'kharkiv'] as const)
      it(`${key} reposted by ${region}`, () => {
        expect(read(region, post(key).text, post(key).at)).toBeNull()
      })

  it('"У більшості регіонів скасовано аварійні відключення" is not a cancel here', () => {
    expect(
      read('zhytomyr', 'У більшості регіонів скасовано аварійні відключення.', '2026-11-04T10:00:00Z'),
    ).toBeNull()
    expect(
      read('khmelnytskyi', 'Аварійні відключення по всій країні скасовано.', '2026-11-04T10:00:00Z'),
    ).toBeNull()
  })

  it('naming the oblast still counts', () => {
    expect(
      read(
        'zhytomyr',
        'На Житомирщині, як і в окремих регіонах України, запроваджено аварійні відключення.',
        '2026-11-04T10:00:00Z',
      ),
    ).toMatchObject({ action: 'apply' })
  })
})

describe('14. wording', () => {
  const AT = '2026-11-16T06:00:00Z'

  it('"замість аварійного трансформатора встановлено новий" is not about ГАВ', () => {
    expect(
      read('kharkiv', 'На підстанції замість аварійного трансформатора встановлено новий.', AT),
    ).toBeNull()
  })

  it('"о 07:35 … було застосовано ГАВ" today counts; past days don’t', () => {
    expect(read('poltava', 'Сьогодні о 07:35 було застосовано ГАВ в обсязі 5 черг.', AT)).toMatchObject({
      action: 'apply',
      at: '2026-11-16T07:35:00+02:00',
      count: 5,
    })
    expect(read('poltava', '14 листопада о 07:35 було застосовано ГАВ.', AT)).toBeNull()
    expect(read('poltava', 'Вчора о 07:35 було застосовано ГАВ.', AT)).toBeNull()
    expect(read('poltava', 'У жовтні було застосовано ГАВ.', AT)).toBeNull()
  })

  it('"Щоб уникнути аварій…, застосовано ГАВ" applies', () => {
    expect(read('kharkiv', 'Щоб уникнути аварій в енергосистемі, застосовано ГАВ.', AT)).toMatchObject({
      action: 'apply',
    })
    expect(read('kharkiv', 'Економте електроенергію, щоб уникнути застосування ГАВ.', AT)).toBeNull()
  })

  it('"Як повідомляє …" is news, not an explainer', () => {
    expect(
      read(
        'kharkiv',
        'Як повідомляє НЕК «Укренерго», на Харківщині застосовано графіки аварійних відключень.',
        AT,
      ),
    ).toMatchObject({ action: 'apply' })
  })

  it('Ukrenergo: "лише у Харківській області та на Закарпатті", "можуть бути", "На Волині та Рівненщині"', () => {
    const ukr = (text: string, region: RegionId) =>
      classifyUkrenergo(text, new Date(AT), EMERGENCY_REGIONS[region]!.ukrenergo!)
    const only = 'Аварійні відключення продовжують діяти лише у Харківській області та на Закарпатті.'
    expect(ukr(only, 'zakarpattia')?.action).toBe('apply')
    expect(ukr(only, 'volyn')?.action).toBe('cancel')
    expect(ukr('У Волинській області можуть бути застосовані аварійні відключення.', 'volyn')).toBeNull()
    const both = 'На Волині та Рівненщині застосовані аварійні відключення.'
    expect(ukr(both, 'volyn')?.action).toBe('apply')
    expect(ukr(both, 'rivne')?.action).toBe('apply')
  })

  it('Mykolaiv 21455 "набрали чинності оновлені графіки (ГПВ, ГАВ та СГАВ)" announces nothing', async () => {
    expect(read('mykolaiv', post('mk_energy_ua/21455').text, post('mk_energy_ua/21455').at)).toBeNull()
    const s = await client('2026-10-01T18:00:00+03:00', [
      { match: MK_FEED, method: 'POST', body: feed([]) },
      {
        match: 't.me/s/mk_energy_ua',
        body: previewPage('mk_energy_ua', [{ id: 21455, ...post('mk_energy_ua/21455') }]),
      },
    ]).getEmergency('mykolaiv')
    expect(s).toMatchObject({ state: 'inactive', kind: null, message: null })
  })
})

describe('15. the day before is a Kyiv calendar day', () => {
  it('"О 23:55 скасовано ГАВ." read just after the DST switches', () => {
    expect(read('kharkiv', 'О 23:55 скасовано ГАВ.', '2026-10-25T10:00:00Z')!.at).toBe(
      '2026-10-24T23:55:00+03:00',
    )
    expect(read('kharkiv', 'О 23:55 скасовано ГАВ.', '2026-03-29T10:00:00Z')!.at).toBe(
      '2026-03-28T23:55:00+02:00',
    )
  })
})
