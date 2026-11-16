import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { classifyPost, classifyUkrenergo, type Dialect } from '../../src/emergency/classify.js'
import { channelEvents, EMERGENCY_REGIONS } from '../../src/emergency/regions.js'
import { parseYasnoEmergency } from '../../src/emergency/sources.js'
import { foldEvents } from '../../src/emergency/status.js'
import type { TelegramPost } from '../../src/emergency/telegram.js'
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
