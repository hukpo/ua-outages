import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FetchLike } from '../src/http.js'

export const fixture = (path: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url)), 'utf8')

export interface Route {
  /** Matched against the full URL (string = substring) */
  match: string | RegExp
  method?: 'GET' | 'POST'
  body: string | (() => string)
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
    return new Response(body, { status: r.status ?? 200, headers: r.headers })
  }
  return { fetch, calls }
}
