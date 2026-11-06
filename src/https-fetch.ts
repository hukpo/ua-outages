import { request } from 'node:https'
import { rootCertificates } from 'node:tls'
import type { FetchLike } from './http.js'

/**
 * A minimal fetch over node:https that trusts Node's usual roots plus `extraCa`
 * (intermediate certificates a server forgets to send). Used only for such servers.
 */
export function httpsFetchWithCa(extraCa: string[]): FetchLike {
  const ca = [...rootCertificates, ...extraCa]
  const get = (url: string, init: RequestInit | undefined, redirects: number): Promise<Response> =>
    new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: init?.method ?? 'GET',
          headers: init?.headers as Record<string, string> | undefined,
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
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('error', reject)
          res.on('end', () => {
            const headers = new Headers()
            for (const [k, v] of Object.entries(res.headers))
              if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
            resolve(
              new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), {
                status,
                headers,
              }),
            )
          })
        },
      )
      req.on('error', reject)
      if (typeof init?.body === 'string') req.write(init.body)
      req.end()
    })
  return (url, init) => get(url, init, 5)
}
