/**
 * Idempotency cache for action POSTs — DASHBOARD.md §9.2 gate 8.
 *
 * Per-subject LRU of seen `(actionId, idempotencyKey)` tuples. A key
 * already in the cache → `409 Conflict` with the original response
 * replayed.
 *
 * `claim()` is synchronous — the moment we hand back `{ kind: 'fresh' }`
 * the key is reserved with status `'in-flight'`. Subsequent claims with
 * the same key return either `{ kind: 'in-flight' }` (request still
 * running) or `{ kind: 'replay', response }` (request finished).
 *
 * Tests benefit from the synchronous claim: deterministic verification
 * with `app.inject`.
 */

export type CachedResponse = {
  readonly status: number
  readonly body: unknown
}

export type ClaimResult =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'in-flight' }
  | { readonly kind: 'replay'; readonly response: CachedResponse }

export type IdempotencyCacheOptions = {
  readonly maxKeysPerSubject?: number
}

export type IdempotencyCache = {
  claim(subject: string, actionId: string, key: string): ClaimResult
  complete(subject: string, actionId: string, key: string, response: CachedResponse): void
  /** Release the slot without recording a response (e.g. body validation failed). */
  release(subject: string, actionId: string, key: string): void
  /** Count of stored keys (sum across subjects). For tests / metrics. */
  size(): number
}

type State =
  | { kind: 'in-flight' }
  | { kind: 'replay'; response: CachedResponse }

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function isValidIdempotencyKey(s: unknown): s is string {
  return typeof s === 'string' && KEY_PATTERN.test(s)
}

export function createIdempotencyCache(
  opts: IdempotencyCacheOptions = {},
): IdempotencyCache {
  const maxKeysPerSubject = opts.maxKeysPerSubject ?? 256
  // subject → Map<actionKey, State> (insertion-ordered, LRU on access).
  const bySubject = new Map<string, Map<string, State>>()

  function lookup(subject: string): Map<string, State> {
    let m = bySubject.get(subject)
    if (m === undefined) {
      m = new Map()
      bySubject.set(subject, m)
    }
    return m
  }

  function compound(actionId: string, key: string): string {
    return `${actionId}:${key}`
  }

  return {
    claim(subject, actionId, key) {
      const m = lookup(subject)
      const ck = compound(actionId, key)
      const existing = m.get(ck)
      if (existing !== undefined) {
        // LRU refresh.
        m.delete(ck)
        m.set(ck, existing)
        if (existing.kind === 'in-flight') return { kind: 'in-flight' }
        return { kind: 'replay', response: existing.response }
      }
      if (m.size >= maxKeysPerSubject) {
        const oldest = m.keys().next().value
        if (oldest !== undefined) m.delete(oldest)
      }
      m.set(ck, { kind: 'in-flight' })
      return { kind: 'fresh' }
    },

    complete(subject, actionId, key, response) {
      const m = lookup(subject)
      m.set(compound(actionId, key), { kind: 'replay', response })
    },

    release(subject, actionId, key) {
      const m = lookup(subject)
      m.delete(compound(actionId, key))
    },

    size() {
      let n = 0
      for (const m of bySubject.values()) n += m.size
      return n
    },
  }
}
