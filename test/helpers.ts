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
