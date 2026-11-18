import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { FetchLike } from '../src/http.js'
import type { RegionSchedule } from '../src/types.js'

export const fixture = (path: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url)), 'utf8')

export const fixtureBytes = (path: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url))))

export interface Route {
  /** Matched against the full URL (string = substring) */
  match: string | RegExp
  method?: 'GET' | 'POST'
  body: string | Uint8Array | (() => string)
  status?: number
  headers?: Record<string, string>
}

/** A fetch that serves fixtures and records calls; unknown URLs fail the test loudly. */
export function mockFetch(routes: Route[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const method = (init?.method ?? 'GET').toUpperCase()
    const r = routes.find(
      (r) =>
        (r.method ?? method) === method &&
        (typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url)),
    )
    if (!r) throw new Error(`mockFetch: no route for ${method} ${url}`)
    const body = typeof r.body === 'function' ? r.body() : r.body
    return new Response(body as BodyInit, { status: r.status ?? 200, headers: r.headers })
  }
  return { fetch, calls }
}

/**
 * "Nothing published": the region's groups stay listed and every day is `unknown`, so it can't
 * be mistaken for "no outages" (`groups: []` or `no-outages` days).
 */
export function expectUnpublished(s: RegionSchedule, groups: number) {
  expect(s.groups).toHaveLength(groups)
  expect(Object.keys(s.schedules).sort()).toEqual([...s.groups].sort())
  for (const g of s.groups) {
    expect(s.schedules[g]!.length).toBeGreaterThan(0)
    for (const d of s.schedules[g]!) expect(d).toMatchObject({ status: 'unknown', intervals: [] })
  }
}

// --- AI processors for tests ---

import type {
  ClockInterval,
  ImageInput,
  ImageProcessor,
  ImageReading,
  PostAnalysis,
  PostEvent,
  PostInput,
  TextProcessor,
} from '../src/ai/types.js'
import { STANDARD_GROUPS } from '../src/schedule.js'

/**
 * A text processor that answers with `answer(input)` (the analysis a model would give) and
 * records its calls. Return `undefined` for "nothing in this post" (`events: []`).
 */
export function fakeText(
  answer: (
    input: PostInput,
  ) =>
    | Partial<PostAnalysis>
    | PostEvent[]
    | undefined
    | Promise<Partial<PostAnalysis> | PostEvent[] | undefined>,
  id = 'fake-text',
): TextProcessor & { calls: PostInput[] } {
  const calls: PostInput[] = []
  return {
    id,
    calls,
    async analyzePost(input) {
      calls.push(input)
      const a = await answer(input)
      const value = Array.isArray(a) ? { events: a } : (a ?? {})
      return {
        value: { events: [], photosAreSchedules: false, statedAt: null, ...value },
        usage: { inputTokens: 100, outputTokens: 20 },
      }
    },
  }
}

/** An image processor that answers with `answer(input)`; `undefined` = not a schedule */
export function fakeImage(
  answer: (input: ImageInput) => Partial<ImageReading> | undefined,
  opts: { check?: (input: ImageInput) => boolean; maxLongEdge?: number } = {},
): ImageProcessor & { calls: ImageInput[]; checks: ImageInput[] } {
  const calls: ImageInput[] = []
  const checks: ImageInput[] = []
  return {
    id: 'fake-image',
    calls,
    checks,
    maxLongEdge: opts.maxLongEdge,
    async readImage(input) {
      calls.push(input)
      const r = answer(input)
      return {
        value: r
          ? { isSchedule: true, kind: 'gpv', date: null, statedAt: null, schedule: [], ...r }
          : { isSchedule: false, kind: null, date: null, statedAt: null, schedule: [] },
      }
    },
    ...(opts.check
      ? {
          async isSchedule(input: ImageInput) {
            checks.push(input)
            return { value: { isSchedule: opts.check!(input) } }
          },
        }
      : {}),
  }
}

/** One event with every field at its default */
export function ev(e: Partial<PostEvent> & Pick<PostEvent, 'kind' | 'action' | 'regions'>): PostEvent {
  return {
    area: null,
    date: null,
    at: null,
    until: null,
    allQueues: false,
    queues: [],
    queuesRestored: [],
    queueCount: null,
    additive: false,
    again: false,
    gpvApplies: null,
    addedInEdit: false,
    untilFurtherNotice: false,
    schedule: [],
    ...e,
  }
}

/** "1.1: 08:00-12:00" → per queue the intervals; a queue left out of `hours` gets none */
export function gpvSchedule(
  hours: Record<string, string | null>,
  queues: readonly string[] = STANDARD_GROUPS,
): PostEvent['schedule'] {
  return queues.map((queue) => ({
    queue,
    intervals: hours[queue] === null ? null : intervalsOf(hours[queue] ?? ''),
  }))
}

/** "08:00-12:00, 18:00-20:00?" → intervals ("?" = maybe) */
export function intervalsOf(s: string): ClockInterval[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const maybe = x.endsWith('?')
      const [from, to] = x.replace('?', '').split('-') as [string, string]
      return { from, to, kind: maybe ? ('maybe' as const) : ('off' as const) }
    })
}

/** `gpvSchedule` for a picture: every queue with its hours, none without */
export const pictureSchedule = (hours: Record<string, string>, queues: readonly string[] = STANDARD_GROUPS) =>
  gpvSchedule(hours, queues).map((q) => ({ queue: q.queue, intervals: q.intervals ?? [] }))
