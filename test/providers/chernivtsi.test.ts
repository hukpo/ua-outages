import { describe, expect, it } from 'vitest'
import { OutageClient } from '../../src/client.js'
import { parseTelegramPreview } from '../../src/emergency/telegram.js'
import { assessFreshness } from '../../src/freshness.js'
import {
  chernivtsiProvider,
  parseChannelPosts,
  parseDirectory,
  parsePowerOnText,
  parseSchedulePage,
} from '../../src/providers/chernivtsi.js'
import { fixture, mockFetch } from '../helpers.js'

const NOW = new Date('2026-11-05T23:50:00+02:00')
const SITE = 'https://oblenergo.cv.ua'
const TODAY = fixture('chernivtsi/shutdowns-2026-11-05.html')
const CHANNEL = 'https://t.me/s/oe_cv_ua'
/** Posts 4046–4054 (16.11 13:43 – 22:59): pictures with the caption "… на 16.11.2026" / "… на 17.11.2026" */
const PICTURES = fixture('chernivtsi/telegram-oe_cv_ua-4046-4054.trimmed.html')
/** Posts 4013–4024 (13.11 – 15.11): the schedule as text, then the first picture post (4024) */
const TEXTS = fixture('chernivtsi/telegram-oe_cv_ua-4013-4024.trimmed.html')
const EMPTY_DISTRICT =
  '<div id="obl_tbl" class="res_tbl"><div class="h_line"><s>Населений пункт</s><p>Вулиця</p><b>Будинок</b><u>Група</u></div><div><s>с. Десь</s><p>вул. Інша</p><b>буд. 1</b><u>1</u></div></div>'

function client(today = TODAY) {
  const { fetch, calls } = mockFetch([
    // the channel of 16.11: nothing in it is about 05.11 or 06.11
    { match: CHANNEL, body: PICTURES },
    { match: `${SITE}/shutdowns/?next`, body: fixture('chernivtsi/shutdowns-next-2026-11-06.html') },
    { match: `${SITE}/shutdowns/`, body: today },
    { match: `${SITE}/shutdowns-search/1/`, body: fixture('chernivtsi/shutdowns-search-1.trimmed.html') },
    { match: `${SITE}/shutdowns-search/2/`, body: fixture('chernivtsi/shutdowns-search-2.trimmed.html') },
    { match: /\/shutdowns-search\/\d+\/$/, body: EMPTY_DISTRICT },
  ])
  return {
    client: new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [chernivtsiProvider()] }),
    calls,
  }
}

const hhmm = (i: { from: string; to: string; kind: string }) =>
  `${i.from.slice(11, 16)}–${i.to.slice(11, 16)} ${i.kind}`

describe('Chernivtsioblenergo', () => {
  it('reads today and tomorrow for groups 1–12', async () => {
    const s = await client().client.getSchedules('chernivtsi')
    expect(s.groups).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
    expect(s.schedules['1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
  })

  it('turns 48 half-hour cells into intervals, "мз" as maybe', async () => {
    const s = await client().client.getSchedule('chernivtsi', '1')
    expect(s.days[0]!.intervals.map(hhmm)).toEqual([
      '02:00–04:00 off',
      '04:00–04:30 maybe',
      '08:00–11:00 off',
      '11:00–11:30 maybe',
      '15:00–17:00 off',
      '17:00–17:30 maybe',
      '20:00–22:30 off',
      '22:30–23:00 maybe',
    ])
    const g12 = (await client().client.getSchedule('chernivtsi', '12')).days[1]!
    expect(g12.intervals.at(-1)).toEqual({
      from: '2026-11-06T22:30:00+02:00',
      to: '2026-11-07T00:00:00+02:00',
      kind: 'off',
    })
  })

  it("does not take the page's half-hour mark for a change time", async () => {
    // "Графік актуальний станом на 23:30" moves by itself; no post in the channel is about
    // 05.11 or 06.11 either, so nothing says when these days last changed
    const s = await client().client.getSchedules('chernivtsi')
    expect(s.updatedAt).toBeNull()
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: true, dates: ['2026-11-05', '2026-11-06'] })
  })

  it('fetches only today while tomorrow is not published', async () => {
    const { client: c, calls } = client(TODAY.replace('href="/shutdowns/?next"', 'href="#"'))
    await c.getSchedules('chernivtsi')
    expect(calls.map((x) => x.url).filter((u) => u.startsWith(SITE))).toEqual([`${SITE}/shutdowns/`])
  })

  it('reads one day when "?next" is today\'s page again', async () => {
    // seen live after midnight: `?next` returned the same page
    const { fetch } = mockFetch([
      { match: CHANNEL, body: PICTURES },
      { match: `${SITE}/shutdowns/`, body: TODAY },
    ])
    const c = new OutageClient({ fetch, now: () => NOW, cacheTtlMs: 0, providers: [chernivtsiProvider()] })
    expect((await c.getSchedules('chernivtsi')).schedules['1']!.map((d) => d.date)).toEqual(['2026-11-05'])
  })

  it('marks an all-clear day as no outages', () => {
    const allOn = TODAY.replace(/<o>в<\/o>|<s>мз<\/s>/g, '<u>з</u>')
    const page = parseSchedulePage(allOn)
    expect(Object.values(page.days).every((d) => d.status === 'no-outages' && d.intervals.length === 0)).toBe(
      true,
    )
  })

  it('rejects a changed format', () => {
    expect(() => parseSchedulePage('<html><body>Технічні роботи</body></html>')).toThrow(/#gsv/)
    expect(() => parseSchedulePage(TODAY.replace('<o>в</o>', ''))).toThrow(
      expect.objectContaining({ code: 'parse', message: expect.stringMatching(/47 cells/) }),
    )
  })

  it('finds a house in the city directory, merging street spellings', async () => {
    const { client: c, calls } = client()
    const m = await c.findGroup('chernivtsi', {
      city: 'Чернівці',
      street: 'бульвар Героїв Крут',
      house: '22',
    })
    expect(m).toEqual({
      region: 'chernivtsi',
      group: '4',
      address: { city: 'м. Чернівці', street: 'бульвар ГЕРОЇВ КРУТ', house: '22' },
    })
    // the city of Chernivtsi needs only its own directory
    expect(calls.filter((x) => x.url.includes('shutdowns-search'))).toHaveLength(1)
  })

  it('finds a village house that belongs to two groups', async () => {
    const m = await client().client.findGroup('chernivtsi', {
      city: 'Чорногузи',
      street: 'Ярослава Мудрого',
      house: '3',
    })
    expect(m).toEqual({
      region: 'chernivtsi',
      group: '7',
      otherGroups: ['9'],
      address: { city: 'с. Чорногузи', street: 'вул. ЯРОСЛАВА МУДРОГО', house: '3' },
    })
  })

  it('skips GUID rows and unifies the case of settlement names', () => {
    const city = parseDirectory(fixture('chernivtsi/shutdowns-search-1.trimmed.html'), 1, 'Чернівці')
    const streets = [...city.cities.values()][0]!.streets
    expect([...streets.values()].some((s) => /[0-9a-f]{8}-/.test(s.street.name))).toBe(false)
    const district = parseDirectory(fixture('chernivtsi/shutdowns-search-2.trimmed.html'), 2, 'Вижницька')
    const names = [...district.cities.values()].map((c) => c.city.name)
    expect(names).toContain('м. Вижниця')
    expect(names.filter((n) => n.toLowerCase() === 'м. вижниця')).toHaveLength(1)
  })

  it('reports an unknown house with the closest numbers', async () => {
    await expect(
      client().client.findGroup('chernivtsi', {
        city: 'Чернівці',
        street: 'бульвар Героїв Крут',
        house: '999',
      }),
    ).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('Chernivtsioblenergo: the site and @oe_cv_ua as two channels', () => {
  /** The page as fetched on 17.11.2026 at 00:45 ("станом на 0:30") */
  const PAGE_17 = fixture('chernivtsi/shutdowns-2026-11-17.html')
  const AT = new Date('2026-11-17T00:45:00+02:00')
  /** The text fixture without its last post: the channel as it was before the first picture post */
  const TEXT_ONLY = TEXTS.slice(0, TEXTS.indexOf('data-post="oe_cv_ua/4024"') - 200)
  const posts = (html: string) => parseTelegramPreview(html)
  const hours = (d: { intervals: { from: string; to: string; kind: string }[] }) => d.intervals.map(hhmm)

  interface Setup {
    page?: string | null
    channel?: string | null
    older?: string
    now?: Date
  }
  function setup({ page = PAGE_17, channel = PICTURES, older = TEXTS, now = AT }: Setup = {}) {
    const { fetch, calls } = mockFetch([
      { match: `${CHANNEL}?before=`, body: older },
      { match: CHANNEL, body: channel ?? 'down', status: channel === null ? 503 : 200 },
      { match: `${SITE}/shutdowns/`, body: page ?? 'down', status: page === null ? 503 : 200 },
    ])
    const c = new OutageClient({
      fetch,
      now: () => now,
      cacheTtlMs: 0,
      retries: 0,
      providers: [chernivtsiProvider()],
    })
    return { client: c, calls }
  }

  /** CONSTRUCTED: a preview page with one text post, in the markup of the real ones */
  const postPage = (id: number, at: string, text: string) =>
    `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="oe_cv_ua/${id}">` +
    `<div class="tgme_widget_message_text js-message_text" dir="auto">${text.replace(/\n/g, '<br/>')}</div>` +
    `<a class="tgme_widget_message_date" href="https://t.me/oe_cv_ua/${id}"><time datetime="${at}" class="time">00:00</time></a></div></div>`
  /** The page's cells written the way the channel wrote days: windows WITH power per group */
  function asPowerOnText(page: ReturnType<typeof parseSchedulePage>, shift = 0): string {
    const clock = (m: number) =>
      `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    const lines = [
      `⚡️ Орієнтовний графік заживлення для груп споживачів • ${page.date.split('-').reverse().join('.')}`,
    ]
    for (const [g, day] of Object.entries(page.days)) {
      lines.push('', `💡 Група ${g}`)
      const start = Date.parse(`${page.date}T00:00:00+02:00`)
      let at = 0
      const gaps: [number, number][] = []
      for (const i of day.intervals) {
        const from = (Date.parse(i.from) - start) / 60_000
        const to = (Date.parse(i.to) - start) / 60_000
        if (gaps.length && gaps.at(-1)![1] === from) gaps.at(-1)![1] = to
        else gaps.push([from, to])
      }
      for (const [from, to] of gaps) {
        if (from > at) lines.push(`${clock(at)} - ${clock(from + shift)}`)
        at = to
      }
      if (at === 0) lines.push('Електропостачання без обмежень')
      else if (at < 1440) lines.push(`з ${clock(at)}`)
    }
    return lines.join('\n')
  }

  it('takes the change time of a day from the newest post about it, pictures included', async () => {
    const s = await setup().client.getSchedules('chernivtsi')
    expect(s.schedules['1']!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(hours(s.schedules['1']![0]!)).toEqual([
      '06:00–08:00 off',
      '08:00–08:30 maybe',
      '14:00–16:00 off',
      '16:00–16:30 maybe',
      '20:00–22:00 off',
      '22:00–22:30 maybe',
    ])
    // post 4054 "⚡ Орієнтовний графік заживлення на 17.11.2026", 16.11 22:59:32; not "станом на 0:30"
    expect(s.updatedAt).toBe('2026-11-16T22:59:32+02:00')
    expect(s.sources).toEqual([
      {
        id: 'site',
        url: 'https://oblenergo.cv.ua/shutdowns/',
        ok: true,
        dates: ['2026-11-17'],
        updatedAt: '2026-11-16T22:59:32+02:00',
      },
      // pictures carry no times: the channel supplies no day
      { id: 'telegram:@oe_cv_ua', url: CHANNEL, ok: true, dates: [], updatedAt: null },
    ])
    expect(assessFreshness(s, { now: AT })).toMatchObject({ state: 'fresh', today: 'published', issues: [] })
  })

  it('reads the clock and the text days off the channel', () => {
    const all = parseChannelPosts(posts(TEXTS))
    expect(Object.fromEntries(all.clock)).toEqual({
      '2026-11-13': '2026-11-13T18:39:19+02:00',
      '2026-11-14': '2026-11-14T06:03:25+02:00',
      // the picture post 4024; the text posts 4021–4023 before it are outdated by it
      '2026-11-15': '2026-11-15T17:00:08+02:00',
    })
    expect([...all.text.keys()]).toEqual(['2026-11-13', '2026-11-14'])
    // 4020 "✨ На 14.11.2026 / Електропостачання без обмежень для всіх груп споживачів!"
    expect(Object.values(all.text.get('2026-11-14')!)).toHaveLength(12)
    expect(Object.values(all.text.get('2026-11-14')!).every((d) => d.status === 'no-outages')).toBe(true)

    const before = parseChannelPosts(posts(TEXT_ONLY))
    expect(before.clock.get('2026-11-15')).toBe('2026-11-15T16:06:53+02:00')
    const day = before.text.get('2026-11-15')!
    expect(Object.keys(day)).toHaveLength(12)
    // 4023: "Група 1 / 00:00 - 17:00 / 19:30 - 23:00", "Група 3 / 00:00 - 19:00 / з 21:30"
    expect(hours(day['1']!)).toEqual(['17:00–19:30 off', '23:00–00:00 off'])
    expect(hours(day['3']!)).toEqual(['19:00–21:30 off'])
    expect(day['1']!.intervals.at(-1)!.to).toBe('2026-11-16T00:00:00+02:00')
    // 4018 for 13.11: "Група 5 / Електропостачання без обмежень" next to groups with outages
    expect(all.text.get('2026-11-13')!['5']).toEqual({
      date: '2026-11-13',
      status: 'scheduled',
      intervals: [],
    })
  })

  it("supplies a day from the channel's text when the site is down", async () => {
    const now = new Date('2026-11-15T16:30:00+02:00')
    const s = await setup({ page: null, channel: TEXT_ONLY, now }).client.getSchedules('chernivtsi')
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: false, error: { code: 'http' } })
    expect(s.sources![1]).toMatchObject({
      id: 'telegram:@oe_cv_ua',
      ok: true,
      // 14.11 ("без обмежень", post 4020) is in the window too, and is yesterday's
      dates: ['2026-11-15'],
      updatedAt: '2026-11-15T16:06:53+02:00',
    })
    expect(s.schedules['1']!.map((d) => d.date)).toEqual(['2026-11-15'])
    expect(hours(s.schedules['1']![0]!)).toEqual(['17:00–19:30 off', '23:00–00:00 off'])
    expect(s.updatedAt).toBe('2026-11-15T16:06:53+02:00')
    expect(assessFreshness(s, { now })).toMatchObject({ state: 'fresh', today: 'published' })
  })

  it("adds tomorrow from the channel's text while the site has only today", async () => {
    // CONSTRUCTED pairing: the page of 17.11 re-dated to 14.11, the evening the channel posted 15.11 (4021)
    const page = PAGE_17.replaceAll('17.11.2026', '14.11.2026')
    const channel = TEXTS.slice(0, TEXTS.indexOf('data-post="oe_cv_ua/4022"') - 200)
    const now = new Date('2026-11-14T20:30:00+02:00')
    const s = await setup({ page, channel, now }).client.getSchedules('chernivtsi')
    expect(s.schedules['1']!.map((d) => d.date)).toEqual(['2026-11-14', '2026-11-15'])
    // 4021: "Група 1 / 00:00 - 20:00 / з 22:30"
    expect(hours(s.schedules['1']![1]!)).toEqual(['20:00–22:30 off'])
    expect(s.sources!.map((x) => [x.id, x.dates])).toEqual([
      ['site', ['2026-11-14']],
      ['telegram:@oe_cv_ua', ['2026-11-15']],
    ])
    expect(s.updatedAt).toBe('2026-11-14T20:25:46+02:00')
    // the page (with outages) against "без обмежень для всіх груп" for the same day: flagged
    expect(s.sources![1]!.disagrees).toBe(true)
  })

  it('does not count the page\'s "maybe" half hours as a disagreement with the text', async () => {
    const page = parseSchedulePage(PAGE_17)
    const same = postPage(4060, '2026-11-17T00:40:00+00:00', asPowerOnText(page))
    const s = await setup({ channel: same, now: new Date('2026-11-17T03:00:00+02:00') }).client.getSchedules(
      'chernivtsi',
    )
    expect(s.sources!.map((x) => [x.id, x.dates, x.disagrees])).toEqual([
      ['site', ['2026-11-17'], undefined],
      ['telegram:@oe_cv_ua', [], undefined],
    ])
    expect(s.updatedAt).toBe('2026-11-17T02:40:00+02:00')
    expect(hours(s.schedules['1']![0]!)).toContain('08:00–08:30 maybe')

    // the text moved by half an hour is a different schedule: the channel is marked
    const moved = postPage(4060, '2026-11-17T00:40:00+00:00', asPowerOnText(page, 30))
    const d = await setup({ channel: moved, now: new Date('2026-11-17T03:00:00+02:00') }).client.getSchedules(
      'chernivtsi',
    )
    expect(d.sources![1]).toMatchObject({ id: 'telegram:@oe_cv_ua', dates: [], disagrees: true })
    // same change time on both: the site, the first channel, keeps the day
    expect(hours(d.schedules['1']![0]!)).toContain('06:00–08:00 off')
  })

  it('reads the site without a change time when the channel is down', async () => {
    const s = await setup({ channel: null }).client.getSchedules('chernivtsi')
    expect(s.schedules['1']!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(s.updatedAt).toBeNull()
    expect(s.sources![0]).toMatchObject({ id: 'site', ok: true, dates: ['2026-11-17'], updatedAt: null })
    expect(s.sources![1]).toMatchObject({ id: 'telegram:@oe_cv_ua', ok: false, error: { code: 'http' } })
  })

  it('fails when both channels are down', async () => {
    await expect(
      setup({ page: null, channel: null }).client.getSchedules('chernivtsi'),
    ).rejects.toMatchObject({
      code: 'http',
    })
  })

  it('never dates an old page today', async () => {
    // the page of 17.11 still served on 18.11 (page date ≠ today)
    const now = new Date('2026-11-18T09:00:00+02:00')
    const s = await setup({ now }).client.getSchedules('chernivtsi')
    expect(s.schedules['1']!.map((d) => d.date)).toEqual(['2026-11-17'])
    expect(assessFreshness(s, { now })).toMatchObject({ state: 'stale', today: 'missing' })
  })

  it('leaves a post unread rather than misreading it', () => {
    const ok =
      '⚡️ Орієнтовний графік заживлення для груп споживачів • 15.11.2026\n\n💡 Група 1\n00:00 - 17:00\nз 19:30\n\n☝️Дізнатись номер своєї групи'
    expect(hours(parsePowerOnText(ok, '2026-11-15')!['1']!)).toEqual(['17:00–19:30 off'])
    for (const bad of [
      ok.replace('з 19:30', 'орієнтовно з 19:30'),
      ok.replace('з 19:30', '16:00 - 20:00'),
      ok.replace('00:00 - 17:00', '17:00 - 00:00'),
      ok.replace('00:00 - 17:00\nз 19:30', ''),
      ok.replace('Група 1', 'Група 13'),
      `${ok}\n\n💡 Група 1\n00:00 - 12:00`,
      ok.replace('з 19:30', 'Електропостачання без обмежень'),
      // a picture's caption: no group blocks at all
      '⚡ Орієнтовний графік заживлення на 15.11.2026\n━━━━━━━━━━━',
    ])
      expect(parsePowerOnText(bad, '2026-11-15')).toBeNull()

    const at = (text: string, when: string) =>
      parseChannelPosts([{ channel: 'oe_cv_ua', id: 1, url: '', at: when, text, edited: false, photos: [] }])
    // a newest post that can't be read leaves no text day for its date, but still moves the clock
    const odd = at(ok.replace('з 19:30', 'орієнтовно з 19:30'), '2026-11-15T10:00:00+02:00')
    expect([...odd.text.keys()]).toEqual([])
    expect(odd.clock.get('2026-11-15')).toBe('2026-11-15T10:00:00+02:00')
    // a post about a date that is neither its own day nor the next one is a misdated post
    expect(at(ok, '2026-11-17T10:00:00+02:00').clock.size).toBe(0)
    expect(at(ok, '2026-11-14T21:00:00+02:00').clock.get('2026-11-15')).toBe('2026-11-14T21:00:00+02:00')
    // other posts of the channel are not about a schedule
    expect(at('Шановні споживачі! 15.11.2026 планові роботи', '2026-11-15T10:00:00+02:00').clock.size).toBe(0)
  })
})
