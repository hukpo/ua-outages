import { describe, expect, it } from 'vitest'
import { OutageClient } from '../src/client.js'
import { OutageError } from '../src/errors.js'
import { Http } from '../src/http.js'
import type { ProviderContext } from '../src/providers/provider.js'
import { mergeSources, type SourceRead, type SourceSpec } from '../src/providers/sources.js'
import { makeDay } from '../src/schedule.js'
import type { DaySchedule } from '../src/types.js'

const NOW = new Date('2026-11-05T10:00:00+02:00')
const ctx = (signal?: AbortSignal): ProviderContext => ({ http: new Http(), now: () => NOW, signal })

const off = (date: string, start: number, end: number) => makeDay(date, [{ start, end, kind: 'off' }])
const unknown = (date: string): DaySchedule => ({ date, status: 'unknown', intervals: [] })
const day = (publishedAt: string | null, schedules: Record<string, DaySchedule>) => ({
  schedules,
  publishedAt,
})
const spec = (id: string, read: SourceRead | (() => Promise<SourceRead>)): SourceSpec => ({
  id,
  url: `https://example.com/${id}`,
  read: typeof read === 'function' ? read : async () => read,
})
const hhmm = (d: DaySchedule) => d.intervals.map((i) => `${i.from.slice(11, 16)}-${i.to.slice(11, 16)}`)

describe('mergeSources', () => {
  it('takes each day from the source that published it last', async () => {
    const s = await mergeSources(ctx(), 'chernihiv', [
      spec('site', {
        days: {
          '2026-11-05': day('2026-11-05T07:00:00+02:00', {
            '1': off('2026-11-05', 0, 120),
            '2': off('2026-11-05', 120, 240),
          }),
          '2026-11-06': day('2026-11-05T09:00:00+02:00', { '1': off('2026-11-06', 600, 720) }),
        },
      }),
      spec('telegram:@x', {
        days: {
          '2026-11-05': day('2026-11-05T08:30:00+02:00', {
            '1': off('2026-11-05', 60, 180),
            '2': off('2026-11-05', 120, 240),
          }),
          '2026-11-06': day('2026-11-04T20:00:00+02:00', { '1': off('2026-11-06', 600, 720) }),
        },
        url: 'https://t.me/x/12',
      }),
    ])
    expect(s.region).toBe('chernihiv')
    expect(s.groups).toEqual(['1', '2'])
    expect(s.schedules['1']!.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-06'])
    expect(hhmm(s.schedules['1']![0]!)).toEqual(['01:00-03:00'])
    // the newest publication among the winning days, in Kyiv time
    expect(s.updatedAt).toBe('2026-11-05T09:00:00+02:00')
    expect(s.fetchedAt).toBe('2026-11-05T10:00:00+02:00')
    expect(s.sources).toEqual([
      // the site lost the 5th with different times for group 1
      {
        id: 'site',
        url: 'https://example.com/site',
        ok: true,
        dates: ['2026-11-06'],
        updatedAt: '2026-11-05T09:00:00+02:00',
        disagrees: true,
      },
      // …and agrees on the 6th, which it lost too
      {
        id: 'telegram:@x',
        url: 'https://t.me/x/12',
        ok: true,
        dates: ['2026-11-05'],
        updatedAt: '2026-11-05T08:30:00+02:00',
      },
    ])
  })

  it('gives ties and missing timestamps to the earlier spec, and a timestamp beats none', async () => {
    const d = '2026-11-05'
    const at = '2026-11-05T07:00:00+02:00'
    const tie = await mergeSources(ctx(), 'kyiv', [
      spec('a', { days: { [d]: day(at, { '1': off(d, 0, 60) }) } }),
      spec('b', { days: { [d]: day('2026-11-05T05:00:00Z', { '1': off(d, 60, 120) }) } }),
    ])
    expect(tie.sources!.map((s) => s.dates)).toEqual([[d], []])
    expect(tie.sources![1]).toMatchObject({ disagrees: true, updatedAt: '2026-11-05T05:00:00Z' })

    const none = await mergeSources(ctx(), 'kyiv', [
      spec('a', { days: { [d]: day(null, { '1': off(d, 0, 60) }) } }),
      spec('b', { days: { [d]: day(null, { '1': off(d, 60, 120) }) } }),
    ])
    expect(none.sources!.map((s) => s.dates)).toEqual([[d], []])
    expect(none.updatedAt).toBeNull()

    const stamped = await mergeSources(ctx(), 'kyiv', [
      spec('a', { days: { [d]: day(null, { '1': off(d, 0, 60) }) } }),
      spec('b', { days: { [d]: day(at, { '1': off(d, 60, 120) }) } }),
    ])
    expect(stamped.sources!.map((s) => s.dates)).toEqual([[], [d]])
    expect(stamped.updatedAt).toBe(at)
  })

  it('never lets a source that says nothing about a day hide one that has it', async () => {
    const s = await mergeSources(ctx(), 'kyiv', [
      // newer, but all unknown for tomorrow
      spec('site', {
        days: {
          '2026-11-05': day('2026-11-05T09:00:00+02:00', { '1': off('2026-11-05', 0, 60) }),
          '2026-11-06': day('2026-11-05T09:00:00+02:00', { '1': unknown('2026-11-06') }),
        },
      }),
      spec('telegram', {
        days: { '2026-11-06': day('2026-11-05T08:00:00+02:00', { '1': off('2026-11-06', 0, 60) }) },
      }),
    ])
    expect(s.schedules['1']!.map((d) => d.status)).toEqual(['scheduled', 'scheduled'])
    expect(s.sources!.map((x) => x.dates)).toEqual([['2026-11-05'], ['2026-11-06']])
    // an unknown day isn't a different opinion
    expect(s.sources!.some((x) => x.disagrees)).toBe(false)
  })

  it('fills groups the winner lacks with unknown days and sorts groups', async () => {
    const d = '2026-11-05'
    const s = await mergeSources(
      ctx(),
      'kyiv',
      [
        spec('a', {
          days: { [d]: day('2026-11-05T09:00:00+02:00', { '10.1': off(d, 0, 60), '2.1': makeDay(d, []) }) },
        }),
        spec('b', { days: { [d]: day(null, { '1.1': off(d, 0, 60) }) }, groups: ['3.1'] }),
      ],
      { groups: ['4.2'] },
    )
    expect(s.groups).toEqual(['1.1', '2.1', '3.1', '4.2', '10.1'])
    expect(s.schedules['1.1']).toEqual([unknown(d)])
    expect(s.schedules['4.2']).toEqual([unknown(d)])
    expect(s.schedules['2.1']![0]!.status).toBe('scheduled')
    // b published only a group a doesn't have: nothing to disagree about
    expect(s.sources![1]!.disagrees).toBeUndefined()
  })

  it('treats emergency against a schedule as a disagreement, and no-outages against an empty schedule as none', async () => {
    const d = '2026-11-05'
    const at = '2026-11-05T09:00:00+02:00'
    const s = await mergeSources(ctx(), 'kyiv', [
      spec('a', { days: { [d]: day(at, { '1': makeDay(d, []), '2': makeDay(d, []) }) } }),
      spec('b', { days: { [d]: day(null, { '1': { date: d, status: 'no-outages', intervals: [] } }) } }),
      spec('c', { days: { [d]: day(null, { '2': { date: d, status: 'emergency', intervals: [] } }) } }),
    ])
    expect(s.sources!.map((x) => !!x.disagrees)).toEqual([false, false, true])
  })

  it('keeps going when a source fails, and lists the failure', async () => {
    const d = '2026-11-05'
    const s = await mergeSources(ctx(), 'kyiv', [
      spec('site', async () => {
        throw new OutageError('blocked', 'bot check')
      }),
      spec('telegram', { days: { [d]: day('2026-11-05T08:00:00+02:00', { '1': off(d, 0, 60) }) } }),
      // a reader that throws before its first await, and not an OutageError
      {
        id: 'api',
        url: null,
        read: () => {
          throw new TypeError('x is undefined')
        },
      },
    ])
    expect(s.schedules['1']).toHaveLength(1)
    expect(s.sources).toEqual([
      {
        id: 'site',
        url: 'https://example.com/site',
        ok: false,
        dates: [],
        updatedAt: null,
        error: { code: 'blocked', message: 'bot check' },
      },
      {
        id: 'telegram',
        url: 'https://example.com/telegram',
        ok: true,
        dates: [d],
        updatedAt: '2026-11-05T08:00:00+02:00',
      },
      {
        id: 'api',
        url: null,
        ok: false,
        dates: [],
        updatedAt: null,
        error: { code: 'parse', message: 'x is undefined' },
      },
    ])
  })

  it("throws the primary source's error when every source fails", async () => {
    const primary = new OutageError('network', 'site down')
    await expect(
      mergeSources(ctx(), 'kyiv', [
        spec('site', async () => {
          throw primary
        }),
        spec('telegram', async () => {
          throw new OutageError('parse', 'no posts')
        }),
      ]),
    ).rejects.toBe(primary)
  })

  it("rejects with the signal's reason when the call was cancelled, even if a source answered", async () => {
    const ctrl = new AbortController()
    const d = '2026-11-05'
    const pending = mergeSources(ctx(ctrl.signal), 'kyiv', [
      spec(
        'site',
        () =>
          new Promise((_, reject) =>
            ctrl.signal.addEventListener('abort', () => reject(new OutageError('network', 'aborted'))),
          ),
      ),
      spec('telegram', { days: { [d]: day(null, { '1': off(d, 0, 60) }) } }),
    ])
    ctrl.abort(new Error('caller cap'))
    await expect(pending).rejects.toThrow('caller cap')
  })

  it('lists the groups as unknown for today when the sources answer and publish nothing', async () => {
    const s = await mergeSources(ctx(), 'kyiv', [
      spec('a', { days: {}, groups: ['1.2', '1.1'] }),
      spec('b', { days: {} }),
    ])
    expect(s.schedules).toEqual({ '1.1': [unknown('2026-11-05')], '1.2': [unknown('2026-11-05')] })
    expect(s.updatedAt).toBeNull()
    expect(s.sources!.map((x) => [x.ok, x.dates])).toEqual([
      [true, []],
      [true, []],
    ])
    // a date every source leaves unknown stays in the result, credited to nobody
    const t = await mergeSources(ctx(), 'kyiv', [
      spec('a', { days: { '2026-11-06': day('2026-11-05T09:00:00+02:00', { '1': unknown('2026-11-06') }) } }),
    ])
    expect(t.schedules).toEqual({ '1': [unknown('2026-11-06')] })
    expect(t.sources![0]).toMatchObject({ dates: [], updatedAt: null })
    expect(t.updatedAt).toBeNull()
  })

  it('reads the sources concurrently', async () => {
    let running = 0
    let peak = 0
    const slow = async (): Promise<SourceRead> => {
      peak = Math.max(peak, ++running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return { days: {} }
    }
    await mergeSources(ctx(), 'kyiv', [spec('a', slow), spec('b', slow), spec('c', slow)])
    expect(peak).toBe(3)
  })

  it('gives a result the client accepts and passes on to getSchedule', async () => {
    const d = '2026-11-05'
    const client = new OutageClient({
      now: () => NOW,
      providers: [
        {
          info: {
            id: 'kyiv',
            name: 'Київ',
            operator: 'Test',
            website: 'https://example.com',
            capabilities: { schedule: true, addressSearch: false },
          },
          getSchedules: (c) =>
            mergeSources(c, 'kyiv', [
              spec('site', async () => {
                throw new OutageError('http', '503')
              }),
              spec('telegram', {
                days: { [d]: day('2026-11-05T08:00:00+02:00', { '1.1': off(d, 1380, 1440) }) },
              }),
            ]),
        },
      ],
    })
    const g = await client.getSchedule('kyiv', '1.1')
    expect(hhmm(g.days[0]!)).toEqual(['23:00-00:00'])
    expect(g.sources!.map((s) => s.ok)).toEqual([false, true])
    expect(g.stale).toBeUndefined()
  })

  it('counts a cancelled day as a publication: the newer of a schedule and a cancellation stands', async () => {
    const d = '2026-11-05'
    const schedule = day('2026-11-04T20:00:00+02:00', { '1.1': off(d, 480, 720) })
    const cancelled = (at: string) => ({ ...day(at, { '1.1': unknown(d) }), cancelled: true })
    // the channel called the day off at 08:00; the site still shows the evening's schedule
    const s = await mergeSources(ctx(), 'kyiv', [
      spec('site', { days: { [d]: schedule } }),
      spec('telegram', { days: { [d]: cancelled('2026-11-05T08:00:00+02:00') } }),
    ])
    expect(s.schedules['1.1']).toEqual([unknown(d)])
    expect(s.updatedAt).toBe('2026-11-05T08:00:00+02:00')
    expect(s.sources![1]).toMatchObject({ dates: [d], updatedAt: '2026-11-05T08:00:00+02:00' })
    expect(s.sources![0]).toMatchObject({ dates: [], disagrees: true })
    // a schedule published after the cancellation stands again
    const back = await mergeSources(ctx(), 'kyiv', [
      spec('site', { days: { [d]: day('2026-11-05T09:00:00+02:00', { '1.1': off(d, 840, 960) }) } }),
      spec('telegram', { days: { [d]: cancelled('2026-11-05T08:00:00+02:00') } }),
    ])
    expect(hhmm(back.schedules['1.1']![0]!)).toEqual(['14:00-16:00'])
    expect(back.sources![1]).toMatchObject({ dates: [], disagrees: true })
    // both cancelled: no disagreement; days that are just unknown still count for nothing
    const both = await mergeSources(ctx(), 'kyiv', [
      spec('site', { days: { [d]: cancelled('2026-11-05T08:05:00+02:00') } }),
      spec('telegram', { days: { [d]: cancelled('2026-11-05T08:00:00+02:00') } }),
      spec('news', { days: { [d]: day('2026-11-05T09:00:00+02:00', { '1.1': unknown(d) }) } }),
    ])
    expect(both.schedules['1.1']).toEqual([unknown(d)])
    expect(both.sources!.map((x) => [x.dates.length, x.disagrees])).toEqual([
      [1, undefined],
      [0, undefined],
      [0, undefined],
    ])
  })
})
