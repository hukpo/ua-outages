/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return out
}

/** "name=value; name2=value2" from a response's Set-Cookie headers. */
export function cookieHeader(headers: Headers): string {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  return list.map((c) => c.split(';')[0]).join('; ')
}
