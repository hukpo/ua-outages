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
    // a shared channel's post about none of its regions: dropped, not an error
    expect(check([ev({ kind: 'emergency', action: 'start', regions: [] })], dtek).events).toEqual([])
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
