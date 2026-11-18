import { describe, expect, it } from 'vitest'
import { AiRuntime } from '../../src/ai/runtime.js'
import type { PostAnalysis, PostEvent, PostInput, TextProcessor } from '../../src/ai/types.js'
import { OutageClient } from '../../src/client.js'
import { parseTelegramPreview } from '../../src/emergency/telegram.js'
import { assessFreshness } from '../../src/freshness.js'
import { Http } from '../../src/http.js'
import { cekDays, cekDaysToSource } from '../../src/providers/cek-telegram.js'
import type { RegionSchedule } from '../../src/types.js'
import { ev, fakeText, fixture, gpvSchedule, intervalsOf, mockFetch } from '../helpers.js'

const API = 'app.yasno.ua/api/blackout-service/public/shutdowns/regions/3/dsos/303/planned-outages'
const TG = 't.me/s/cek_info'
const CHANNEL = 'telegram:@cek_info'

/** 15–17.11.2026: lists for 16.11 and 17.11, Pavlohrad's own lists, an emergency and its cancellation */
const PAGE_17 = fixture('dnipro-cek/telegram-cek_info-4409-4417.trimmed.html')
/** 12–13.11.2026: the list for 13.11, six changes told in sentences, then the rest of the day as a list */
const PAGE_13 = fixture('dnipro-cek/telegram-cek_info-4377-4384.trimmed.html')
/** YASNO 3/303 at 00:21 on 17.11.2026: EmergencyShutdowns for both days, no slots, updatedOn 16.11 18:12:37 */
const YASNO_EMERGENCY = fixture('yasno/planned-outages-3-303-2026-11-17T0021.emergency.json')
/** The same feed a day earlier (dates moved back by hand: nobody saved it on the 16th) */
const YASNO_EMERGENCY_16 = YASNO_EMERGENCY.replaceAll('2026-11-17T00', '2026-11-16T00').replaceAll(
  '2026-11-18T00',
  '2026-11-17T00',
)

/** The posts of a saved preview page up to `last` (the channel as it was at that moment) */
function upTo(page: string, last: number): string {
  const [head, ...blocks] = page.split(/(?=<div class="tgme_widget_message_wrap\b)/)
  return head + blocks.filter((b) => Number(/data-post="[^"/]+\/(\d+)"/.exec(b)![1]) <= last).join('')
}

/** A preview page of made-up posts, for the cases no saved page has */
const page = (posts: { id: number; at: string; text: string }[]) =>
  posts
    .map(
      (p) =>
        `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="cek_info/${p.id}">` +
        `<div class="tgme_widget_message_text js-message_text" dir="auto">${p.text.replace(/\n/g, '<br/>')}</div>` +
        `<span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/cek_info/${p.id}"><time datetime="${p.at}" class="time">00:00</time></a></span></div></div>`,
    )
    .join('\n')

// --- what a model reads in @cek_info's posts ---

/** "🔹 Черга 1.1" (or a bare "1.1") and the "HH:MM-HH:MM" lines under it → the schedule */
function blocks(text: string): PostEvent['schedule'] {
  const out: PostEvent['schedule'] = []
  for (const line of text.split('\n').map((l) => l.trim())) {
    const q = /^(?:🔹 Черга )?(\d\.\d)$/.exec(line)
    if (q) out.push({ queue: q[1]!, intervals: [] })
    else if (/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(line) && out.length)
      out.at(-1)!.intervals!.push(...intervalsOf(line))
  }
  return out
}
const gpv = (e: Partial<PostEvent>) => ev({ kind: 'gpv', action: 'start', regions: ['dnipro-cek'], ...e })
/** A list: the day, and the hour it applies from when the heading gives one ("з 04:00") */
const list = (date: string, at: string | null = null) => ({ date, at })
/** A correction in a sentence: the window when it gives both ends, else the queues not known */
const words = (date: string, queues: string[], window: string | null, at: string | null = null) => [
  gpv({
    action: 'change',
    date,
    at,
    additive: true,
    schedule: gpvSchedule(Object.fromEntries(queues.map((q) => [q, window])), queues),
  }),
]
/** Pavlohrad's own list: an `area`, its own numbering */
const town = (date: string, hours: Record<string, string>) => [
  gpv({
    date,
    area: 'м. Павлоград',
    schedule: Object.entries(hours).map(([queue, h]) => ({ queue, intervals: intervalsOf(h) })),
  }),
]
const ANSWERS: Record<number, ReturnType<typeof list> | PostEvent[]> = {
  4377: list('2026-11-13'),
  // "з 00:00 до 06:00 додатково застосовуються відлючення черги 3.1, 3.2"
  4378: words('2026-11-13', ['3.1', '3.2'], '00:00-06:00', '00:00'),
  // "з 02:30 додатково застосовуються відлючення черги 6.1, 6.2": no end
  4379: words('2026-11-13', ['6.1', '6.2'], null, '02:30'),
  4380: words('2026-11-13', ['1.1'], null, '06:00'),
  4381: words('2026-11-13', ['2.1'], null, '08:00'),
  // "з 09:30 до 13:00 відключаються черги: 1.1, 1.2, 2.1, 2.2, 3.1 та 3.2"
  4382: words('2026-11-13', ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2'], '09:30-13:00', '09:30'),
  // "з 09:00 відключаються додатково чергb: 1.2, 4.1 та 4.2"
  4383: words('2026-11-13', ['1.2', '4.1', '4.2'], null, '09:00'),
  // "зміни у ГПВ на 13 ЛИСТОПАДА з 10:00 до 24:00"
  4384: list('2026-11-13', '10:00'),
  4409: list('2026-11-16'),
  // "зміни у ГПВ на 16 ЛИСТОПАДА за розпорядженням …": the whole day again
  4410: list('2026-11-16'),
  // "зміни у ГПВ 16 ЛИСТОПАДА з 04:00"
  4411: list('2026-11-16', '04:00'),
  4413: town('2026-11-16', { '2.2': '09:00-14:00, 19:00-24:00', '6.2': '14:00-19:00' }),
  // "застосовуються ЕКСТРЕНІ ВІДКЛЮЧЕННЯ‼️ ГРАФІКИ ПОГОДИННИХ ВІДКЛЮЧЕНЬ не діють"
  4414: [ev({ kind: 'emergency', action: 'start', regions: ['dnipro-cek'], gpvApplies: false })],
  4415: town('2026-11-17', {
    '2.2': '05:00-10:00, 15:00-20:00',
    '6.2': '00:00-05:00, 10:00-15:00, 20:00-24:00',
  }),
  // "скасування ЕКСТРЕНИХ ВІДКЛЮЧЕНЬ ‼️ Повертаємося до ГРАФІКІВ ПОГОДИННИХ ВІДКЛЮЧЕНЬ"
  4416: [ev({ kind: 'emergency', action: 'cancel', regions: ['dnipro-cek'], gpvApplies: true })],
  4417: list('2026-11-17'),
  // CONSTRUCTED below: the list for 06.11 the evening before, and a list for 05.11 during that day
  4321: list('2026-11-05'),
  4322: list('2026-11-06'),
}
function cekAnswer(input: PostInput): PostEvent[] | undefined {
  const a = ANSWERS[Number(input.url.split('/').at(-1))]
  if (!a || Array.isArray(a)) return a
  return [gpv({ date: a.date, at: a.at, schedule: blocks(input.text) })]
}
/** The model, with a few posts answered otherwise */
const cekText = (extra: Record<number, Partial<PostAnalysis> | PostEvent[]> = {}) =>
  fakeText((input) => extra[Number(input.url.split('/').at(-1))] ?? cekAnswer(input))

/** `cekDays` as the source runs it, on a preview page, at `now` */
const days = (html: string, now: string, text: TextProcessor = cekText()) =>
  cekDays(
    {
      http: new Http({ fetch: mockFetch([]).fetch }),
      now: () => new Date(now),
      ai: new AiRuntime({ textProcessor: text }),
    },
    parseTelegramPreview(html),
  )
const hours = (slots: readonly { start: number; end: number }[] | null | undefined) =>
  slots &&
  [...slots]
    .sort((a, b) => a.start - b.start)
    .map((s) =>
      [s.start, s.end]
        .map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
        .join('-'),
    )
    .join(' ')
const spans = (s: RegionSchedule, group: string, date: string) =>
  s.schedules[group]!.find((d) => d.date === date)!.intervals.map(
    (i) => `${i.from.slice(11, 16)}–${i.to.slice(11, 16)} ${i.kind}`,
  )
const source = (s: RegionSchedule, id: string) => s.sources!.find((x) => x.id === id)!

function client(
  now: string,
  yasno: string | null,
  channel: string | null,
  text: TextProcessor | null = cekText(),
) {
  const { fetch, calls } = mockFetch([
    yasno === null ? { match: API, body: 'bad gateway', status: 502 } : { match: API, body: yasno },
    channel === null ? { match: TG, body: 'bad gateway', status: 502 } : { match: TG, body: channel },
  ])
  return {
    client: new OutageClient({
      fetch,
      now: () => new Date(now),
      cacheTtlMs: 0,
      retries: 0,
      textProcessor: text ?? undefined,
    }),
    calls,
  }
}

describe('@cek_info lists', () => {
  it('takes the whole-day list, its replacement and a change from an hour on', async () => {
    // 4409 (15.11 22:42): "16 ЛИСТОПАДА з 00:00 до 24:00 застосовуватимуться відключення наступних черг"
    const first = (await days(upTo(PAGE_17, 4409), '2026-11-15T23:00:00+02:00')).get('2026-11-16')!
    expect(new Date(first.at).toISOString()).toBe('2026-11-15T20:42:50.000Z')
    expect(hours(first.groups['1.1'])).toBe('00:30-04:00 11:00-14:30 21:30-24:00')
    expect(hours(first.groups['4.1'])).toBe('06:00-07:30 14:30-18:00')
    expect(Object.keys(first.groups)).toHaveLength(12)

    // 4410 (23:28): "зміни у ГПВ на 16 ЛИСТОПАДА за розпорядженням …": the whole day again
    const replaced = (await days(upTo(PAGE_17, 4410), '2026-11-15T23:40:00+02:00')).get('2026-11-16')!
    expect(hours(replaced.groups['1.1'])).toBe('00:00-04:00 07:30-14:30 18:00-24:00')
    expect(hours(replaced.groups['3.1'])).toBe('00:30-07:30 11:00-18:00 21:30-24:00')

    // 4411 (16.11 03:36): "зміни у ГПВ 16 ЛИСТОПАДА з 04:00": the hours before 04:00 stay
    const changed = (await days(upTo(PAGE_17, 4411), '2026-11-16T04:00:00+02:00')).get('2026-11-16')!
    expect(hours(changed.groups['1.1'])).toBe('00:00-04:00 07:30-14:30 18:00-24:00')
    expect(hours(changed.groups['5.1'])).toBe('00:00-00:30 04:00-11:00 14:30-21:30')
    expect(hours(changed.groups['4.2'])).toBe('00:30-04:00 04:00-07:30 11:00-18:00 21:30-24:00')
    expect(changed.url).toBe('https://t.me/cek_info/4411')
  })

  it('never takes Pavlohrad’s own numbering for the region’s queues', async () => {
    const all = await days(PAGE_17, '2026-11-17T00:28:00+02:00')
    // 4417 (17.11 00:18): "17 ЛИСТОПАДА з 00:00 до 24:00 діятимуть наступні черги:"
    const today = all.get('2026-11-17')!
    expect(today.url).toBe('https://t.me/cek_info/4417')
    expect(hours(today.groups['1.1'])).toBe('00:00-01:00 04:30-11:30 15:00-22:00')
    expect(hours(today.groups['6.2'])).toBe('01:00-08:00 11:30-18:30 22:00-24:00')
    // 4415 "м. ПАВЛОГРАД … ГПВ на 17 ЛИСТОПАДА … 📌 2.2 черга: 05:00 - 10:00" is a town's separate list
    expect(hours(today.groups['2.2'])).toBe('00:00-01:00 04:30-11:30 15:00-22:00')
    // 4413, the same for 16.11, left the region's 2.2 alone as well, and isn't the day's newest post
    expect(hours(all.get('2026-11-16')!.groups['2.2'])).toBe('00:00-04:00 07:30-14:30 18:00-24:00')
    expect(all.get('2026-11-16')!.url).not.toBe('https://t.me/cek_info/4413')
  })

  it('dates a day by "Повертаємося до ГРАФІКІВ ПОГОДИННИХ ВІДКЛЮЧЕНЬ", not by the emergency notice', async () => {
    // 4414 (16.11 21:29) "застосовуються ЕКСТРЕНІ ВІДКЛЮЧЕННЯ": the emergency reader's, the list isn't touched
    const during = (await days(upTo(PAGE_17, 4414), '2026-11-16T21:35:00+02:00')).get('2026-11-16')!
    expect(during.url).toBe('https://t.me/cek_info/4411')
    // 4416 (22:56): the list stands again as of that post
    const after = (await days(upTo(PAGE_17, 4416), '2026-11-16T23:00:00+02:00')).get('2026-11-16')!
    expect(new Date(after.at).toISOString()).toBe('2026-11-16T20:56:57.000Z')
    expect(after.url).toBe('https://t.me/cek_info/4416')
    expect(after.groups).toEqual(during.groups)
    // a cancel that doesn't say the hourly schedule is back moves nothing
    const quiet = cekText({ 4416: [ev({ kind: 'emergency', action: 'cancel', regions: ['dnipro-cek'] })] })
    const unsaid = (await days(upTo(PAGE_17, 4416), '2026-11-16T23:00:00+02:00', quiet)).get('2026-11-16')!
    expect(unsaid.url).toBe('https://t.me/cek_info/4411')
  })

  it('applies a change in a sentence only when it is exact, and marks the rest unknown', async () => {
    const at = async (last: number) =>
      (await days(upTo(PAGE_13, last), '2026-11-13T12:00:00+02:00')).get('2026-11-13')!
    const d4377 = await at(4377)
    expect(hours(d4377.groups['3.1'])).toBe('02:30-06:00 13:00-16:30 23:30-24:00')
    // 4378: "з 00:00 до 06:00 додатково застосовуються відлючення черги 3.1, 3.2": one window, added
    const d4378 = await at(4378)
    expect(hours(d4378.groups['3.1'])).toBe('00:00-06:00 02:30-06:00 13:00-16:30 23:30-24:00')
    expect(d4378.groups['1.1']).toEqual(d4377.groups['1.1'])
    // 4379: "з 02:30 додатково застосовуються відлючення черги 6.1, 6.2": no end, so not known
    const d4379 = await at(4379)
    expect(d4379.groups['6.1']).toBeNull()
    expect(d4379.groups['6.2']).toBeNull()
    expect(d4379.groups['5.1']).toEqual(d4377.groups['5.1'])
    // 4380, 4381 name 1.1 and 2.1 the same way; 4382 "з 09:30 до 13:00 відключаються черги: 1.1 … 3.2"
    // adds the window to the groups still known; 4383 "з 09:00 відключаються додатково: 1.2, 4.1 та 4.2"
    const before = await at(4383)
    expect(
      Object.entries(before.groups)
        .filter(([, s]) => s === null)
        .map(([g]) => g),
    ).toEqual(['1.1', '1.2', '2.1', '4.1', '4.2', '6.1', '6.2'])
    expect(hours(before.groups['2.2'])).toContain('09:30-13:00')
    const source = cekDaysToSource(new Map([['2026-11-13', before]]), new Date('2026-11-13T09:30:00+02:00'))
    expect(source.days['2026-11-13']!.schedules['6.1']).toEqual({
      date: '2026-11-13',
      status: 'unknown',
      intervals: [],
    })
    expect(source.days['2026-11-13']!.schedules['5.1']!.status).toBe('scheduled')
    // 4384 (10:16): "зміни у ГПВ на 13 ЛИСТОПАДА з 10:00 до 24:00" + a list: the groups still known
    // take it; one whose morning was left unknown stays unknown (an empty morning would read as
    // "no outages") until a whole-day list
    const rest = await at(4384)
    expect(
      Object.entries(rest.groups)
        .filter(([, s]) => s === null)
        .map(([g]) => g),
    ).toEqual(['1.1', '1.2', '2.1', '4.1', '4.2', '6.1', '6.2'])
    expect(hours(rest.groups['5.1'])).toBe('06:00-09:30 13:00-20:00 23:30-24:00')
  })

  it('refuses a recent post it cannot read, and skips an old one', async () => {
    const text =
      'Повідомляємо, що … 17 ЛИСТОПАДА з 00:00 до 24:00 застосовуватимуться відключення наступних черг:'
    // the answer fails validation: a time that doesn't exist
    const misread = fakeText(() => [
      gpv({ date: '2026-11-17', schedule: [{ queue: '1.1', intervals: intervalsOf('04:00-25:00') }] }),
    ])
    await expect(
      days(page([{ id: 1, at: '2026-11-16T22:18:35+00:00', text }]), '2026-11-17T00:28:00+02:00', misread),
    ).rejects.toMatchObject({ code: 'parse' })
    // posted before yesterday: skipped
    expect(
      (
        await days(
          page([{ id: 1, at: '2026-11-14T22:18:35+00:00', text }]),
          '2026-11-17T00:28:00+02:00',
          misread,
        )
      ).size,
    ).toBe(0)
  })

  // a list for a window of the day ("з 10:00 до 16:00", `at` and `until`) replaces that window
  // only: a group it leaves out keeps its evening
  it('a change for a window of the day leaves the hours after it alone', async () => {
    const listPost = {
      id: 1,
      at: '2026-11-16T20:00:00+00:00',
      text: '… 17 ЛИСТОПАДА з 00:00 до 24:00 застосовуватимуться відключення наступних черг:\n🔹 Черга 1.1\n00:30-04:00\n18:00-22:00\n🔹 Черга 3.1\n04:00-07:30\n20:00-24:00',
    }
    const window = {
      id: 2,
      at: '2026-11-17T07:50:00+00:00',
      text: 'Повідомляємо про зміни у ГПВ на 17 ЛИСТОПАДА з 10:00 до 16:00, за розпорядженням НЕК "Укренерго":\n🔹 Черга 1.1\n10:00-12:00',
    }
    const text = fakeText((input) =>
      input.url.endsWith('/1')
        ? [gpv({ date: '2026-11-17', schedule: blocks(input.text) })]
        : [gpv({ date: '2026-11-17', at: '10:00', until: '16:00', schedule: blocks(input.text) })],
    )
    const day = (await days(page([listPost, window]), '2026-11-17T12:00:00+02:00', text)).get('2026-11-17')!
    expect(hours(day.groups['1.1'])).toBe('00:30-04:00 10:00-12:00 18:00-22:00')
    expect(hours(day.groups['3.1'])).toBe('04:00-07:30 20:00-24:00')
  })
})

describe('dnipro-cek: YASNO and @cek_info merged', () => {
  it('takes the operator’s list while YASNO still shows a cancelled emergency', async () => {
    // 17.11.2026 00:28, as measured: the channel cancelled at 22:56 and posted the list at 00:18
    const now = '2026-11-17T00:28:00+02:00'
    const s = await client(now, YASNO_EMERGENCY, PAGE_17).client.getSchedules('dnipro-cek')
    expect(s.groups).toHaveLength(12)
    expect(s.schedules['1.1']!.map((d) => [d.date, d.status])).toEqual([
      ['2026-11-17', 'scheduled'],
      // YASNO's "EmergencyShutdowns" for tomorrow says nothing about tomorrow
      ['2026-11-18', 'unknown'],
    ])
    expect(spans(s, '1.1', '2026-11-17')).toEqual(['00:00–01:00 off', '04:30–11:30 off', '15:00–22:00 off'])
    expect(s.updatedAt).toBe('2026-11-17T00:18:35+02:00')
    expect(s.sources).toEqual([
      {
        id: 'api',
        url: 'https://static.yasno.ua/dnipro/outages',
        ok: true,
        dates: [],
        updatedAt: '2026-11-16T18:12:37+02:00',
        disagrees: true,
      },
      {
        id: CHANNEL,
        url: 'https://t.me/cek_info/4417',
        ok: true,
        dates: ['2026-11-17'],
        updatedAt: '2026-11-17T00:18:35+02:00',
      },
    ])
    expect(assessFreshness(s, { now: new Date(now) })).toMatchObject({
      state: 'fresh',
      today: 'published',
      issues: [expect.objectContaining({ code: 'sources-disagree' })],
    })
  })

  it('follows the emergency and its cancellation by the time of each statement', async () => {
    // 21:35: YASNO's emergency (18:12) is newer than the day's list (03:36)
    const during = await client(
      '2026-11-16T21:35:00+02:00',
      YASNO_EMERGENCY_16,
      upTo(PAGE_17, 4414),
    ).client.getSchedules('dnipro-cek')
    expect(during.schedules['1.1']![0]).toEqual({ date: '2026-11-16', status: 'emergency', intervals: [] })
    expect(source(during, 'api')).toMatchObject({
      dates: ['2026-11-16'],
      updatedAt: '2026-11-16T18:12:37+02:00',
    })
    expect(source(during, CHANNEL)).toMatchObject({ dates: [], disagrees: true })

    // 23:00: "Повертаємося до ГРАФІКІВ ПОГОДИННИХ ВІДКЛЮЧЕНЬ" (22:56) is newer than YASNO's emergency
    const after = await client(
      '2026-11-16T23:00:00+02:00',
      YASNO_EMERGENCY_16,
      upTo(PAGE_17, 4416),
    ).client.getSchedules('dnipro-cek')
    expect(after.schedules['1.1']![0]!.status).toBe('scheduled')
    expect(spans(after, '1.1', '2026-11-16').at(-1)).toBe('18:00–00:00 off')
    expect(after.updatedAt).toBe('2026-11-16T22:56:57+02:00')
    expect(source(after, CHANNEL)).toMatchObject({ dates: ['2026-11-16'] })
  })

  it('takes tomorrow from the channel the evening before, and YASNO’s day when YASNO is newer', async () => {
    // YASNO of 05.11 (updatedOn 23:01:18): today and tomorrow apply; the channel posted 06.11 at 22:43
    const text =
      '📢 Шановні споживачі! Повідомляємо, що за розпорядженням диспетчерського центру НЕК "Укренерго", 06 ЛИСТОПАДА з 00:00 до 24:00 застосовуватимуться відключення наступних черг:\n🔹 Черга 1.1\n00:00-02:30\n09:30-13:00'
    const channel = page([{ id: 4322, at: '2026-11-05T20:43:23+00:00', text }])
    const yasno = fixture('yasno/planned-outages-3-303.json')
    const s = await client('2026-11-05T23:30:00+02:00', yasno, channel).client.getSchedules('dnipro-cek')
    expect(source(s, 'api')).toMatchObject({
      dates: ['2026-11-05', '2026-11-06'],
      updatedAt: '2026-11-05T23:01:18+02:00',
    })
    expect(source(s, CHANNEL)).toMatchObject({ dates: [], updatedAt: '2026-11-05T22:43:23+02:00' })

    // the same evening with YASNO still waiting for 06.11: the channel supplies it
    const waiting = JSON.parse(yasno) as Record<string, { tomorrow: { status: string; slots: unknown[] } }>
    for (const g of Object.values(waiting))
      g.tomorrow = { ...g.tomorrow, status: 'WaitingForSchedule', slots: [] }
    const t = await client('2026-11-05T23:30:00+02:00', JSON.stringify(waiting), channel).client.getSchedules(
      'dnipro-cek',
    )
    expect(source(t, 'api').dates).toEqual(['2026-11-05'])
    expect(source(t, CHANNEL).dates).toEqual(['2026-11-06'])
    expect(spans(t, '1.1', '2026-11-06')).toEqual(['00:00–02:30 off', '09:30–13:00 off'])
    // a group the list leaves out has no outages that day
    expect(t.schedules['6.2']![1]).toEqual({ date: '2026-11-06', status: 'scheduled', intervals: [] })
    expect(assessFreshness(t, { now: new Date('2026-11-05T23:30:00+02:00') }).tomorrow).toBe('published')
  })

  it('keeps answering from one source when the other is down, and fails when both are', async () => {
    const now = '2026-11-17T00:28:00+02:00'
    const noChannel = await client(now, YASNO_EMERGENCY, null).client.getSchedules('dnipro-cek')
    expect(noChannel.schedules['1.1']![0]!.status).toBe('emergency')
    expect(source(noChannel, CHANNEL)).toMatchObject({ ok: false, error: { code: 'http' } })

    const noYasno = await client(now, null, PAGE_17).client.getSchedules('dnipro-cek')
    expect(noYasno.schedules['1.1']!.map((d) => [d.date, d.status])).toEqual([['2026-11-17', 'scheduled']])
    expect(source(noYasno, 'api')).toMatchObject({ ok: false, error: { code: 'http' } })
    expect(assessFreshness(noYasno, { now: new Date(now) }).issues.map((i) => i.code)).toEqual([
      'source-failed',
    ])

    await expect(client(now, null, null).client.getSchedules('dnipro-cek')).rejects.toMatchObject({
      code: 'http',
      message: expect.stringMatching(/app\.yasno\.ua answered 502/),
    })
  })

  it('answers from YASNO alone without a text processor; the channel is `config`', async () => {
    const now = '2026-11-17T00:28:00+02:00'
    const s = await client(now, YASNO_EMERGENCY, PAGE_17, null).client.getSchedules('dnipro-cek')
    expect(s.schedules['1.1']![0]!.status).toBe('emergency')
    expect(source(s, CHANNEL)).toMatchObject({ ok: false, error: { code: 'config' } })
    expect(source(s, 'api')).toMatchObject({ ok: true })
  })

  it('reports an unreadable recent list as a failed channel instead of an older schedule', async () => {
    const now = '2026-11-17T00:28:00+02:00'
    // the newest list, misread: a queue twice
    const twice = [
      gpv({ date: '2026-11-17', schedule: gpvSchedule({ '1.1': '00:00-01:00' }, ['1.1', '1.1']) }),
    ]
    const s = await client(now, YASNO_EMERGENCY, PAGE_17, cekText({ 4417: twice })).client.getSchedules(
      'dnipro-cek',
    )
    expect(source(s, CHANNEL)).toMatchObject({
      ok: false,
      error: { code: 'parse', message: expect.stringContaining('https://t.me/cek_info/4417') },
    })
    expect(s.schedules['1.1']![0]!.status).toBe('emergency')
  })
})

describe('dnipro-cek: one YASNO stamp for every day', () => {
  // YASNO's `updatedOn` moves when tomorrow comes out; today's hours under it are the old ones
  const morning = JSON.parse(fixture('yasno/planned-outages-3-303.json')) as Record<
    string,
    { tomorrow: { status: string; slots: unknown[] }; updatedOn: string }
  >
  const evening = structuredClone(morning)
  for (const g of Object.values(morning)) {
    g.tomorrow = { ...g.tomorrow, status: 'WaitingForSchedule', slots: [] }
    g.updatedOn = '2026-11-05T08:00:00+00:00'
  }
  for (const g of Object.values(evening)) g.updatedOn = '2026-11-05T18:50:00+00:00'
  /** A post from days before: the channel answers and says nothing about these days */
  const QUIET = {
    id: 4300,
    at: '2026-11-01T10:00:00+00:00',
    text: 'Шановні споживачі! Дякуємо за розуміння.',
  }
  const correction = page([
    QUIET,
    {
      id: 4321,
      at: '2026-11-05T13:30:00+00:00',
      text: '📢 Шановні споживачі! Повідомляємо, що за розпорядженням диспетчерського центру НЕК "Укренерго", 05 ЛИСТОПАДА з 00:00 до 24:00 застосовуватимуться відключення наступних черг:\n🔹 Черга 1.1\n18:00-20:00',
    },
  ])

  function longLived() {
    const state = { now: '2026-11-05T15:00:00+02:00', yasno: JSON.stringify(morning), channel: page([QUIET]) }
    const { fetch } = mockFetch([
      { match: API, body: () => state.yasno },
      { match: TG, body: () => state.channel },
    ])
    const client = new OutageClient({
      fetch,
      now: () => new Date(state.now),
      cacheTtlMs: 0,
      retries: 0,
      textProcessor: cekText(),
    })
    return { state, client }
  }

  it('a day YASNO did not change keeps its time, so the operator’s later correction stays', async () => {
    const { state, client } = longLived()
    const first = await client.getSchedules('dnipro-cek')
    expect(first.sources!.map((x) => x.ok)).toEqual([true, true])
    expect(source(first, 'api')).toMatchObject({
      dates: ['2026-11-05'],
      updatedAt: '2026-11-05T10:00:00+02:00',
    })

    // 15:30: ЦЕК corrects today in its channel
    Object.assign(state, { now: '2026-11-05T16:00:00+02:00', channel: correction })
    const corrected = await client.getSchedules('dnipro-cek')
    expect(spans(corrected, '1.1', '2026-11-05')).toEqual(['18:00–20:00 off'])

    // 20:50: YASNO publishes tomorrow; its today is still the morning's
    Object.assign(state, { now: '2026-11-05T21:00:00+02:00', yasno: JSON.stringify(evening) })
    const s = await client.getSchedules('dnipro-cek')
    expect(spans(s, '1.1', '2026-11-05')).toEqual(['18:00–20:00 off'])
    expect(source(s, CHANNEL)).toMatchObject({ dates: ['2026-11-05'] })
    expect(source(s, 'api')).toMatchObject({
      dates: ['2026-11-06'],
      updatedAt: '2026-11-05T20:50:00+02:00',
      disagrees: true,
    })
    expect(s.updatedAt).toBe('2026-11-05T20:50:00+02:00')
  })

  it('a day YASNO did change takes the new time', async () => {
    const { state, client } = longLived()
    await client.getSchedules('dnipro-cek')
    const changed = structuredClone(evening) as unknown as Record<string, { today: { slots: unknown[] } }>
    changed['1.1']!.today.slots = [{ start: 60, end: 120, type: 'Definite' }]
    Object.assign(state, {
      now: '2026-11-05T21:00:00+02:00',
      yasno: JSON.stringify(changed),
      channel: correction,
    })
    const s = await client.getSchedules('dnipro-cek')
    expect(spans(s, '1.1', '2026-11-05')).toEqual(['01:00–02:00 off'])
    expect(source(s, 'api').dates).toEqual(['2026-11-05', '2026-11-06'])
  })

  it('a new client cannot know and reads as before: the stamp it is given', async () => {
    const { state, client } = longLived()
    Object.assign(state, {
      now: '2026-11-05T21:00:00+02:00',
      yasno: JSON.stringify(evening),
      channel: correction,
    })
    const s = await client.getSchedules('dnipro-cek')
    expect(source(s, 'api').dates).toEqual(['2026-11-05', '2026-11-06'])
  })
})
