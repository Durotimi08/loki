/**
 * Per-IP and per-username auth throttle — DASHBOARD.md §8.4, T11.
 *
 * Two independent token buckets. Each failed attempt consumes from BOTH
 * the per-IP and per-user bucket. A successful attempt resets BOTH. If
 * either runs dry, the request is locked out — `429 Too Many Requests`
 * with `Retry-After`.
 *
 * Defaults match the doc:
 *   - per-IP   : 10 failures / 5 min, lockout 15 min
 *   - per-user :  5 failures / 5 min, lockout 15 min
 *
 * In-memory state (process-singleton). Restart clears it — acceptable
 * for a singleton dashboard with no persistence layer.
 */

export type ThrottleBucketOptions = {
  readonly failures: number
  readonly windowMs: number
  readonly lockoutMs: number
}

export type ThrottleOptions = {
  readonly perIp?: ThrottleBucketOptions
  readonly perUser?: ThrottleBucketOptions
  readonly maxKeys?: number
  readonly now?: () => number
}

type Bucket = {
  remaining: number
  windowStartedAt: number
  lockedUntil: number
}

export type ThrottleVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number; readonly key: 'ip' | 'user' }

export type Throttle = {
  /** Check whether the (ip, user) pair is allowed to attempt. */
  check(ip: string, user: string | null): ThrottleVerdict
  /** Record a failed attempt — consumes from both buckets. */
  recordFailure(ip: string, user: string | null): void
  /** Reset both buckets after a successful attempt. */
  recordSuccess(ip: string, user: string | null): void
}

const DEFAULT_PER_IP: ThrottleBucketOptions = {
  failures: 10,
  windowMs: 5 * 60_000,
  lockoutMs: 15 * 60_000,
}
const DEFAULT_PER_USER: ThrottleBucketOptions = {
  failures: 5,
  windowMs: 5 * 60_000,
  lockoutMs: 15 * 60_000,
}

export function createThrottle(opts: ThrottleOptions = {}): Throttle {
  const perIp = opts.perIp ?? DEFAULT_PER_IP
  const perUser = opts.perUser ?? DEFAULT_PER_USER
  const maxKeys = opts.maxKeys ?? 4096
  const now = opts.now ?? Date.now

  const ipBuckets = new Map<string, Bucket>()
  const userBuckets = new Map<string, Bucket>()

  function load(map: Map<string, Bucket>, key: string, cfg: ThrottleBucketOptions): Bucket {
    let b = map.get(key)
    const t = now()
    if (b === undefined) {
      if (map.size >= maxKeys) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
      b = { remaining: cfg.failures, windowStartedAt: t, lockedUntil: 0 }
      map.set(key, b)
    } else {
      // LRU refresh.
      map.delete(key)
      map.set(key, b)
      // Lockout expiry resets the bucket.
      if (b.lockedUntil > 0 && t >= b.lockedUntil) {
        b.remaining = cfg.failures
        b.windowStartedAt = t
        b.lockedUntil = 0
      } else if (b.lockedUntil === 0 && t - b.windowStartedAt > cfg.windowMs) {
        b.remaining = cfg.failures
        b.windowStartedAt = t
      }
    }
    return b
  }

  return {
    check(ip, user) {
      const t = now()
      const i = load(ipBuckets, ip, perIp)
      if (i.lockedUntil > t) {
        return { allowed: false, retryAfterMs: i.lockedUntil - t, key: 'ip' }
      }
      if (user !== null) {
        const u = load(userBuckets, user, perUser)
        if (u.lockedUntil > t) {
          return { allowed: false, retryAfterMs: u.lockedUntil - t, key: 'user' }
        }
      }
      return { allowed: true }
    },

    recordFailure(ip, user) {
      const t = now()
      const i = load(ipBuckets, ip, perIp)
      if (i.lockedUntil <= t) {
        i.remaining -= 1
        if (i.remaining <= 0) i.lockedUntil = t + perIp.lockoutMs
      }
      if (user !== null) {
        const u = load(userBuckets, user, perUser)
        if (u.lockedUntil <= t) {
          u.remaining -= 1
          if (u.remaining <= 0) u.lockedUntil = t + perUser.lockoutMs
        }
      }
    },

    recordSuccess(ip, user) {
      ipBuckets.delete(ip)
      if (user !== null) userBuckets.delete(user)
    },
  }
}
