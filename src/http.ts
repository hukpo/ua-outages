import { OutageError } from './errors.js'
import { BodyTooLarge, httpsFetchWithCa } from './https-fetch.js'
import type { RegionId } from './types.js'
import { abortable } from './util.js'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface HttpOptions {
  fetch?: FetchLike
  /** Per request, default 15 s */
  timeoutMs?: number
  userAgent?: string
  /** Extra attempts after a network error or 5xx, default 1 */
  retries?: number
  /**
   * The largest response body read, in bytes; default 64 MB. A larger one is not buffered: the
   * request ends with `OutageError('too-large')`.
   */
  maxBodyBytes?: number
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
  /** For a large file: replaces the client's per-request timeout for this request */
  timeoutMs?: number
}

/** The largest files read are address lists of a few MB */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024

const DEFAULT_UA = 'ua-outages (+https://github.com/hukpo/ua-outages)'

/** Markers of bot-protection pages served instead of the real content. */
const BLOCK_MARKERS = [
  '_Incapsula_Resource',
  'Incapsula incident',
  'cf-browser-verification',
  'cf_chl_',
  'Attention Required!',
]

/** A bot-protection page rather than the operator's content. Challenge pages are small; real pages may embed the same scripts, so size matters. */
const isChallenge = (body: string) => body.length < 20_000 && BLOCK_MARKERS.some((m) => body.includes(m))

export class Http {
  private readonly fetchImpl: FetchLike
  private readonly customFetch: boolean
  private readonly caFetch = new Map<string, FetchLike>()
  private readonly timeoutMs: number
  private readonly userAgent: string
  private readonly retries: number
  private readonly maxBodyBytes: number
  /** Set on copies made by `withSignal`: every request through them stops when it aborts */
  private signal?: AbortSignal

  constructor(opts: HttpOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.customFetch = !!opts.fetch
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.userAgent = opts.userAgent ?? DEFAULT_UA
    this.retries = opts.retries ?? 1
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  }

  /**
   * The same client (settings, connections) whose requests all stop when `signal` aborts:
   * none starts after that, and the one in flight is cancelled. `undefined` gives an unbound copy.
   */
  withSignal(signal: AbortSignal | undefined): Http {
    const copy = Object.create(Http.prototype) as Http
    Object.assign(copy, this)
    copy.signal = signal
    return copy
  }

  async text(url: string, opts: RequestOptions = {}): Promise<string> {
    return (await this.raw(url, opts)).body
  }

  /** Body plus response headers (for cookies). */
  async raw(
    url: string,
    opts: RequestOptions = {},
  ): Promise<{ body: string; headers: Headers; status: number }> {
    const { res, deadline } = await this.request(url, opts)
    // UTF-8 unless told otherwise, as `Response.text()` reads it
    const body = new TextDecoder(opts.encoding ?? 'utf-8').decode(await this.body(res, deadline, url, opts))
    if (isChallenge(body))
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
    const { res, deadline } = await this.request(url, opts)
    return { bytes: await this.body(res, deadline, url, opts), headers: res.headers }
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

  /**
   * Reads a response body, up to `maxBodyBytes`. The per-request timeout (`deadline`, the same
   * one the request started under) and a dropped connection can still strike after the headers
   * arrived: that is a `network` error like any other, not a bare `TimeoutError`. A cancelled
   * call rejects with the signal's reason, as everywhere.
   */
  private async body(
    res: Response,
    deadline: AbortSignal,
    url: string,
    opts: RequestOptions,
  ): Promise<Uint8Array> {
    const signal = this.signal
    try {
      return await readCapped(res, this.maxBodyBytes, deadline)
    } catch (cause) {
      if (signal?.aborted) throw signal.reason
      if (cause instanceof BodyTooLarge) throw this.tooLarge(url, opts, res.status)
      const timedOut = (cause as Error)?.name === 'TimeoutError'
      throw new OutageError(
        'network',
        timedOut
          ? `${host(url)} did not finish answering in ${opts.timeoutMs ?? this.timeoutMs} ms`
          : `${host(url)} dropped the connection`,
        { region: opts.region, url, cause },
      )
    }
  }

  private tooLarge(url: string, opts: RequestOptions, status?: number): OutageError {
    return new OutageError('too-large', `${host(url)} sent more than ${this.maxBodyBytes} bytes`, {
      region: opts.region,
      url,
      ...(status === undefined ? {} : { status }),
    })
  }

  private fetchWithCa(ca: string[]): FetchLike {
    const key = ca.join('')
    let f = this.caFetch.get(key)
    if (!f) this.caFetch.set(key, (f = httpsFetchWithCa(ca, this.maxBodyBytes)))
    return f
  }

  private async request(
    url: string,
    opts: RequestOptions,
  ): Promise<{ res: Response; deadline: AbortSignal }> {
    const signal = this.signal
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
      // a cancelled call sends nothing more, retries included
      signal?.throwIfAborted()
      const timeoutMs = opts.timeoutMs ?? this.timeoutMs
      const timeout = AbortSignal.timeout(timeoutMs)
      // the timeout and the caller's signal end the wait themselves: a custom `fetch` that
      // ignores `init.signal` must not be able to hold the call past either
      const deadline = signal ? withTimeout(signal, timeout) : timeout
      let res: Response
      try {
        res = await abortable(
          fetchImpl(url, {
            method: opts.method ?? (body ? 'POST' : 'GET'),
            headers,
            body,
            signal: deadline,
            redirect: 'follow',
          }),
          deadline,
        )
      } catch (cause) {
        if (signal?.aborted) throw signal.reason
        // asking again would only download it again
        if (cause instanceof BodyTooLarge) throw this.tooLarge(url, opts)
        if (attempt < this.retries) continue
        const timedOut = (cause as Error)?.name === 'TimeoutError'
        throw new OutageError(
          'network',
          timedOut ? `${host(url)} did not answer in ${timeoutMs} ms` : `Cannot reach ${host(url)}`,
          { region: opts.region, url, cause },
        )
      }
      if (res.ok || opts.acceptStatus?.includes(res.status)) return { res, deadline }
      // a bot check often comes as a 503: look before retrying, and never ask it twice
      const errorBody = await readCapped(res, this.maxBodyBytes, deadline).then(
        (bytes) => new TextDecoder().decode(bytes),
        () => {
          if (signal?.aborted) throw signal.reason
          return ''
        },
      )
      if (isChallenge(errorBody))
        throw new OutageError('blocked', `Bot protection answered instead of ${host(url)}`, {
          region: opts.region,
          url,
          status: res.status,
        })
      if (res.status >= 500 && attempt < this.retries) continue
      throw new OutageError(
        res.status === 403 || res.status === 429 ? 'blocked' : 'http',
        `${host(url)} answered ${res.status}`,
        { region: opts.region, url, status: res.status },
      )
    }
  }
}

/**
 * Aborts on the caller's signal or the per-request timeout: `AbortSignal.any`, which Node 20 has
 * only from 20.3. The fallback's listeners go away when either fires, and the timeout always
 * fires, so a caller's signal shared by many requests doesn't collect them.
 */
function withTimeout(caller: AbortSignal, timeout: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, caller])
  const ctrl = new AbortController()
  if (caller.aborted) ctrl.abort(caller.reason)
  else if (timeout.aborted) ctrl.abort(timeout.reason)
  else {
    const onCaller = () => ctrl.abort(caller.reason)
    const onTimeout = () => ctrl.abort(timeout.reason)
    const cleanup = () => {
      caller.removeEventListener('abort', onCaller)
      timeout.removeEventListener('abort', onTimeout)
    }
    caller.addEventListener('abort', onCaller, { once: true })
    timeout.addEventListener('abort', onTimeout, { once: true })
    ctrl.signal.addEventListener('abort', cleanup, { once: true })
  }
  return ctrl.signal
}

/**
 * The body as bytes, read chunk by chunk so that one over `limit` is never held: the stream is
 * cancelled and `BodyTooLarge` thrown. Every wait is raced against `deadline`.
 */
async function readCapped(res: Response, limit: number, deadline: AbortSignal): Promise<Uint8Array> {
  // the declared size (compressed, when the body is) is already more than may be read
  if (Number(res.headers.get('content-length')) > limit) {
    void res.body?.cancel().catch(() => {})
    throw new BodyTooLarge(limit)
  }
  if (!res.body) {
    const all = new Uint8Array(await abortable(res.arrayBuffer(), deadline))
    if (all.length > limit) throw new BodyTooLarge(limit)
    return all
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), deadline)
      if (done) break
      total += value.length
      if (total > limit) throw new BodyTooLarge(limit)
      chunks.push(value)
    }
  } catch (e) {
    void reader.cancel().catch(() => {})
    throw e
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function host(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
