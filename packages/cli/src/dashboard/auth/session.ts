/**
 * Signed-cookie session store — DASHBOARD.md §8.5.
 *
 *   value = base64url(payload-json) + '.' + base64url(hmac-sha256(payload, secret))
 *
 *   payload = { subject, scheme, sid, csrf, issuedAt, expiresAt }
 *
 * Rotation (`mint`) issues a fresh `sid` + `csrf` on every:
 *   - successful authentication
 *   - auth scheme change
 *   - state-changing POST (per §9.2 gate 5, M8)
 *
 * Validation enforces:
 *   - HMAC matches (constant-time)
 *   - JSON parses to the expected shape
 *   - now ≤ expiresAt (sliding)
 *   - now ≤ issuedAt + absoluteLifetimeMs (hard cap)
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Secret } from './secret.js'
import type { SessionPayload } from './types.js'

export type SessionConfig = {
  readonly secret: Secret
  /** Idle (sliding) timeout, ms. Default 30 min. */
  readonly idleMs?: number
  /** Absolute lifetime, ms. Default 12 h. */
  readonly absoluteMs?: number
  /** `now()` override for tests. */
  readonly now?: () => number
}

const DEFAULT_IDLE_MS = 30 * 60_000
const DEFAULT_ABSOLUTE_MS = 12 * 60 * 60_000

export type ValidateResult =
  | { readonly ok: true; readonly payload: SessionPayload }
  | { readonly ok: false; readonly reason: 'malformed' | 'bad-hmac' | 'expired' | 'absolute-expired' | 'shape' }

export type SessionStore = {
  /** Issue a fresh session (rotate sid + csrf, reset issuedAt + expiresAt). */
  mint(input: { subject: string; scheme: SessionPayload['scheme'] }): { payload: SessionPayload; cookieValue: string }
  /** Decode + verify a cookie value. */
  validate(cookieValue: string): ValidateResult
  /** Refresh the sliding expiry without rotating sid. Returns the new cookie value. */
  refresh(payload: SessionPayload): { payload: SessionPayload; cookieValue: string }
}

export function createSessionStore(cfg: SessionConfig): SessionStore {
  const idle = cfg.idleMs ?? DEFAULT_IDLE_MS
  const absolute = cfg.absoluteMs ?? DEFAULT_ABSOLUTE_MS
  const now = cfg.now ?? Date.now

  function sign(payload: SessionPayload): string {
    const body = b64uEncode(Buffer.from(JSON.stringify(payload)))
    const tag = b64uEncode(hmacBytes(body, cfg.secret))
    return `${body}.${tag}`
  }

  return {
    mint({ subject, scheme }) {
      const t = now()
      const payload: SessionPayload = {
        subject,
        scheme,
        sid: b64uEncode(randomBytes(16)),
        csrf: b64uEncode(randomBytes(32)),
        issuedAt: t,
        expiresAt: t + idle,
      }
      return { payload, cookieValue: sign(payload) }
    },

    validate(cookieValue) {
      const idx = cookieValue.indexOf('.')
      if (idx === -1 || idx === 0 || idx === cookieValue.length - 1) {
        return { ok: false, reason: 'malformed' }
      }
      const body = cookieValue.slice(0, idx)
      const tag = cookieValue.slice(idx + 1)

      let tagBytes: Buffer
      try {
        tagBytes = b64uDecode(tag)
      } catch {
        return { ok: false, reason: 'malformed' }
      }
      const expected = hmacBytes(body, cfg.secret)
      if (tagBytes.length !== expected.length) return { ok: false, reason: 'bad-hmac' }
      if (!timingSafeEqual(tagBytes, expected)) return { ok: false, reason: 'bad-hmac' }

      let parsed: unknown
      try {
        parsed = JSON.parse(b64uDecode(body).toString('utf8'))
      } catch {
        return { ok: false, reason: 'malformed' }
      }
      if (!isSessionPayload(parsed)) return { ok: false, reason: 'shape' }

      const t = now()
      if (t > parsed.expiresAt) return { ok: false, reason: 'expired' }
      if (t > parsed.issuedAt + absolute) return { ok: false, reason: 'absolute-expired' }
      return { ok: true, payload: parsed }
    },

    refresh(payload) {
      const refreshed: SessionPayload = { ...payload, expiresAt: now() + idle }
      return { payload: refreshed, cookieValue: sign(refreshed) }
    },
  }
}

function hmacBytes(body: string, secret: Secret): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function b64uEncode(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64uDecode(s: string): Buffer {
  const pad = (4 - (s.length % 4)) % 4
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64')
}

function isSessionPayload(v: unknown): v is SessionPayload {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r['subject'] === 'string' &&
    (r['scheme'] === 'bearer' || r['scheme'] === 'basic' || r['scheme'] === 'none') &&
    typeof r['sid'] === 'string' &&
    typeof r['csrf'] === 'string' &&
    typeof r['issuedAt'] === 'number' &&
    typeof r['expiresAt'] === 'number'
  )
}
