/**
 * Signed, route-scoped pagination cursors — DASHBOARD.md §8.19.4 T44.
 *
 * Why HMAC-signed: an unsigned cursor lets an attacker (a) coerce a
 * query into reading from a position they shouldn't reach, (b) reuse a
 * cursor minted by route A against route B, or (c) feed a malformed
 * cursor to crash the parser. The signed form rejects all three at the
 * 400 boundary, before any DB call.
 *
 * Wire format:
 *
 *   base64url(JSON({ route, inner, issuedAt })).base64url(hmac-sha256(payload, cursorSecret))
 *
 * `inner` is the engine's own (unsigned) cursor string — we wrap it
 * rather than reinvent the keyset format. `cursorSecret` is derived
 * from the session secret via HMAC("cursor"), so rotating the session
 * secret invalidates outstanding cursors automatically.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Secret } from '../auth/secret.js'

export type Cursor = string

/** Derive a per-purpose secret from the session HMAC key. */
export function deriveCursorSecret(sessionSecret: Secret): Buffer {
  return createHmac('sha256', sessionSecret).update('loki-dashboard-cursor-v1').digest()
}

export type CursorEncoder = {
  encode(route: string, inner: string): Cursor
  decode(route: string, token: string): { ok: true; inner: string } | { ok: false; reason: string }
}

export type CursorEncoderOptions = {
  /** Per-cursor TTL, ms. Default 24 h. */
  readonly ttlMs?: number
  /** Override clock. */
  readonly now?: () => number
}

const DEFAULT_TTL_MS = 24 * 60 * 60_000

export function createCursorEncoder(secret: Buffer, opts: CursorEncoderOptions = {}): CursorEncoder {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? Date.now

  return {
    encode(route, inner) {
      const payload = { route, inner, issuedAt: now() }
      const body = b64uEncode(Buffer.from(JSON.stringify(payload), 'utf8'))
      const tag = b64uEncode(createHmac('sha256', secret).update(body).digest())
      return `${body}.${tag}`
    },

    decode(route, token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 1024) {
        return { ok: false, reason: 'length' }
      }
      const idx = token.indexOf('.')
      if (idx <= 0 || idx === token.length - 1) {
        return { ok: false, reason: 'malformed' }
      }
      const body = token.slice(0, idx)
      const tag = token.slice(idx + 1)

      let tagBytes: Buffer
      try {
        tagBytes = b64uDecode(tag)
      } catch {
        return { ok: false, reason: 'malformed-tag' }
      }
      const expected = createHmac('sha256', secret).update(body).digest()
      if (tagBytes.length !== expected.length) return { ok: false, reason: 'bad-hmac' }
      if (!timingSafeEqual(tagBytes, expected)) return { ok: false, reason: 'bad-hmac' }

      let parsed: unknown
      try {
        parsed = JSON.parse(b64uDecode(body).toString('utf8'))
      } catch {
        return { ok: false, reason: 'malformed-payload' }
      }
      if (!isCursorPayload(parsed)) return { ok: false, reason: 'shape' }
      if (parsed.route !== route) return { ok: false, reason: 'route-mismatch' }
      if (now() - parsed.issuedAt > ttl) return { ok: false, reason: 'expired' }
      return { ok: true, inner: parsed.inner }
    },
  }
}

type CursorPayload = { route: string; inner: string; issuedAt: number }

function isCursorPayload(v: unknown): v is CursorPayload {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r['route'] === 'string' &&
    typeof r['inner'] === 'string' &&
    typeof r['issuedAt'] === 'number'
  )
}

function b64uEncode(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64uDecode(s: string): Buffer {
  const pad = (4 - (s.length % 4)) % 4
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64')
}
