import { request } from 'node:https'
import { rootCertificates } from 'node:tls'
import type { FetchLike } from './http.js'

/** A response body larger than the limit it was read under */
export class BodyTooLarge extends Error {
  override readonly name = 'BodyTooLarge'
  constructor(readonly limit: number) {
    super(`response body over ${limit} bytes`)
  }
}

const hasHeader = (headers: Record<string, string>, name: string) =>
  Object.keys(headers).some((k) => k.toLowerCase() === name)

/**
 * A minimal fetch over node:https that trusts Node's usual roots plus `extraCa`
 * (intermediate certificates a server forgets to send). Used only for such servers.
 *
 * The body is buffered, up to `maxBodyBytes`: past that the connection is closed and the call
 * rejects with `BodyTooLarge`. `requestImpl` is for tests (node:http's `request`).
 */
export function httpsFetchWithCa(
  extraCa: string[],
  maxBodyBytes = Infinity,
  requestImpl: typeof request = request,
): FetchLike {
  const ca = [...rootCertificates, ...extraCa]
  const get = (url: string, init: RequestInit | undefined, redirects: number): Promise<Response> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) }
      // what `fetch` takes and this client sends; anything else is refused, never dropped
      const body: unknown = init?.body
      let payload: string | Uint8Array | undefined
      if (typeof body === 'string') payload = body
      else if (body instanceof URLSearchParams) {
        payload = body.toString()
        if (!hasHeader(headers, 'content-type'))
          headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
      } else if (body instanceof Uint8Array) payload = body
      else if (body instanceof ArrayBuffer) payload = new Uint8Array(body)
      else if (body !== undefined && body !== null) {
        reject(new TypeError('httpsFetchWithCa: unsupported request body type'))
        return
      }
      const req = requestImpl(
        url,
        {
          method: init?.method ?? 'GET',
          headers,
          ca,
          signal: init?.signal ?? undefined,
        },
        (res) => {
          const status = res.statusCode ?? 0
          const location = res.headers.location
          if (status >= 300 && status < 400 && location && redirects > 0) {
            res.resume()
            resolve(get(new URL(location, url).toString(), init, redirects - 1))
            return
          }
          const tooLarge = () => {
            req.destroy()
            reject(new BodyTooLarge(maxBodyBytes))
          }
          if (Number(res.headers['content-length']) > maxBodyBytes) return tooLarge()
          const chunks: Buffer[] = []
          let total = 0
          res.on('data', (c: Buffer) => {
            total += c.length
            if (total > maxBodyBytes) tooLarge()
            else chunks.push(c)
          })
          res.on('error', reject)
          res.on('end', () => {
            // `new Response` throws for a status outside 200–599 and for a body on a null-body
            // status: inside this handler that would be an uncaught exception, not a rejection
            try {
              const headers = new Headers()
              for (const [k, v] of Object.entries(res.headers))
                if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
              const empty = status === 204 || status === 205 || status === 304
              resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers }))
            } catch (cause) {
              reject(new Error(`unusable response (status ${status}) from ${new URL(url).host}`, { cause }))
            }
          })
        },
      )
      req.on('error', reject)
      if (payload !== undefined) req.write(payload)
      req.end()
    })
  return (url, init) => get(url, init, 5)
}
