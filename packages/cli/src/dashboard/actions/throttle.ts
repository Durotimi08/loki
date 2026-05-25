/**
 * Per-(subject, action) rate limit — DASHBOARD.md §9.2 gate 10 / §9.4.
 *
 * One token bucket per `${subject}:${actionId}` tuple. Default 10/min,
 * burst 3, 2-second cool-down after each successful action. The
 * cool-down catches the rage-click / bot-burst case that the burst
 * setting alone doesn't reach.
 */

export type ActionThrottleOptions = {
  readonly perMinute?: number
  readonly burst?: number
  readonly cooldownMs?: number
  readonly maxKeys?: number
  readonly now?: () => number
}

type Bucket = {
  tokens: number
  refilledAt: number
  cooldownUntil: number
}

export type ActionThrottleVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number; readonly reason: 'rate' | 'cooldown' }

export type ActionThrottle = {
  check(subject: string, actionId: string): ActionThrottleVerdict
  recordSuccess(subject: string, actionId: string): void
  recordFailure(subject: string, actionId: string): void
}

const DEFAULTS = { perMinute: 10, burst: 3, cooldownMs: 2_000, maxKeys: 4096 } as const

export function createActionThrottle(opts: ActionThrottleOptions = {}): ActionThrottle {
  const perMinute = opts.perMinute ?? DEFAULTS.perMinute
  const burst = opts.burst ?? DEFAULTS.burst
  const cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs
  const maxKeys = opts.maxKeys ?? DEFAULTS.maxKeys
  const now = opts.now ?? Date.now
  const refillPerMs = perMinute / 60_000

  const buckets = new Map<string, Bucket>()

  function load(key: string): Bucket {
    let b = buckets.get(key)
    const t = now()
    if (b === undefined) {
      if (buckets.size >= maxKeys) {
        const oldest = buckets.keys().next().value
        if (oldest !== undefined) buckets.delete(oldest)
      }
      b = { tokens: burst, refilledAt: t, cooldownUntil: 0 }
      buckets.set(key, b)
    } else {
      buckets.delete(key)
      buckets.set(key, b)
      const elapsed = t - b.refilledAt
      if (elapsed > 0) {
        b.tokens = Math.min(burst, b.tokens + elapsed * refillPerMs)
        b.refilledAt = t
      }
    }
    return b
  }

  return {
    check(subject, actionId) {
      const key = `${subject}:${actionId}`
      const b = load(key)
      const t = now()
      if (b.cooldownUntil > t) {
        return { allowed: false, retryAfterMs: b.cooldownUntil - t, reason: 'cooldown' }
      }
      if (b.tokens < 1) {
        const deficit = 1 - b.tokens
        return {
          allowed: false,
          retryAfterMs: Math.max(1, Math.ceil(deficit / refillPerMs)),
          reason: 'rate',
        }
      }
      return { allowed: true }
    },
    recordSuccess(subject, actionId) {
      const key = `${subject}:${actionId}`
      const b = load(key)
      b.tokens = Math.max(0, b.tokens - 1)
      b.cooldownUntil = now() + cooldownMs
    },
    recordFailure(subject, actionId) {
      const key = `${subject}:${actionId}`
      const b = load(key)
      b.tokens = Math.max(0, b.tokens - 1)
      // No cool-down on failure — the user gets to retry immediately.
    },
  }
}
