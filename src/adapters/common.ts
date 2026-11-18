import { createHash } from 'node:crypto'
import { OutageError } from '../errors.js'

/**
 * A vendor SDK's failure → `OutageError`: no connection is `network`, an HTTP status (rate
 * limits, overload, a bad key) is `http`; a cancelled call is passed through. Duck-typed, so the
 * adapters import nothing from the SDKs at runtime.
 */
export function vendorError(vendor: string, e: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason
  if (e instanceof OutageError) return e
  const err = e as { name?: string; message?: string }
  const message = `${vendor}: ${err?.message ?? String(e)}`
  const status = statusOf(e)
  if (typeof status === 'number')
    // the API refused this input itself (too large, a picture it can't take): a misread of this
    // post, remembered for a while, not an outage of the API retried every poll
    return new OutageError(INPUT_STATUS.has(status) ? 'parse' : 'http', message, { status, cause: e })
  if (err?.name === 'AbortError' || err?.name === 'APIUserAbortError') return e
  return new OutageError('network', message, { cause: e })
}

/** Statuses about the request's content; 401/403/404/429/5xx are about the API or the account */
const INPUT_STATUS = new Set([400, 413, 415, 422])

/**
 * The HTTP status of a vendor error, wherever its SDK put it: `status` (OpenAI, Anthropic),
 * `statusCode` (AI SDK's APICallError), the last attempt of AI SDK's RetryError (`lastError`),
 * the provider error TanStack AI wraps (`cause`)
 */
function statusOf(e: unknown, depth = 0): number | undefined {
  if (!e || typeof e !== 'object' || depth > 3) return undefined
  const err = e as { status?: unknown; statusCode?: unknown; lastError?: unknown; cause?: unknown }
  if (typeof err.status === 'number') return err.status
  if (typeof err.statusCode === 'number') return err.statusCode
  return statusOf(err.lastError, depth + 1) ?? statusOf(err.cause, depth + 1)
}

/** The model's JSON text → a value; anything that isn't JSON is a `parse` error */
export function parseJson(vendor: string, text: string | null | undefined, url: string): unknown {
  if (!text) throw new OutageError('parse', `${vendor}: empty answer for ${url}`, { url })
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new OutageError('parse', `${vendor}: the answer for ${url} is not JSON`, { url, cause })
  }
}

export const base64 = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')

/**
 * Settings that change a model's answers, as a short part of the processor id (empty when none
 * is set): two processors that differ only in them must not share cached answers, nor count as
 * two readings of one post
 */
export function optionsTag(settings: Record<string, unknown>): string {
  const set = Object.entries(settings).filter(([, v]) => v !== undefined)
  if (!set.length) return ''
  return (
    ':' +
    createHash('sha256')
      .update(stable(Object.fromEntries(set)))
      .digest('hex')
      .slice(0, 10)
  )
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'undefined'
}
