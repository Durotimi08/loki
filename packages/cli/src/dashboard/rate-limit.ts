/**
 * Per-IP token-bucket rate limit — DASHBOARD.md §8.13, T17 / T18.
 *
 * In-process state. The dashboard is a singleton per Loki deployment;
 * we don't advertise this as horizontally scalable. State lives in an
 * LRU keyed by source IP. Exceeded → `429` with `Retry-After`.
 *
 * The default budget (120/min, burst 30) is generous for human use and
 * fatal for naive bots. M3 will swap the key from IP to session id
 * (per-subject limits) once auth lands.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuditLog } from './audit.js'

export type RateLimitOptions = {
  /** Refill rate per minute. Default 120. */
  readonly perMinute?: number
  /** Maximum burst size. Default 30. */
  readonly burst?: number
  /** Max number of distinct keys we track. Default 4096. */
  readonly maxKeys?: number
  /** Override `Date.now()` — used by tests. */
  readonly now?: () => number
}

type Bucket = {
  tokens: number
  /** Last refill, ms since epoch. */
  refilledAt: number
}

export function registerRateLimit(
  app: FastifyInstance,
  audit: AuditLog,
  opts: RateLimitOptions = {},
): void {
  const perMinute = opts.perMinute ?? 120
  const burst = opts.burst ?? 30
  const maxKeys = opts.maxKeys ?? 4096
  const now = opts.now ?? Date.now
  const refillPerMs = perMinute / 60_000

  // Tiny LRU — Map preserves insertion order, so the first-key is the
  // oldest. On overflow we delete the oldest. Avoids importing a lib.
  const buckets = new Map<string, Bucket>()

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Key by the rotating session id when present (M3 §8.5). Anonymous
    // / bearer-stateless requests fall back to the source IP. Using the
    // sid means a single authenticated subject's burst across multiple
    // clients still counts together — which is what we want for abuse
    // detection.
    const sid = req.session?.sid
    const key =
      typeof sid === 'string' && sid !== '' && sid !== 'stateless' && sid !== 'anon'
        ? `sid:${sid}`
        : `ip:${req.ip}`
    const t = now()
    let b = buckets.get(key)
    if (b === undefined) {
      if (buckets.size >= maxKeys) {
        const oldest = buckets.keys().next().value
        if (oldest !== undefined) buckets.delete(oldest)
      }
      b = { tokens: burst, refilledAt: t }
      buckets.set(key, b)
    } else {
      // Refresh LRU position.
      buckets.delete(key)
      buckets.set(key, b)
      const elapsed = t - b.refilledAt
      if (elapsed > 0) {
        b.tokens = Math.min(burst, b.tokens + elapsed * refillPerMs)
        b.refilledAt = t
      }
    }

    if (b.tokens < 1) {
      const deficit = 1 - b.tokens
      const retryAfterSec = Math.max(1, Math.ceil(deficit / refillPerMs / 1000))
      audit.append({
        reqId: req.id,
        event: 'rate-limit.deny',
        sourceIp: key,
        detail: { path: req.url, method: req.method, retryAfterSec },
      })
      reply
        .code(429)
        .type('application/problem+json')
        .header('Cache-Control', 'private, no-store')
        .header('Retry-After', String(retryAfterSec))
        .send({
          type: 'https://loki.dev/problems/rate-limited',
          title: 'Too Many Requests',
          status: 429,
        })
      return reply
    }
    b.tokens -= 1
    return undefined
  })
}
