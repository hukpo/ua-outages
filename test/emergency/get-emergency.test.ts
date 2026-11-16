import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { foldEvents } from '../../src/emergency/status.js'
import { channelEvents, EMERGENCY_REGIONS } from '../../src/emergency/regions.js'
import type { TelegramPost } from '../../src/emergency/telegram.js'
import { toKyivIso } from '../../src/time.js'
import type { RegionId } from '../../src/types.js'
import { fixture, mockFetch, type Route } from '../helpers.js'
import { previewPage, type PreviewPost } from './preview.js'

const POSTS: Record<string, { at: string; text: string }> = JSON.parse(fixture('telegram/posts.json')).posts

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

function client(now: string, routes: Route[]) {
  const { fetch, calls } = mockFetch(routes)
  return { client: new OutageClient({ fetch, now: () => new Date(now), cacheTtlMs: 0 }), calls }
}

/** Events of a region's channel from verbatim posts, folded at `now`. */
function foldAt(region: RegionId, channel: string, ids: number[], now: string) {
  const cfg = EMERGENCY_REGIONS[region]!.channels![0]!
  const posts: TelegramPost[] = ids.map((id) => {
    const p = POSTS[`${channel}/${id}`]!
    return {
      channel,
      id,
      url: `https://t.me/${channel}/${id}`,
      at: toKyivIso(new Date(p.at)),
      text: p.text,
      edited: false,
    }
  })
  return foldEvents(
    channelEvents(posts, cfg).filter((e) => Date.parse(e.posted) <= Date.parse(now)),
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
    expect(none.every((id) => id.startsWith('uz-'))).toBe(true)
  })

  it('throws unsupported where there is none', async () => {
    await expect(new OutageClient().getEmergency('uz-kyiv')).rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('folding announcements (Poltava, 02.11.2026)', () => {
  const day = [4446, 4447, 4449, 4450, 4453, 4454, 4456]

  it('a partial cancel leaves the other queues off', () => {
    // 07:34 ГАВ в повному обсязі, 07:53 скасовано 5 черг (з 6 по 10)
    const s = foldAt('poltava', 'poltavaOE', day, '2026-11-02T08:30:00+02:00')
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

  it('more queues within an episode keep its start; a new apply after a cancel starts again', () => {
    // 08:48 "ввести ГАВ в повному обсязі" while 1–5 were still off: the same episode, all ten now
    expect(foldAt('poltava', 'poltavaOE', day, '2026-11-02T09:30:00+02:00')).toMatchObject({
      state: 'active',
      since: '2026-11-02T07:34:00+02:00',
      queueCount: 10,
    })
    // 09:58 cancelled, 11:11 applied again
    expect(foldAt('poltava', 'poltavaOE', day, '2026-11-02T11:45:00+02:00')).toMatchObject({
      state: 'active',
      since: '2026-11-02T11:11:00+02:00',
    })
    expect(foldAt('poltava', 'poltavaOE', day, '2026-11-02T15:00:00+02:00')).toMatchObject({
      state: 'inactive',
      kind: 'gav',
      since: '2026-11-02T11:11:00+02:00',
      endedAt: '2026-11-02T14:05:00+02:00',
      queues: null,
      inferred: false,
    })
  })

  it('counts add up and come down (08.11: 5 черг, додатково 5, скасовано 5)', () => {
    const ids = [4497, 4498, 4499, 4500]
    expect(foldAt('poltava', 'poltavaOE', ids, '2026-11-08T10:30:00+02:00')).toMatchObject({ queueCount: 10 })
    expect(foldAt('poltava', 'poltavaOE', ids, '2026-11-08T11:10:00+02:00')).toMatchObject({
      state: 'active',
      queueCount: 5,
    })
    expect(foldAt('poltava', 'poltavaOE', ids, '2026-11-08T12:00:00+02:00')).toMatchObject({
      state: 'inactive',
    })
  })
})

describe('getEmergency', () => {
  it('Sumy never cancels: the swap sets the queues, the TTL ends it', async () => {
    const routes = [{ match: 't.me/s/SumyEnergo', body: page('SumyEnergo', [3919, 3921]) }]
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
      // Sumy's TTL is 6 h, counted from the last word (the 19:00 swap)
      endedAt: '2026-11-16T01:00:00+02:00',
      queues: null,
    })
  })

  it('Zhytomyr: an edited "UPD … скасовано" post is a cancellation', async () => {
    const routes = [{ match: 't.me/s/ztoe_ua', body: fixture('telegram/ztoe_ua-before-1875.trimmed.html') }]
    const s = await client('2026-11-04T15:00:00+02:00', routes).client.getEmergency('zhytomyr')
    expect(s).toMatchObject({
      state: 'inactive',
      since: '2026-11-03T14:50:38+02:00',
      // the edit time isn't shown by Telegram
      endedAt: null,
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
      area: 'м. Дніпро',
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
    const { client: c, calls } = client('2025-11-25T10:00:00+02:00', [
      {
        match: 't.me/s/dtek_ua',
        body: previewPage('dtek_ua', [
          {
            id: 1,
            at: '2025-11-25T07:00:00Z',
            text: POSTS['dtek_ua/4684']!.text,
          },
          { id: 2, at: '2025-11-25T07:30:00Z', text: POSTS['dtek_ua/4589']!.text },
        ]),
      },
      {
        match: '/regions/25/dsos/902/planned-outages',
        body: fixture('yasno/planned-outages-EmergencyShutdowns.community-2025-11-25.json'),
      },
    ])
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

  it('Dnipro: DTEK posts no cancel; YASNO switched back after the post ends it', async () => {
    const s = await client('2026-11-05T23:40:00+02:00', [
      { match: 't.me/s/dtek_ua', body: page('dtek_ua', [4787]) },
      // every group ScheduleApplies, updatedOn 2026-11-05T19:15Z
      { match: '/regions/3/dsos/301/planned-outages', body: fixture('yasno/planned-outages-3-301.json') },
    ]).client.getEmergency('dnipro')
    expect(s).toMatchObject({ state: 'inactive', kind: 'emergency', source: 'yasno', scheduleApplies: true })
    expect(Date.parse(s.endedAt!)).toBeGreaterThan(Date.parse(s.since!))
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
    expect(after).toMatchObject({ state: 'inactive', endedAt: '2026-11-03T08:30:00+02:00' })
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
    const volyn = await client('2026-11-08T13:00:00+02:00', routes).client.getEmergency('volyn')
    expect(volyn).toMatchObject({
      state: 'active',
      kind: 'emergency',
      source: 'ukrenergo',
      scheduleApplies: false,
    })
    const zak = await client('2026-11-08T13:00:00+02:00', routes).client.getEmergency('zakarpattia')
    expect(zak).toMatchObject({ state: 'inactive', kind: null, message: null, source: 'ukrenergo' })
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
    expect(s).toMatchObject({ state: 'active', source: 'yasno', message: null })
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
    const c = new OutageClient({ fetch, now: () => new Date('2026-10-07T20:00:00+03:00') })
    const [kyiv, region] = await Promise.all([c.getEmergency('kyiv'), c.getEmergency('kyiv-region')])
    await c.getEmergency('kyiv')
    expect(kyiv).toMatchObject({
      state: 'active',
      source: 'telegram',
      message: { url: 'https://t.me/dtek_ua/4575' },
    })
    expect(region).toMatchObject({ state: 'active', source: 'telegram' })
    expect(calls.filter((x) => x.url === 'https://t.me/s/dtek_ua')).toHaveLength(1)
  })
})
