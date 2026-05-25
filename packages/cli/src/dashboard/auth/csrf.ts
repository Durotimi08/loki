/**
 * Double-submit-cookie CSRF — DASHBOARD.md §8.6.
 *
 * Every state-changing POST (M8 actions) must carry:
 *   1. A valid session cookie.
 *   2. An `X-CSRF-Token` header equal to the `csrf` field in the session
 *      payload (constant-time compare).
 *   3. `Sec-Fetch-Site: same-origin` (already enforced globally in §8.3).
 *
 * M3 only wires the middleware; there are no production POSTs yet.
 * Test fixtures verify the gate behaves correctly.
 */
import { timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { SessionPayload } from './types.js'

export type CsrfCheckResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export function checkCsrf(req: FastifyRequest, session: SessionPayload): CsrfCheckResult {
  const raw = req.headers['x-csrf-token']
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'missing X-CSRF-Token header' }
  }
  const a = Buffer.from(raw, 'utf8')
  const b = Buffer.from(session.csrf, 'utf8')
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' }
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'mismatch' }
  return { ok: true }
}

export function sendCsrfFailure(reply: FastifyReply, reason: string): FastifyReply {
  reply
    .code(403)
    .type('application/problem+json')
    .header('Cache-Control', 'private, no-store')
    .send({
      type: 'https://loki.dev/problems/csrf-denied',
      title: 'CSRF denied',
      status: 403,
      detail: reason,
    })
  return reply
}
