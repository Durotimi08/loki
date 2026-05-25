/**
 * Twelve-gate action preHandler — DASHBOARD.md §9.2.
 *
 * Every gate is checked at the request boundary, before the writable
 * pool is touched. A failure on any gate produces an RFC 7807 problem
 * doc + an audit entry naming the gate that refused.
 *
 * The dashboard's auth layer (M3) has already populated `req.session`;
 * the global Sec-Fetch / Host / smuggling / CORS guards (M2) have
 * already passed when this preHandler runs.
 */
import { timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuditLog } from '../audit.js'
import { type ConcurrencyCap } from '../sse.js'
import { problem } from '../routes/helpers.js'
import { checkCsrf } from '../auth/csrf.js'
import type { ActionExecutorFactory } from './executor.js'
import {
  type CachedResponse,
  type IdempotencyCache,
  isValidIdempotencyKey,
} from './idempotency.js'
import type { ActionThrottle } from './throttle.js'
import type { ActionGrants, ActionId } from './types.js'

export type GateInput = {
  readonly actionId: ActionId
  readonly grants: ActionGrants
  readonly throttle: ActionThrottle
  readonly idempotency: IdempotencyCache
  readonly concurrency: ConcurrencyCap
  /** Builds a writable executor on first use; throws on misconfig. */
  readonly executorFactory: ActionExecutorFactory | null
  readonly audit: AuditLog
  /** Session must be no older than this (ms) to perform an action. */
  readonly maxSessionAgeMs?: number
  readonly now?: () => number
}

const DEFAULT_MAX_SESSION_AGE_MS = 30 * 60_000
const ALLOWED_CONTENT_TYPES = new Set([
  'application/json',
  'application/json; charset=utf-8',
  'application/json;charset=utf-8',
])

export type GatePassthrough = {
  readonly subject: string
  readonly idempotencyKey: string
}

/**
 * Run every gate sequentially. Returns the subject + key on success
 * (the route handler uses both to record the response into the
 * idempotency cache and to release the concurrency slot on completion).
 */
export async function runGate(
  req: FastifyRequest,
  reply: FastifyReply,
  input: GateInput,
): Promise<GatePassthrough | null> {
  const now = input.now ?? Date.now

  // Gate 2: writable pool configured.
  if (input.executorFactory === null) {
    deny(input.audit, req, input.actionId, 'no-actions-pool')
    problem(reply, 503, 'no-actions-pool', 'configure `dashboard.actions.connectionUrl`')
    return null
  }

  // Gate 3 (subject in grants) needs the session.
  const session = req.session
  if (session === undefined || session === null || session.scheme === 'none') {
    deny(input.audit, req, input.actionId, 'unauthenticated')
    problem(reply, 401, 'unauthorized')
    return null
  }
  const granted = input.grants[input.actionId] ?? []
  if (!granted.includes(session.subject)) {
    deny(input.audit, req, input.actionId, 'not-granted', { subject: session.subject })
    problem(reply, 403, 'action-not-granted')
    return null
  }

  // Gate 4: session age (sliding via issuedAt; rotated after each action).
  const maxAge = input.maxSessionAgeMs ?? DEFAULT_MAX_SESSION_AGE_MS
  if (now() - session.issuedAt > maxAge) {
    deny(input.audit, req, input.actionId, 'session-too-old')
    reply.header('WWW-Authenticate', `${session.scheme === 'basic' ? 'Basic' : 'Bearer'} realm="loki"`)
    problem(reply, 401, 'unauthorized', 'session older than rotation window')
    return null
  }

  // Gate 5: CSRF.
  const csrf = checkCsrf(req, session)
  if (!csrf.ok) {
    deny(input.audit, req, input.actionId, 'csrf', { reason: csrf.reason })
    problem(reply, 403, 'csrf-denied', csrf.reason)
    return null
  }

  // Gate 6: Sec-Fetch — same-origin + cors mode.
  const fetchSite = headerLower(req, 'sec-fetch-site')
  const fetchMode = headerLower(req, 'sec-fetch-mode')
  // Non-browser callers (curl / CI) won't send Sec-Fetch headers. We're
  // strict here even for them: actions are browser-only. Allow `none`
  // only when explicitly running from same-host bearer scripts.
  if (fetchSite !== 'same-origin' && fetchSite !== 'none') {
    deny(input.audit, req, input.actionId, 'fetch-site', { value: fetchSite ?? null })
    problem(reply, 403, 'forbidden', 'cross-site action attempt')
    return null
  }
  if (fetchMode !== undefined && fetchMode !== 'cors' && fetchMode !== 'same-origin') {
    deny(input.audit, req, input.actionId, 'fetch-mode', { value: fetchMode })
    problem(reply, 403, 'forbidden')
    return null
  }

  // Gate 7: exact Content-Type.
  const ct = headerLower(req, 'content-type')
  if (ct === undefined || !ALLOWED_CONTENT_TYPES.has(ct)) {
    deny(input.audit, req, input.actionId, 'content-type', { value: ct ?? null })
    problem(reply, 415, 'unsupported-media-type', 'expected application/json')
    return null
  }

  // Gate 8: Idempotency-Key.
  const rawKey = req.headers['idempotency-key']
  const idempotencyKey = typeof rawKey === 'string' ? rawKey : Array.isArray(rawKey) ? rawKey[0] : undefined
  if (!isValidIdempotencyKey(idempotencyKey)) {
    deny(input.audit, req, input.actionId, 'idempotency-key', { value: idempotencyKey ?? null })
    problem(reply, 400, 'bad-idempotency-key', 'base64url, 1..64 chars')
    return null
  }

  const claim = input.idempotency.claim(session.subject, input.actionId, idempotencyKey)
  if (claim.kind === 'in-flight') {
    deny(input.audit, req, input.actionId, 'idempotency-in-flight')
    problem(reply, 409, 'idempotency-in-flight', 'an earlier request with this key is still running')
    return null
  }
  if (claim.kind === 'replay') {
    replayResponse(reply, claim.response, idempotencyKey)
    input.audit.append({
      reqId: req.id,
      event: 'action.replay',
      sourceIp: req.ip,
      subject: session.subject,
      detail: { action: input.actionId, idempotencyKey },
    })
    return null
  }

  // Gate 10: per-(subject, action) rate limit.
  const throttle = input.throttle.check(session.subject, input.actionId)
  if (!throttle.allowed) {
    input.idempotency.release(session.subject, input.actionId, idempotencyKey)
    deny(input.audit, req, input.actionId, `throttle-${throttle.reason}`, {
      subject: session.subject,
      retryAfterMs: throttle.retryAfterMs,
    })
    reply.header('Retry-After', String(Math.max(1, Math.ceil(throttle.retryAfterMs / 1000))))
    problem(reply, 429, 'rate-limited', throttle.reason)
    return null
  }

  // Gate 11: global concurrency cap (4 in-flight default).
  if (!input.concurrency.tryAcquire()) {
    input.idempotency.release(session.subject, input.actionId, idempotencyKey)
    deny(input.audit, req, input.actionId, 'concurrency-cap')
    problem(reply, 429, 'rate-limited', 'too many actions in flight')
    return null
  }

  return { subject: session.subject, idempotencyKey }
}

// =============================================================================
// Helpers
// =============================================================================

function headerLower(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name]
  if (typeof raw === 'string') return raw.toLowerCase().trim()
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].toLowerCase().trim()
  return undefined
}

function replayResponse(reply: FastifyReply, response: CachedResponse, key: string): void {
  reply
    .code(409)
    .type('application/json')
    .header('Cache-Control', 'private, no-store')
    .header('X-Idempotent-Replay', key)
    .send(response.body)
}

function deny(
  audit: AuditLog,
  req: FastifyRequest,
  actionId: ActionId,
  gate: string,
  detail: Record<string, unknown> = {},
): void {
  const subject = req.session?.subject
  audit.append({
    reqId: req.id,
    event: 'action.deny',
    sourceIp: req.ip,
    ...(subject !== undefined ? { subject } : {}),
    detail: { action: actionId, gate, ...detail },
  })
}

// Re-export for tests.
export { timingSafeEqual }
