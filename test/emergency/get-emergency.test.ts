import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AiRuntime } from '../../src/ai/runtime.js'
import type { PostEvent, PostInput } from '../../src/ai/types.js'
import { OutageClient } from '../../src/client.js'
import { foldEvents } from '../../src/emergency/status.js'
import { channelEvents } from '../../src/emergency/regions.js'
import type { TelegramPost } from '../../src/emergency/telegram.js'
import { Http } from '../../src/http.js'
import { toKyivIso } from '../../src/time.js'
import type { RegionId } from '../../src/types.js'
import { ev, fakeText, fixture, mockFetch, type Route } from '../helpers.js'
import { previewPage, type PreviewPost } from './preview.js'

const POSTS: Record<string, { at: string; text: string }> = JSON.parse(fixture('telegram/posts.json')).posts

/** dtek_ua/4787 as it was first, before "UPD: екстрені відключення скасовано" was added */
const DNIPRO_APPLY: [string, PostEvent[]] = [
  'Дніпро: за розпорядженням Укренерго в місті',
  [ev({ kind: 'emergency', action: 'start', regions: ['dnipro'], area: 'місто Дніпро', gpvApplies: false })],
]

/** The eval set's label for a real post: what a correct processor answers for it */
function label(url: string): unknown {
  const m = /t\.me\/(\w+)\/(\d+)$/.exec(url)
  const file = m && fileURLToPath(new URL(`../../eval/text/${m[1]}-${m[2]}.json`, import.meta.url))
  if (!file || !existsSync(file)) return undefined
  return (JSON.parse(readFileSync(file, 'utf8')) as { input: PostInput; expected: unknown }).expected
}

/**
 * Answers like a correct model: the eval label of each real post, `extra` answers for the posts
 * these tests make up (by a piece of their text), nothing in any other post.
 */
function oracle(extra: [string, PostEvent[]][] = []) {
  return fakeText((input) => {
    const made = extra.find(([piece]) => input.text.includes(piece))
    if (made) return made[1]
    return (label(input.url) as { events: PostEvent[] } | undefined) ?? undefined
  })
}

/** Verbatim posts of a channel as its preview page (ids and times as they were posted). */
function page(channel: string, ids: number[], extra: PreviewPost[] = []): string {
  const posts = ids.map((id) => {
    const p = POSTS[`${channel}/${id}`]
    if (!p) throw new Error(`no post ${channel}/${id}`)
    return { id, at: p.at, text: p.text }
  })
  return previewPage(
    channel,
    [...posts, ...extra].sort((a, b) => a.id - b.id),
  )
}

/** A YASNO planned-outages fixture with every group's `updatedOn` set */
function yasnoAt(file: string, updatedOn: string): string {
  const data = JSON.parse(fixture(file))
  for (const g of Object.values(data))
    if (g && typeof g === 'object') (g as { updatedOn?: string }).updatedOn = updatedOn
  return JSON.stringify(data)
}

function client(now: string, routes: Route[], extra: [string, PostEvent[]][] = []) {
  const { fetch, calls } = mockFetch(routes)
  return {
    client: new OutageClient({
      fetch,
      now: () => new Date(now),
      cacheTtlMs: 0,
      textProcessor: oracle(extra),
    }),
    calls,
  }
}

/** Events of a region's channel from verbatim posts, folded at `now`. */
async function foldAt(region: RegionId, channel: string, ids: number[], now: string) {
  const ctx = {
    http: new Http({ fetch: mockFetch([]).fetch }),
    now: () => new Date(now),
    ai: new AiRuntime({ textProcessor: oracle() }),
  }
  const posts: TelegramPost[] = ids.map((id) => {
    const p = POSTS[`${channel}/${id}`]!
    return {
      channel,
      id,
      url: `https://t.me/${channel}/${id}`,
      at: toKyivIso(new Date(p.at)),
      text: p.text,
      edited: false,
      photos: [],
      replyTo: null,
    }
  })
  return foldEvents(
    (await channelEvents(ctx, region, posts)).filter((e) => Date.parse(e.posted) <= Date.parse(now)),
    { region, now: new Date(now), ttlHours: 12, source: 'telegram' },
  )
}

describe('capabilities', () => {
  it('says which regions have an emergency source', () => {
    const c = new OutageClient()
    expect(c.region('poltava').capabilities.emergency).toBe(true)
    expect(c.region('volyn').capabilities.emergency).toBe(true)
    expect(c.region('uz-kyiv').capabilities.emergency).toBe(false)
    const none = c
      .regions()
      .filter((r) => !r.capabilities.emergency)
      .map((r) => r.id)
    // the railway's pages, and Vinnytsia, whose operator has no channel a plain request can read
    expect(none.every((id) => id.startsWith('uz-') || id === 'vinnytsia')).toBe(true)
  })

  it('throws unsupported where there is none', async () => {
    await expect(new OutageClient().getEmergency('uz-kyiv')).rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('folding announcements (Poltava, 02.11.2026)', () => {
  const day = [4446, 4447, 4449, 4450, 4453, 4454, 4456]

  it('a partial cancel leaves the other queues off', async () => {
    // 07:34 ГАВ в повному обсязі, 07:53 скасовано 5 черг (з 6 по 10)
    const s = await foldAt('poltava', 'poltavaOE', day, '2026-11-02T08:30:00+02:00')
    expect(s).toMatchObject({
      state: 'active',
      kind: 'gav',
      since: '2026-11-02T07:34:00+02:00',
      queues: ['1', '2', '3', '4', '5'],
      queueCount: 5,
      inferred: false,
    })
    expect(s.message!.url).toBe('https://t.me/poltavaOE/4447')
  })

  it('more queues within an episode keep its start; a new apply after a cancel starts again', async () => {
    // 08:48 "ввести ГАВ в повному обсязі" while 1–5 were still off: the same episode, all ten now
    expect(await foldAt('poltava', 'poltavaOE', day, '2026-11-02T09:30:00+02:00')).toMatchObject({
      state: 'active',
      since: '2026-11-02T07:34:00+02:00',
      queueCount: 10,
    })
    // 09:58 cancelled, 11:11 applied again
    expect(await foldAt('poltava', 'poltavaOE', day, '2026-11-02T11:45:00+02:00')).toMatchObject({
      state: 'active',
      since: '2026-11-02T11:11:00+02:00',
    })
    expect(await foldAt('poltava', 'poltavaOE', day, '2026-11-02T15:00:00+02:00')).toMatchObject({
      state: 'inactive',
      kind: 'gav',
      since: '2026-11-02T11:11:00+02:00',
      endedAt: '2026-11-02T14:05:00+02:00',
      queues: null,
      inferred: false,
    })
  })

  it('counts add up and come down (08.11: 5 черг, додатково 5, скасовано 5)', async () => {
    const ids = [4497, 4498, 4499, 4500]
    expect(await foldAt('poltava', 'poltavaOE', ids, '2026-11-08T10:30:00+02:00')).toMatchObject({
      queueCount: 10,
    })
    expect(await foldAt('poltava', 'poltavaOE', ids, '2026-11-08T11:10:00+02:00')).toMatchObject({
      state: 'active',
      queueCount: 5,
    })
    expect(await foldAt('poltava', 'poltavaOE', ids, '2026-11-08T12:00:00+02:00')).toMatchObject({
      state: 'inactive',
    })
  })
})

describe('getEmergency', () => {
  it('Sumy never cancels: the swap sets the queues, the ГАВ hold to the end of the day', async () => {
    const routes = [
      { match: 't.me/s/SumyEnergo', body: page('SumyEnergo', [3919, 3921]) },
      // read too for Sumy: nothing newer about it than 11.11, which ended that night
      { match: 't.me/s/Ukrenergo', body: page('Ukrenergo', [5631]) },
    ]
    const during = await client('2026-11-15T23:00:00+02:00', routes).client.getEmergency('sumy')
    expect(during).toMatchObject({
      region: 'sumy',
      state: 'active',
      kind: 'gav',
      since: '2026-11-15T16:50:00+02:00',
      queues: ['6', '7', '8', '9', '10'],
      queueCount: 5,
      source: 'telegram',
      inferred: false,
    })
    const after = await client('2026-11-16T03:00:00+02:00', routes).client.getEmergency('sumy')
    expect(after).toMatchObject({
      state: 'inactive',
      kind: 'gav',
      inferred: true,
      // Sumy never cancels: an apply holds to the end of its day, and at least 6 h, so the 19:00
      // swap runs to 01:00
      endedAt: '2026-11-16T01:00:00+02:00',
      queues: null,
    })
    // an apply with no word after it (16:50, as 18.11 08:05) still holds late in the evening,
    // where a 6-hour TTL had ended it at 22:54
    const alone = [
      { match: 't.me/s/SumyEnergo', body: page('SumyEnergo', [3919]) },
      { match: 't.me/s/Ukrenergo', body: page('Ukrenergo', [5631]) },
    ]
    expect(await client('2026-11-15T23:30:00+02:00', alone).client.getEmergency('sumy')).toMatchObject({
      state: 'active',
      kind: 'gav',
      since: '2026-11-15T16:50:00+02:00',
    })
  })

  it("Sumy: the operator's apply with @Ukrenergo down is unknown (Ukrenergo may have cancelled it)", async () => {
    const routes = [
      { match: 't.me/s/SumyEnergo', body: page('SumyEnergo', [3919]) },
      { match: 't.me/s/Ukrenergo', body: 'down', status: 503 },
    ]
    expect(await client('2026-11-15T20:00:00+02:00', routes).client.getEmergency('sumy')).toMatchObject({
      state: 'unknown',
      queues: null,
    })
  })

  it('Zhytomyr: an edited "UPD … скасовано" post is a cancellation', async () => {
    const routes = [{ match: 't.me/s/ztoe_ua', body: fixture('telegram/ztoe_ua-before-1875.trimmed.html') }]
    const s = await client('2026-11-04T15:00:00+02:00', routes).client.getEmergency('zhytomyr')
    expect(s).toMatchObject({
      state: 'inactive',
      since: '2026-11-03T14:50:38+02:00',
      // the edit time isn't shown by Telegram: the post time is the best known
      endedAt: '2026-11-03T14:50:38+02:00',
      inferred: false,
      message: { url: 'https://t.me/ztoe_ua/1873' },
    })
  })

  it('Kirovohrad: ГАВ stays when only СГАВ is lifted', async () => {
    const routes = [
      {
        match: 't.me/s/SvitloKropyvnytskyiMisto',
        body: page('SvitloKropyvnytskyiMisto', [1325, 1327, 1328]),
      },
    ]
    const s = await client('2026-01-22T14:00:00+02:00', routes).client.getEmergency('kirovohrad')
    expect(s).toMatchObject({ state: 'active', kind: 'gav', since: '2026-01-22T08:24:00+02:00' })
  })

  it('ЦЕК: a city-scoped apply and its cancel', async () => {
    const routes = [
      { match: 't.me/s/cek_info', body: fixture('telegram/cek_info-4315-4316.trimmed.html') },
      {
        match: '/regions/3/dsos/303/planned-outages',
        body: yasnoAt('yasno/planned-outages-3-303.json', '2026-11-04T05:00:00+00:00'),
      },
    ]
    const during = await client('2026-11-04T14:00:00+02:00', [
      { match: 't.me/s/cek_info', body: page('cek_info', [4315]) },
      routes[1]!,
    ]).client.getEmergency('dnipro-cek')
    expect(during).toMatchObject({
      state: 'active',
      kind: 'emergency',
      // as the operator wrote it
      area: 'м. ДНІПРО',
      scheduleApplies: false,
    })
    const after = await client('2026-11-04T16:00:00+02:00', routes).client.getEmergency('dnipro-cek')
    expect(after).toMatchObject({
      state: 'inactive',
      endedAt: '2026-11-04T15:54:15+02:00',
      scheduleApplies: true,
    })
  })

  it('Kyiv: YASNO EmergencyShutdowns with the DTEK post for details; Київщина posts are not Kyiv', async () => {
    const kyivPart = POSTS['dtek_ua/4684']!.text.replace(/\s*UPD:[^\n]*$/u, '')
    const { client: c, calls } = client(
      '2025-11-25T10:00:00+02:00',
      [
        {
          match: 't.me/s/dtek_ua',
          body: previewPage('dtek_ua', [
            {
              id: 1,
              at: '2025-11-25T07:00:00Z',
              text: POSTS['dtek_ua/4684']!.text.replace(/\s*UPD:[^\n]*$/u, ''),
            },
            { id: 2, at: '2025-11-25T07:30:00Z', text: POSTS['dtek_ua/4589']!.text },
          ]),
        },
        {
          match: '/regions/25/dsos/902/planned-outages',
          body: fixture('yasno/planned-outages-EmergencyShutdowns.community-2025-11-25.json'),
        },
      ],
      [
        // 4684 without its later "UPD: скасовано": an apply for part of Kyiv
        [
          kyivPart.slice(0, 60),
          [
            ev({
              kind: 'emergency',
              action: 'start',
              regions: ['kyiv'],
              area: 'частині Голосієвського та Соломянського районів',
              gpvApplies: false,
            }),
          ],
        ],
        // 4589: Київщина back to the schedules
        [
          POSTS['dtek_ua/4589']!.text.slice(0, 40),
          [ev({ kind: 'emergency', action: 'cancel', regions: ['kyiv-region'], gpvApplies: true })],
        ],
      ],
    )
    const s = await c.getEmergency('kyiv')
    expect(s).toMatchObject({
      state: 'active',
      kind: 'emergency',
      source: 'yasno',
      since: '2025-11-25T09:00:00+02:00',
      area: 'частині Голосієвського та Соломянського районів',
      scheduleApplies: false,
    })
    expect(calls.map((x) => new URL(x.url).host).sort()).toEqual(['app.yasno.ua', 't.me'])
  })

  it('Dnipro: YASNO ends only an emergency it showed itself', async () => {
    let yasno = fixture('yasno/planned-outages-EmergencyShutdowns.community-2025-11-25.json')
    const { fetch } = mockFetch([
      {
        match: 't.me/s/dtek_ua',
        // the post as it was first: it now ends with "UPD: екстрені відключення скасовано"
        body: previewPage('dtek_ua', [
          {
            id: 4787,
            at: POSTS['dtek_ua/4787']!.at,
            text: POSTS['dtek_ua/4787']!.text.replace(/\s*UPD:[^\n]*$/u, ''),
          },
        ]),
      },
      { match: '/regions/3/dsos/301/planned-outages', body: () => yasno },
    ])
    const c = new OutageClient({
      fetch,
      now: () => new Date('2026-11-05T19:00:00+02:00'),
      cacheTtlMs: 0,
      textProcessor: oracle([DNIPRO_APPLY]),
    })
    expect(await c.getEmergency('dnipro')).toMatchObject({ state: 'active', source: 'yasno' })
    // YASNO switches back: DTEK never posts a Dnipro cancel, so this is the end
    yasno = fixture('yasno/planned-outages-3-301.json')
    const s = await c.getEmergency('dnipro')
    expect(s).toMatchObject({ state: 'inactive', kind: 'emergency', source: 'yasno', scheduleApplies: true })
    expect(s.message?.text).toBe('YASNO: EmergencyShutdowns → ScheduleApplies')
    expect(s.endedAt).toBeTruthy()
  })

  it('YASNO not showing an emergency never cancels a post', async () => {
    // every group ScheduleApplies, updatedOn after the post: schedules moved, not a cancel
    const s = await client(
      '2026-11-05T23:40:00+02:00',
      [
        {
          match: 't.me/s/dtek_ua',
          // the post as it was first: it now ends with "UPD: екстрені відключення скасовано"
          body: previewPage('dtek_ua', [
            {
              id: 4787,
              at: POSTS['dtek_ua/4787']!.at,
              text: POSTS['dtek_ua/4787']!.text.replace(/\s*UPD:[^\n]*$/u, ''),
            },
          ]),
        },
        { match: '/regions/3/dsos/301/planned-outages', body: fixture('yasno/planned-outages-3-301.json') },
      ],
      [DNIPRO_APPLY],
    ).client.getEmergency('dnipro')
    expect(s).toMatchObject({ state: 'active', kind: 'emergency', source: 'telegram' })
  })

  it('Mykolaiv: the outage feed names the ГАВ queue', async () => {
    const routes = [
      {
        match: 'energy.mk.ua/outage/api/v1/outage',
        method: 'POST' as const,
        body: fixture('mykolaiv/outage-feed-gav-2026-11-03.json'),
      },
      {
        match: 't.me/s/mk_energy_ua',
        body: previewPage('mk_energy_ua', [
          {
            id: 1,
            at: '2026-11-02T22:47:00Z',
            text: 'Увага! Розклад ОНОВЛЕНО відповідно до останніх розпоряджень НЕК "УКРЕНЕРГО".',
          },
        ]),
      },
    ]
    const during = await client('2026-11-03T03:00:00+02:00', routes).client.getEmergency('mykolaiv')
    expect(during).toMatchObject({
      state: 'active',
      kind: 'gav',
      source: 'api',
      since: '2026-11-03T02:30:00+02:00',
      queues: ['1'],
    })
    const later = await client('2026-11-03T05:00:00+02:00', routes).client.getEmergency('mykolaiv')
    expect(later).toMatchObject({ state: 'active', queues: ['2', '3'] })
    const after = await client('2026-11-03T12:00:00+02:00', routes).client.getEmergency('mykolaiv')
    // the mislabelled ГПВ rows and the neighbour's ГАВ don't count
    // AVARIYA rows (accidents) don't count either
    expect(after).toMatchObject({ state: 'inactive', endedAt: '2026-11-03T07:30:00+02:00' })
  })

  it('Volyn and Rivne: the national channel, when it names the oblast', async () => {
    const routes = [
      {
        match: 't.me/s/Ukrenergo',
        body: page(
          'Ukrenergo',
          [5611, 5623],
          [
            {
              id: 5700,
              at: '2026-11-08T10:00:00Z',
              text: '❗️ УВАГА! На цю годину у Рівненській та Волинській областях вимушено запроваджені аварійні відключення електроенергії. Попередньо оприлюднені графіки у цих регіонах наразі не діють.',
            },
          ],
        ),
      },
    ]
    const national: [string, PostEvent[]][] = [
      [
        'у Рівненській та Волинській областях вимушено',
        [ev({ kind: 'emergency', action: 'start', regions: ['volyn', 'rivne'], gpvApplies: false })],
      ],
    ]
    const volyn = await client('2026-11-08T13:00:00+02:00', routes, national).client.getEmergency('volyn')
    expect(volyn).toMatchObject({
      state: 'active',
      kind: 'emergency',
      source: 'ukrenergo',
      scheduleApplies: false,
    })
    // Zakarpattia's own channel says nothing that day, and the national post doesn't name it
    const zakRoutes = [
      ...routes,
      {
        match: 't.me/s/zakarpatenergyofficial',
        body: previewPage('zakarpatenergyofficial', [
          { id: 1, at: '2026-11-08T08:00:00Z', text: 'Передайте показники лічильника до кінця місяця.' },
        ]),
      },
    ]
    const zak = await client('2026-11-08T13:00:00+02:00', zakRoutes, national).client.getEmergency(
      'zakarpattia',
    )
    expect(zak).toMatchObject({ state: 'inactive', kind: null, message: null, source: 'telegram' })
  })

  it('nothing posted is inactive, not an error', async () => {
    const s = await client('2026-11-16T03:00:00+02:00', [
      { match: 't.me/s/poltavaOE', body: page('poltavaOE', [4546]) },
    ]).client.getEmergency('poltava')
    // 15.11 cancel, 19:09; the window holds nothing newer
    expect(s).toMatchObject({ state: 'inactive', kind: 'gav', endedAt: '2026-11-15T19:09:00+02:00' })
    const silent = await client('2026-11-20T03:00:00+02:00', [
      { match: 't.me/s/poltavaOE', body: page('poltavaOE', [4546]) },
    ]).client.getEmergency('poltava')
    expect(silent).toMatchObject({ state: 'inactive', kind: null, since: null, message: null })
  })

  it('one failing source is skipped; all failing throws', async () => {
    const s = await client('2025-11-25T10:00:00+02:00', [
      { match: 't.me/s/dtek_ua', body: 'down', status: 502 },
      {
        match: '/regions/25/dsos/902/planned-outages',
        body: fixture('yasno/planned-outages-EmergencyShutdowns.community-2025-11-25.json'),
      },
    ]).client.getEmergency('kyiv')
    expect(s).toMatchObject({
      state: 'active',
      source: 'yasno',
      message: { text: 'YASNO: EmergencyShutdowns' },
    })
    await expect(
      client('2026-11-16T03:00:00+02:00', [
        { match: 't.me/s/', body: 'down', status: 502 },
      ]).client.getEmergency('poltava'),
    ).rejects.toMatchObject({ code: 'http' })
  })

  it('caches per region and shares channel pages between regions', async () => {
    const { fetch, calls } = mockFetch([
      { match: 't.me/s/dtek_ua', body: page('dtek_ua', [4575]) },
      {
        match: 'planned-outages',
        body: yasnoAt('yasno/planned-outages-25-902.json', '2026-10-07T10:00:00+00:00'),
      },
    ])
    const text = oracle()
    const c = new OutageClient({
      fetch,
      now: () => new Date('2026-10-07T20:00:00+03:00'),
      textProcessor: text,
    })
    const [kyiv, region] = await Promise.all([c.getEmergency('kyiv'), c.getEmergency('kyiv-region')])
    await c.getEmergency('kyiv')
    expect(kyiv).toMatchObject({
      state: 'active',
      source: 'telegram',
      message: { url: 'https://t.me/dtek_ua/4575' },
    })
    expect(region).toMatchObject({ state: 'active', source: 'telegram' })
    expect(calls.filter((x) => x.url === 'https://t.me/s/dtek_ua')).toHaveLength(1)
    // one analysis of the post serves both regions
    expect(text.calls).toHaveLength(1)
  })
})

describe('posts read wrong by the 0.4 regex classifier', () => {
  it('Zaporizhzhia 17.11: an explainer replying to the cancel is not a new ГАВ', async () => {
    const routes = [
      {
        match: 't.me/s/Zaporizhzhyaoblenergo_news',
        body: fixture('telegram/Zaporizhzhyaoblenergo_news-3628-3630.trimmed.html'),
      },
    ]
    const { client: c } = client('2026-11-18T01:15:00+02:00', routes)
    const s = await c.getEmergency('zaporizhzhia')
    // 0.4.8: active gav since 20:33 (3629's "запроваджуються" read as an apply)
    expect(s).toMatchObject({
      state: 'inactive',
      endedAt: '2026-11-17T19:43:23+02:00',
      scheduleApplies: true,
      message: { url: 'https://t.me/Zaporizhzhyaoblenergo_news/3628' },
    })
  })

  it('3629 reaches the processor as one unit with the post it replies to', async () => {
    const routes = [
      {
        match: 't.me/s/Zaporizhzhyaoblenergo_news',
        body: fixture('telegram/Zaporizhzhyaoblenergo_news-3628-3630.trimmed.html'),
      },
    ]
    const text = oracle()
    const { fetch } = mockFetch(routes)
    await new OutageClient({
      fetch,
      now: () => new Date('2026-11-18T01:15:00+02:00'),
      textProcessor: text,
    }).getEmergency('zaporizhzhia')
    const reply = text.calls.find((i) => i.url.endsWith('/3629'))!
    expect(reply.text).toMatch(/^УВАГА!/)
    expect(reply.replyTo).toMatchObject({ url: 'https://t.me/Zaporizhzhyaoblenergo_news/3628' })
    expect(reply.replyTo!.text).toMatch(/скасовані у повному обсязі/)
  })

  it('Kirovohrad 17.11: «В 14:05 відміна дії графіку ГАВ» ends ГАВ at 14:05', async () => {
    const routes = [
      {
        match: 't.me/s/SvitloKropyvnytskyiMisto',
        body: fixture('telegram/SvitloKropyvnytskyiMisto-1832-1835.trimmed.html'),
      },
    ]
    const s = await client('2026-11-17T23:00:00+02:00', routes).client.getEmergency('kirovohrad')
    // 0.4.3: ГАВ in force all night
    expect(s).toMatchObject({ state: 'inactive', endedAt: '2026-11-17T14:05:00+02:00', inferred: false })
  })

  it('without a text processor a channel-only region is unknown, never inactive', async () => {
    const { fetch, calls } = mockFetch([
      {
        match: 't.me/s/Zaporizhzhyaoblenergo_news',
        body: fixture('telegram/Zaporizhzhyaoblenergo_news-3628-3630.trimmed.html'),
      },
    ])
    const s = await new OutageClient({
      fetch,
      now: () => new Date('2026-11-18T01:15:00+02:00'),
    }).getEmergency('zaporizhzhia')
    expect(s).toMatchObject({ state: 'unknown', kind: null })
    expect(s.message!.text).toMatch(/textProcessor/)
    // nothing to read the posts with: the page isn't even fetched
    expect(calls).toHaveLength(0)
  })

  it('a post whose answer fails validation never ends anything', async () => {
    const routes = [
      {
        match: 't.me/s/SvitloKropyvnytskyiMisto',
        body: fixture('telegram/SvitloKropyvnytskyiMisto-1832-1835.trimmed.html'),
      },
    ]
    const { fetch } = mockFetch(routes)
    const text = fakeText((input) =>
      input.url.endsWith('/1835')
        ? // a time that doesn't exist
          [ev({ kind: 'sgav', action: 'cancel', regions: ['kirovohrad'], at: '25:05' })]
        : (label(input.url) as { events: PostEvent[] }),
    )
    const s = await new OutageClient({
      fetch,
      now: () => new Date('2026-11-17T15:00:00+02:00'),
      textProcessor: text,
    }).getEmergency('kirovohrad')
    // 1835 (СГАВ cancelled) can't be read: it may end the СГАВ from 10:12 as well as not, so the
    // state is not known (neither "inactive" nor kept alive by it)
    expect(s).toMatchObject({
      state: 'unknown',
      message: { url: 'https://t.me/SvitloKropyvnytskyiMisto/1835' },
    })
  })
})
