/**
 * Outbox routes — DASHBOARD.md §6.8.
 *
 *   GET /api/v1/tenants/:tid/outbox?status=&cursor=&limit=
 *   GET /api/v1/tenants/:tid/outbox/:id
 *
 * Event payloads ride through the redactor (§8.9, `kind: 'outbox'`) so
 * adapter-bound PII doesn't leak via the dashboard.
 */
import type { FastifyInstance } from 'fastify'
import { type Redactor, redactPayload } from '../redact.js'
import type { OutboxRow, OutboxStatus, ReadEngine } from '../read-engine.js'
import type { CursorEncoder } from '../security/cursor.js'
import * as v from '../security/validation.js'
import { problem, resolveTenant } from './helpers.js'

export type OutboxRouteContext = {
  readonly engine: ReadEngine
  readonly tenants: 'all' | readonly string[]
  readonly cursor: CursorEncoder
  readonly redactor: Redactor
}

const ALLOWED_STATUSES = new Set<OutboxStatus>(['pending', 'in_flight', 'terminal', 'failed_terminal'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerOutboxRoutes(app: FastifyInstance, ctx: OutboxRouteContext): void {
  app.get('/api/v1/tenants/:tid/outbox', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply

    const q = req.query as Record<string, string | undefined>
    const limit = v.limit(q['limit'])
    if (!limit.ok) return problem(reply, 400, 'bad-limit', limit.reason)

    let status: OutboxStatus | undefined
    if (q['status'] !== undefined) {
      if (!ALLOWED_STATUSES.has(q['status'] as OutboxStatus)) {
        return problem(reply, 400, 'bad-status', `must be one of ${[...ALLOWED_STATUSES].join(', ')}`)
      }
      status = q['status'] as OutboxStatus
    }

    const route = 'outbox'
    let innerCursor: string | undefined
    if (q['cursor'] !== undefined) {
      const dec = ctx.cursor.decode(route, q['cursor'])
      if (!dec.ok) return problem(reply, 400, 'bad-cursor', dec.reason)
      innerCursor = dec.inner
    }

    const page = await ctx.engine.dashboard.outboxList(t.id, {
      ...(status !== undefined ? { status } : {}),
      ...(innerCursor !== undefined ? { cursor: innerCursor } : {}),
      limit: limit.value,
    })

    reply.header('Cache-Control', 'private, no-store')
    return {
      items: await Promise.all(page.items.map((o) => projectOutbox(o, ctx, t.id))),
      nextCursor: page.nextCursor !== null ? ctx.cursor.encode(route, page.nextCursor) : null,
    }
  })

  app.get('/api/v1/tenants/:tid/outbox/:id', async (req, reply) => {
    const params = req.params as { tid?: string; id?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    if (typeof params.id !== 'string' || !UUID_RE.test(params.id)) {
      return problem(reply, 400, 'bad-outbox-id', 'expected UUID v4')
    }
    const row = await ctx.engine.dashboard.outboxGet(t.id, params.id)
    if (row === null) return problem(reply, 404, 'outbox-not-found')
    reply.header('Cache-Control', 'private, no-store')
    return projectOutbox(row, ctx, t.id)
  })
}

async function projectOutbox(
  o: OutboxRow,
  ctx: OutboxRouteContext,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const payload = await redactPayload(
    ctx.engine.decryptPayload,
    o.payload,
    { kind: 'outbox', tenantId, topic: o.event },
    ctx.redactor,
  )
  return {
    id: o.id,
    txnId: o.txnId,
    transitionId: o.transitionId,
    event: o.event,
    intent: o.intent,
    status: o.status,
    attempts: o.attempts,
    nextAttemptAt: o.nextAttemptAt,
    lastError: o.lastError,
    createdAt: o.createdAt,
    payload,
  }
}
