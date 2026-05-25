/**
 * Bearer auth — DASHBOARD.md §8.4, T10 / T27.
 *
 * Constant-time compare against the configured token. The token is
 * accepted in the `Authorization` header only — never in URL, query,
 * cookie, or body. That kills accidental shell-history / proxy-log
 * leakage and makes the audit log unambiguous.
 *
 * Tokens must be ≥ 32 bytes of entropy (we document `openssl rand -hex 32`).
 */
import { createHash, timingSafeEqual } from 'node:crypto'

export type BearerVerifier = {
  /** Returns `true` if the header carries the configured token. */
  verify(authorizationHeader: string | undefined): boolean
  /** Stable subject id for the bearer (no PII leakage to logs). */
  readonly subject: string
}

export function createBearerVerifier(token: string): BearerVerifier {
  if (token.length < 32) {
    throw new Error('bearer: token must be ≥ 32 chars (use `openssl rand -hex 32`).')
  }
  const expected = Buffer.from(token, 'utf8')
  const subject = `bearer:${createHash('sha256').update(expected).digest('hex').slice(0, 12)}`
  return {
    subject,
    verify(authorizationHeader) {
      if (typeof authorizationHeader !== 'string') return false
      if (!authorizationHeader.startsWith('Bearer ')) return false
      const candidate = Buffer.from(authorizationHeader.slice('Bearer '.length), 'utf8')
      if (candidate.length !== expected.length) return false
      return timingSafeEqual(candidate, expected)
    },
  }
}
