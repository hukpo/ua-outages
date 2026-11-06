import { OutageError } from './errors.js'
import { httpsFetchWithCa } from './https-fetch.js'
import type { RegionId } from './types.js'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface HttpOptions {
  fetch?: FetchLike
  /** Per request, default 15 s */
  timeoutMs?: number
  userAgent?: string
  /** Extra attempts after a network error or 5xx, default 1 */
  retries?: number
}

export interface RequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Sent as JSON when an object, as-is when a string or URLSearchParams */
  body?: unknown
  region?: RegionId
  /** Response charset when the server doesn't send UTF-8, e.g. "windows-1251" */
  encoding?: string
  /** Non-2xx statuses that are answers, not errors (e.g. 404 = "address not found") */
  acceptStatus?: number[]
  /**
   * Intermediate certificates (PEM) for a server that doesn't send its full chain. Applied to
   * the built-in fetch only; a custom `fetch` handles TLS itself.
   */
  ca?: string[]
}

const DEFAULT_UA = 'ua-outages (+https://github.com/hukpo/ua-outages)'

/** Markers of bot-protection pages served instead of the real content. */
const BLOCK_MARKERS = [
  '_Incapsula_Resource',
  'Incapsula incident',
  'cf-browser-verification',
  'cf_chl_',
  'Attention Required!',
]

export class Http {
  private readonly fetchImpl: FetchLike
  private readonly customFetch: boolean
  private readonly caFetch = new Map<string, FetchLike>()
  private readonly timeoutMs: number
  private readonly userAgent: string
  private readonly retries: number

  constructor(opts: HttpOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.customFetch = !!opts.fetch
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.userAgent = opts.userAgent ?? DEFAULT_UA
    this.retries = opts.retries ?? 1
  }

  async text(url: string, opts: RequestOptions = {}): Promise<string> {
    return (await this.raw(url, opts)).body
  }

  /** Body plus response headers (for cookies). */
  async raw(
    url: string,
    opts: RequestOptions = {},
  ): Promise<{ body: string; headers: Headers; status: number }> {
    const res = await this.request(url, opts)
    const body = opts.encoding
      ? new TextDecoder(opts.encoding).decode(await res.arrayBuffer())
      : await res.text()
    // challenge pages are small; real pages may embed the same scripts, so size matters
    if (body.length < 20_000 && BLOCK_MARKERS.some((m) => body.includes(m)))
      throw new OutageError('blocked', `Bot protection answered instead of ${host(url)}`, {
        region: opts.region,
        url,
        status: res.status,
      })
    return { body, headers: res.headers, status: res.status }
  }

  /** Raw bytes (images); no bot-check sniffing. */
  async bytes(url: string, opts: RequestOptions = {}): Promise<Uint8Array> {
    return (await this.file(url, opts)).bytes
  }

  /** Binary body with the response headers (e.g. Last-Modified of an image) */
  async file(url: string, opts: RequestOptions = {}): Promise<{ bytes: Uint8Array; headers: Headers }> {
    const res = await this.request(url, opts)
    return { bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers }
  }

  async json<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
    const body = await this.text(url, opts)
    try {
      return JSON.parse(body) as T
    } catch (cause) {
      throw new OutageError('parse', `${host(url)} returned invalid JSON`, {
        region: opts.region,
        url,
        cause,
      })
    }
  }

  private fetchWithCa(ca: string[]): FetchLike {
    const key = ca.join('')
    let f = this.caFetch.get(key)
    if (!f) this.caFetch.set(key, (f = httpsFetchWithCa(ca)))
    return f
  }

  private async request(url: string, opts: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
      'Accept-Language': 'uk-UA,uk;q=0.9',
      ...opts.headers,
    }
    let body: BodyInit | undefined
    if (typeof opts.body === 'string' || opts.body instanceof URLSearchParams) body = opts.body
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body)
      headers['Content-Type'] ??= 'application/json'
    }

    const fetchImpl = opts.ca && !this.customFetch ? this.fetchWithCa(opts.ca) : this.fetchImpl
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await fetchImpl(url, {
          method: opts.method ?? (body ? 'POST' : 'GET'),
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'follow',
        })
      } catch (cause) {
        if (attempt < this.retries) continue
        const timedOut = (cause as Error)?.name === 'TimeoutError'
        throw new OutageError(
          'network',
          timedOut ? `${host(url)} did not answer in ${this.timeoutMs} ms` : `Cannot reach ${host(url)}`,
          { region: opts.region, url, cause },
        )
      }
      if (res.ok || opts.acceptStatus?.includes(res.status)) return res
      if (res.status >= 500 && attempt < this.retries) continue
      throw new OutageError(
        res.status === 403 || res.status === 429 ? 'blocked' : 'http',
        `${host(url)} answered ${res.status}`,
        { region: opts.region, url, status: res.status },
      )
    }
  }
}

function host(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
