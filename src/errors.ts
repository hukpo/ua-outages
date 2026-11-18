import type { RegionId } from './types.js'

export type OutageErrorCode =
  /** DNS, connection reset, timeout */
  | 'network'
  /** Non-2xx response */
  | 'http'
  /** A firewall / bot protection answered instead of the operator */
  | 'blocked'
  /** The response arrived but its format changed or is invalid */
  | 'parse'
  /** The response body is larger than `maxBodyBytes` and was not read */
  | 'too-large'
  /** The region or feature isn't supported */
  | 'unsupported'
  /** Address search found nothing (or nothing unambiguous) */
  | 'not-found'
  /**
   * The region reads posts or pictures and no `textProcessor` / `imageProcessor` is configured
   * (see `OutageClientOptions`). A processor's answer that fails validation is `parse`; one
   * that couldn't be had (the AI API down, rate limits) is `network` or `http`.
   */
  | 'config'

export class OutageError extends Error {
  override readonly name = 'OutageError'

  constructor(
    readonly code: OutageErrorCode,
    message: string,
    readonly details: { region?: RegionId; url?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
  }
}

export const isOutageError = (e: unknown): e is OutageError => e instanceof OutageError
