import { describe, expect, it } from 'vitest'
import { postRegion } from '../../src/ai/regions.js'
import type { ImageInput, PostInput } from '../../src/ai/types.js'
import { validateImageReading, validatePostAnalysis } from '../../src/ai/validate.js'
import { STANDARD_GROUPS } from '../../src/schedule.js'
import { ev, gpvSchedule } from '../helpers.js'

const post = (over: Partial<PostInput> = {}): PostInput => ({
  url: 'https://t.me/SvitloKropyvnytskyiMisto/1834',
  source: { kind: 'telegram', channel: 'SvitloKropyvnytskyiMisto' },
  publishedAt: '2026-11-17T14:25:14+02:00',
  edited: false,
  title: null,
  text: 'В 14:05 відміна дії графіку ГАВ',
  replyTo: null,
  photoCount: 0,
  regions: [postRegion('kirovohrad')],
  ...over,
})

const answer = (events: unknown[], extra: object = {}) => ({
  events,
  photosAreSchedules: false,
  statedAt: null,
  ...extra,
})
const check = (events: unknown[], input = post()) => validatePostAnalysis(answer(events), input)

describe('validatePostAnalysis', () => {
  it('passes a good answer through, normalized, without "other" events', () => {
    const a = check([
      ev({ kind: 'gav', action: 'cancel', regions: ['kirovohrad'], at: '14:05' }),
      { kind: 'other', action: null },
    ])
    expect(a.events).toEqual([ev({ kind: 'gav', action: 'cancel', regions: ['kirovohrad'], at: '14:05' })])
  })

  it.each([
    ['a time that does not exist', { at: '25:05' }],
    ['24:00 as a start time', { at: '24:00' }],
    ['a time that is not HH:MM', { at: '2 pm' }],
    ['a date that does not exist', { date: '2026-02-30' }],
    ['a date far from the post', { date: '2026-12-01' }],
    ['a region the source does not cover', { regions: ['kyiv'] }],
    ['a queue the operator does not have', { queues: ['11'] }],
    ['a queue count out of range', { queueCount: 0 }],
    ['an action an emergency event must have', { action: null }],
    ['a boolean that is not one', { allQueues: 'yes' }],
  ])('rejects %s as a parse error', (_, over) => {
    expect(() =>
      check([{ ...ev({ kind: 'gav', action: 'cancel', regions: ['kirovohrad'] }), ...over }]),
    ).toThrow(
      expect.objectContaining({
        code: 'parse',
        message: expect.stringContaining('AI answer failed validation'),
      }),
    )
  })

  it('takes an empty region list from a one-region channel as that region, and as none on a shared one', () => {
    expect(check([{ ...ev({ kind: 'gav', action: 'start', regions: [] }) }]).events[0]!.regions).toEqual([
      'kirovohrad',
    ])
    const dtek = post({ regions: ['kyiv', 'kyiv-region'].map((r) => postRegion(r as never)) })
    // a shared channel's event naming none of its regions: the prompt asks for no event then, so
    // a missing list is a misread (a dropped cancel would leave an apply running)
    expect(() => check([ev({ kind: 'emergency', action: 'cancel', regions: [] })], dtek)).toThrow(
      expect.objectContaining({ code: 'parse' }),
    )
  })

  it.each([
    ['queues null on a cancel (would end every queue)', { queues: null, queueCount: null, allQueues: false }],
    ['allQueues null', { allQueues: null }],
    ['all queues and only one of them', { allQueues: true, queues: ['3'] }],
    ['all queues and a count of two', { allQueues: true, queueCount: 2 }],
    ['a queue list squeezed into one name ("1,2-4" read as "1")', { queues: ['1,2-4'] }],
    ['a range as one queue', { queues: ['2-4'] }],
  ])('emergency scope: rejects %s', (_, over) => {
    const zp = post({ regions: [postRegion('zaporizhzhia')] })
    expect(() =>
      check([{ ...ev({ kind: 'gav', action: 'cancel', regions: ['zaporizhzhia'] }), ...over }], zp),
    ).toThrow(expect.objectContaining({ code: 'parse' }))
  })

  it("a ГПВ window through midnight is refused (one day's window can't say it)", () => {
    const e = (until: string) =>
      ev({
        kind: 'gpv',
        action: 'change',
        regions: ['kirovohrad'],
        at: '22:00',
        until,
        schedule: [{ queue: '1.1', intervals: [] }],
      })
    expect(() => check([e('06:00')])).toThrow(expect.objectContaining({ code: 'parse' }))
    expect(() => check([e('22:00')])).toThrow(expect.objectContaining({ code: 'parse' }))
    expect(check([e('24:00')]).events[0]!.at).toBe('22:00')
  })

  it('a cancel naming every queue of a fixed set one by one is a cancel of all of them', () => {
    const zp = post({ regions: [postRegion('zaporizhzhia')] })
    const all = Array.from({ length: 10 }, (_, i) => String(i + 1))
    const a = check([ev({ kind: 'gav', action: 'cancel', regions: ['zaporizhzhia'], queues: all })], zp)
    expect(a.events[0]!.allQueues).toBe(true)
    // "черга 3" and "1(Р)" are still one queue each
    const b = check(
      [ev({ kind: 'gav', action: 'start', regions: ['zaporizhzhia'], queues: ['черга 3', '1(Р)'] })],
      zp,
    )
    expect(b.events[0]!.queues).toEqual(['3', '1(Р)'])
  })

  it('normalizes queue names and checks ГПВ hours', () => {
    const a = check([
      ev({
        kind: 'gpv',
        action: 'start',
        regions: ['kirovohrad'],
        date: '2026-11-18',
        schedule: [
          { queue: '1/1', intervals: [{ from: '8:00', to: '12:30', kind: 'off' }] },
          { queue: 'черга 2.2', intervals: [{ from: '22:00', to: '24:00', kind: 'maybe' }] },
          { queue: '3.1', intervals: null },
        ],
      }),
    ])
    expect(a.events[0]!.schedule).toEqual([
      { queue: '1.1', intervals: [{ from: '08:00', to: '12:30', kind: 'off' }] },
      { queue: '2.2', intervals: [{ from: '22:00', to: '24:00', kind: 'maybe' }] },
      { queue: '3.1', intervals: null },
    ])
    const backwards = [{ queue: '1.1', intervals: [{ from: '12:00', to: '08:00', kind: 'off' as const }] }]
    expect(() =>
      check([ev({ kind: 'gpv', action: 'start', regions: ['kirovohrad'], schedule: backwards })]),
    ).toThrow(/doesn't go forward/)
    const twice = [...gpvSchedule({}), { queue: '1.1', intervals: [] }]
    expect(() =>
      check([ev({ kind: 'gpv', action: 'start', regions: ['kirovohrad'], schedule: twice })]),
    ).toThrow(/twice/)
  })

  it("keeps a town's own numbering only as that town's (an event with an area)", () => {
    const town = ev({
      kind: 'gpv',
      action: 'start',
      regions: ['kirovohrad'],
      area: 'м. Павлоград',
      schedule: [{ queue: '1', intervals: [] }],
    })
    expect(check([town]).events[0]!.schedule[0]!.queue).toBe('1')
    expect(() => check([{ ...town, area: null }])).toThrow(/queue "1" doesn't exist/)
  })

  it('counts an edit line only on an edited post', () => {
    const cancel = ev({ kind: 'gav', action: 'cancel', regions: ['kirovohrad'], addedInEdit: true })
    expect(check([cancel]).events[0]!.addedInEdit).toBe(false)
    expect(check([cancel], post({ edited: true })).events[0]!.addedInEdit).toBe(true)
  })
})

describe('validateImageReading', () => {
  const input: ImageInput = {
    url: 'https://t.me/chernigivoblenergo/5704',
    index: 0,
    of: 1,
    bytes: new Uint8Array(),
    mediaType: 'image/png',
    width: 1,
    height: 1,
    caption: null,
    publishedAt: '2026-11-16T21:00:00+02:00',
    region: postRegion('chernihiv'),
  }
  const full = STANDARD_GROUPS.map((queue) => ({
    queue,
    intervals: [{ from: '08:00', to: '12:00', kind: 'off' }],
  }))

  it('reads intervals as the short strings the schema asks for, "?" a possible outage', () => {
    const short = STANDARD_GROUPS.map((queue) => ({ queue, intervals: ['08:00-12:00', '?16:00 – 18:30'] }))
    const r = validateImageReading(
      { isSchedule: true, kind: 'gpv', date: '2026-11-17', statedAt: null, schedule: short },
      input,
    )
    expect(r.schedule[0]!.intervals).toEqual([
      { from: '08:00', to: '12:00', kind: 'off' },
      { from: '16:00', to: '18:30', kind: 'maybe' },
    ])
    const bad = STANDARD_GROUPS.map((queue) => ({ queue, intervals: ['8 to 12'] }))
    expect(() =>
      validateImageReading(
        { isSchedule: true, kind: 'gpv', date: '2026-11-17', statedAt: null, schedule: bad },
        input,
      ),
    ).toThrow(/not HH:MM-HH:MM/)
  })

  it('reads one line per queue, "-" for a queue without outages', () => {
    const lines = STANDARD_GROUPS.map((q, i) => (i ? `${q} -` : `${q} 08:00-12:00 ?16:00-18:30`))
    const r = validateImageReading(
      { isSchedule: true, kind: 'gpv', date: '2026-11-17', statedAt: null, schedule: lines },
      input,
    )
    expect(r.schedule[0]).toEqual({
      queue: '1.1',
      intervals: [
        { from: '08:00', to: '12:00', kind: 'off' },
        { from: '16:00', to: '18:30', kind: 'maybe' },
      ],
    })
    expect(r.schedule[1]).toEqual({ queue: '1.2', intervals: [] })
  })

  it('needs every queue of the region, once', () => {
    const ok = validateImageReading(
      { isSchedule: true, kind: 'gpv', date: '2026-11-17', statedAt: null, schedule: full },
      input,
    )
    expect(ok.schedule).toHaveLength(12)
    expect(() =>
      validateImageReading(
        { isSchedule: true, kind: 'gpv', date: '2026-11-17', statedAt: null, schedule: full.slice(1) },
        input,
      ),
    ).toThrow(/queues 1.1 missing/)
  })

  it('lets one picture of an album give some of the queues', () => {
    const r = validateImageReading(
      { isSchedule: true, kind: 'gpv', date: '2026-11-17', statedAt: null, schedule: full.slice(0, 6) },
      { ...input, of: 2 },
    )
    expect(r.schedule.map((q) => q.queue)).toEqual(STANDARD_GROUPS.slice(0, 6))
  })

  it('reduces a picture that is not a schedule to just that', () => {
    expect(
      validateImageReading({ isSchedule: false, kind: 'gpv', date: 'nonsense', schedule: full }, input),
    ).toEqual({
      isSchedule: false,
      kind: null,
      date: null,
      statedAt: null,
      schedule: [],
    })
  })
})

describe('validatePostAnalysis: a ГПВ list "станом на" starts with its day', () => {
  it('takes no start time equal to the issue time', () => {
    const input = {
      url: 'https://t.me/SvitloKropyvnytskyiMisto/1795',
      source: { kind: 'telegram' as const, channel: 'SvitloKropyvnytskyiMisto' },
      publishedAt: '2026-11-12T21:03:45+02:00',
      edited: false,
      title: null,
      text: 'внесено зміни до графіка … станом на 21:03 12.11.2026: Черга 1.1: 10-12',
      replyTo: null,
      photoCount: 0,
      regions: [postRegion('kirovohrad')],
    }
    const a = validatePostAnalysis(
      {
        statedAt: '21:03',
        photosAreSchedules: false,
        events: [
          {
            kind: 'gpv',
            action: 'start',
            regions: ['kirovohrad'],
            at: '21:03',
            schedule: [{ queue: '1.1', intervals: ['10:00-12:00'] }],
          },
        ],
      },
      input,
    )
    expect(a.events[0]!.at).toBeNull()
  })
})

describe('validate: what an answer must not leave open', () => {
  const post = (regions = [postRegion('zaporizhzhia')]): PostInput => ({
    url: 'https://t.me/Zaporizhzhyaoblenergo_news/1',
    source: { kind: 'telegram', channel: 'Zaporizhzhyaoblenergo_news' },
    publishedAt: '2026-11-18T10:00:00+02:00',
    edited: false,
    title: null,
    text: '…',
    replyTo: null,
    photoCount: 0,
    regions,
  })
  const answer = (events: unknown[]) => ({ events, photosAreSchedules: false, statedAt: null })
  const gpv = (queue: string) => ({
    kind: 'gpv',
    action: 'start',
    regions: ['zaporizhzhia'],
    schedule: [{ queue, intervals: ['14:00-18:00'] }],
  })

  it('a queue name naming two is refused, not read as the first', () => {
    for (const q of ['4.1, 4.2', '4.1 та 4.2', '1.1-1.2', 'черги 2.1 і 2.2'])
      expect(() => validatePostAnalysis(answer([gpv(q)]), post()), q).toThrow(/not one queue/)
    for (const q of ['4.1', '4-1', 'черга 4.1', '4 черга 1 підчерга'])
      expect(validatePostAnalysis(answer([gpv(q)]), post()).events[0]!.schedule[0]!.queue).toBe('4.1')
  })

  it('an emergency event must say how much: a bare {gav, cancel} would end everything', () => {
    expect(() =>
      validatePostAnalysis(answer([{ kind: 'gav', action: 'cancel', regions: ['zaporizhzhia'] }]), post()),
    ).toThrow(/missing/)
  })

  it('a region "" is no region', () => {
    const e = { kind: 'gav', action: 'start', regions: [''], allQueues: true, queues: [], queueCount: null }
    expect(() => validatePostAnalysis(answer([e]), post())).toThrow(/isn't one of/)
  })

  it('more queues than an operator with a fixed set has, or a queue both off and on, is refused', () => {
    const sumy = [postRegion('sumy')]
    const e = (o: object) => ({
      kind: 'gav',
      action: 'start',
      regions: ['sumy'],
      allQueues: false,
      queues: [],
      queueCount: null,
      ...o,
    })
    expect(() => validatePostAnalysis(answer([e({ queueCount: 50 })]), post(sumy))).toThrow(/more than/)
    expect(() =>
      validatePostAnalysis(answer([e({ queues: ['3'], queuesRestored: ['3'] })]), post(sumy)),
    ).toThrow(/both/)
  })

  it('an emergency change stays a change (it replaces the queues off; a start adds to them)', () => {
    const e = {
      kind: 'gav',
      action: 'change',
      regions: ['zaporizhzhia'],
      allQueues: false,
      queues: ['1'],
      queueCount: null,
      again: true,
    }
    expect(validatePostAnalysis(answer([e]), post()).events[0]!.action).toBe('change')
    expect(validatePostAnalysis(answer([{ ...e, again: false }]), post()).events[0]!.action).toBe('change')
  })

  it('an interval object without its kind, or off and maybe over the same minutes, is refused', () => {
    const at = (intervals: unknown[]) => ({ ...gpv('1.1'), schedule: [{ queue: '1.1', intervals }] })
    expect(() => validatePostAnalysis(answer([at([{ from: '08:00', to: '10:00' }])]), post())).toThrow(/kind/)
    expect(() => validatePostAnalysis(answer([at(['08:00-12:00', '?10:00-14:00'])]), post())).toThrow(
      /overlaps/,
    )
  })
})

describe('validateImageReading: a line says hours or "-", not nothing', () => {
  const input: ImageInput = {
    url: 'https://t.me/chernigivoblenergo/1',
    index: 0,
    of: 1,
    bytes: new Uint8Array(),
    mediaType: 'image/png',
    width: 1,
    height: 1,
    caption: null,
    publishedAt: '2026-11-16T21:00:00+02:00',
    region: postRegion('chernihiv'),
  }
  const reading = (first: string) => ({
    isSchedule: true,
    kind: 'gpv',
    date: '2026-11-17',
    statedAt: null,
    schedule: STANDARD_GROUPS.map((q, i) => (i ? `${q} -` : first)),
  })
  it('refuses a bare queue, hours with "-", and a head naming two queues', () => {
    expect(() => validateImageReading(reading('1.1'), input)).toThrow(/neither/)
    expect(() => validateImageReading(reading('1.1 08:00-12:00 -'), input)).toThrow(/hours and/)
    expect(() => validateImageReading(reading('1.1/1.2 08:00-12:00'), input)).toThrow()
  })
})
