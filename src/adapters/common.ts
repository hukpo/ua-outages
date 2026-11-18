import { OutageError } from '../errors.js'

/**
 * A vendor SDK's failure → `OutageError`: no connection is `network`, an HTTP status (rate
 * limits, overload, a bad key) is `http`; a cancelled call is passed through. Duck-typed, so the
 * adapters import nothing from the SDKs at runtime.
 */
export function vendorError(vendor: string, e: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason
  if (e instanceof OutageError) return e
  const err = e as { name?: string; status?: unknown; statusCode?: unknown; message?: string }
  const message = `${vendor}: ${err?.message ?? String(e)}`
  // `status` (OpenAI, Anthropic, TanStack AI), `statusCode` (AI SDK's APICallError)
  const status = typeof err?.status === 'number' ? err.status : err?.statusCode
  if (typeof status === 'number') return new OutageError('http', message, { status, cause: e })
  if (err?.name === 'AbortError' || err?.name === 'APIUserAbortError') return e
  return new OutageError('network', message, { cause: e })
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
