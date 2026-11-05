import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { OutageError } from '../../src/errors.js'
import { cherkasyProvider, flattenPostHtml, parseCherkasyPosts } from '../../src/providers/cherkasy.js'
import type { DaySchedule } from '../../src/types.js'
import { fixture, mockFetch, type Route } from '../helpers.js'

const NOW = new Date('2026-11-05T23:40:00+02:00')
const API = 'https://www.cherkasyoblenergo.com/api/v1/posts'
const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)
const post = (name: string) => JSON.parse(fixture(`cherkasy/${name}.json`)).data

const POSTS: Route[] = [
  { match: `${API}/search?`, body: fixture('cherkasy/posts-search-gpv-2026-11-05.json') },
  ...[4, 5, 6].map((d) => ({
    match: `${API}/hrafik-pohodynnykh-vidklyuchen-hpv-na-${d}-lystopada?`,
    body: fixture(`cherkasy/post-hpv-na-${d}-lystopada.json`),
  })),
  { match: `${API}/onovleno-hrafik-pohodynnykh-vidklyuchen-hpv-na-1-lystopada?`, body: fixture('cherkasy/post-onovleno-hpv-na-1-lystopada.json') },
]

function client(routes: Route[] = POSTS, now = NOW) {
  const { fetch, calls } = mockFetch(routes)
  return { client: new OutageClient({ fetch, now: () => now, cacheTtlMs: 0, providers: [cherkasyProvider()] }), calls }
}

describe('Cherkasyoblenergo', () => {
  it('reads yesterday, today and tomorrow, fetching only those posts', async () => {
    const { client: c, calls } = client()
    const s = await c.getSchedules('cherkasy')
    expect(s.groups).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'])
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06'])
    // the search list plus one post per day; emergency (ГАВ) notices are never fetched
    expect(calls).toHaveLength(4)
    expect(calls.some((c) => c.url.includes('hav'))).toBe(false)
  })

  it('parses group lines split across inline tags', async () => {
    const s = await client().client.getSchedules('cherkasy')
    const nov6 = (g: string) => s.schedules[g]!.find((d) => d.date === '2026-11-06')!
    expect(nov6('1.1').intervals[0]).toEqual({
      from: '2026-11-06T00:00:00+02:00',
      to: '2026-11-06T02:00:00+02:00',
      kind: 'off',
    })
    expect(hhmm(nov6('1.1'))).toEqual(['00:00-02:00', '07:00-10:00', '12:00-16:00', '18:00-22:00'])
    // "24:00" ends at midnight
    expect(hhmm(nov6('3.2'))).toEqual(['04:00-06:00', '09:00-13:00', '15:00-19:00', '21:00-00:00'])
    // a stray "0" after "21:00" in the source doesn't break the line
    expect(hhmm(nov6('6.2'))).toEqual(['00:00-02:00', '06:00-09:00', '11:00-15:00', '17:00-21:00', '23:00-00:00'])
  })

  it('reports the newest publish time in Kyiv time', async () => {
    const s = await client().client.getSchedules('cherkasy')
    // "publishedAt": "2026-11-05T20:25:00" is Kyiv wall-clock time
    expect(s.updatedAt).toBe('2026-11-05T20:25:00+02:00')
  })

  it('uses the "Оновлено" post for a day, dated by its title rather than its slug', async () => {
    const { client: c, calls } = client(POSTS, new Date('2026-11-03T12:00:00+02:00'))
    const s = await c.getSchedule('cherkasy', '1.1')
    const nov3 = s.days.find((d) => d.date === '2026-11-03')!
    expect(hhmm(nov3)).toEqual(['04:00-08:00', '10:00-14:00', '16:00-20:00'])
    // the original 3 листопада post was superseded, so it isn't requested
    expect(calls.some((c) => c.url.includes('hpv-na-3-lystopada'))).toBe(false)
  })

  it('ignores posts without group windows', () => {
    const s = parseCherkasyPosts([post('post-hav-3'), post('post-hpv-na-6-lystopada')], NOW)
    expect(s.schedules['1.1']!.map((d) => d.date)).toEqual(['2026-11-06'])
  })

  it('returns an empty schedule when no schedule posts are recent', async () => {
    const search = JSON.parse(fixture('cherkasy/posts-search-gpv-2026-11-05.json'))
    search.data.content = search.data.content.filter((p: { title: string }) => !/ГПВ/.test(p.title))
    const s = await client([{ match: `${API}/search?`, body: JSON.stringify(search) }]).client.getSchedules('cherkasy')
    expect(s.groups).toEqual([])
    expect(s.updatedAt).toBeNull()
  })

  it('rejects a changed search API', async () => {
    const err = await client([{ match: `${API}/search?`, body: '{"success":true,"data":[]}' }])
      .client.getSchedules('cherkasy')
      .catch((e) => e)
    expect(err).toBeInstanceOf(OutageError)
    expect(err.code).toBe('parse')
  })

  it('rejects schedule posts it cannot read', () => {
    const p = { ...post('post-hpv-na-6-lystopada'), content: '<p><img src="/uploads/hpv.png"></p>' }
    expect(() => parseCherkasyPosts([p], NOW)).toThrow(OutageError)
    expect(() => parseCherkasyPosts([p], NOW)).toThrow(/no group lines/)
  })

  it('flattens the hand-edited HTML', () => {
    expect(flattenPostHtml('<p>1.1&nbsp;<span>00</span><span> :00 - 02:00,&nbsp;</span></p><p>1.2 x</p>')).toBe(
      '1.1 00:00 - 02:00, \n1.2 x\n',
    )
  })
})
