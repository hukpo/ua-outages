/**
 * Runs `fn` over `items` with at most `limit` in flight; results keep input order.
 *
 * Fails fast: after the first rejection (or once `signal` aborts) no further items are started,
 * so a site that just refused one request doesn't get the rest of the batch. Calls already in
 * flight are not interrupted here; pass them the same signal for that.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      signal?.throwIfAborted()
      const i = next++
      try {
        out[i] = await fn(items[i]!)
      } catch (e) {
        failed = true
        throw e
      }
    }
  }
  signal?.throwIfAborted()
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return out
}

/** "name=value; name2=value2" from a response's Set-Cookie headers. */
export function cookieHeader(headers: Headers): string {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  return list.map((c) => c.split(';')[0]).join('; ')
}

/** Settles like `promise`, or rejects with the signal's reason as soon as it aborts. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}
