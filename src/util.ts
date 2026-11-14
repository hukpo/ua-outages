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
  if (signal.aborted) {
    // nobody waits for it any more; a later rejection must not surface as unhandled
    promise.catch(() => {})
    return Promise.reject(signal.reason)
  }
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

/**
 * Work several calls wait on (a session, a directory). It runs on its own signal, which aborts
 * only when every caller that joined with a signal has given up; a caller without a signal keeps
 * it running. One caller cancelling never fails the others.
 */
export class SharedTask<T> {
  private readonly ctrl = new AbortController()
  private waiters = 0
  private pinned = false
  private settled = false
  readonly promise: Promise<T>

  constructor(run: (signal: AbortSignal) => Promise<T>) {
    this.promise = run(this.ctrl.signal)
    this.promise.then(
      () => (this.settled = true),
      () => (this.settled = true),
    )
  }

  /** Abandoned by all its callers: start a new one instead of joining */
  get aborted(): boolean {
    return this.ctrl.signal.aborted
  }

  join(signal?: AbortSignal): Promise<T> {
    if (!signal) {
      this.pinned = true
      return this.promise
    }
    this.waiters++
    // before the task settles a caller can only leave by aborting; after, aborting is moot
    return abortable(this.promise, signal).catch((e) => {
      if (signal.aborted && --this.waiters === 0 && !this.pinned && !this.settled)
        this.ctrl.abort(signal.reason)
      throw e
    })
  }
}
