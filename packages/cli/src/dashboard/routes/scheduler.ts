/**
 * Scheduled-transition routes — DASHBOARD.md §6.8.
 *
 *   GET /api/v1/tenants/:tid/scheduled?status=&cursor=&limit=
 *   GET /api/v1/tenants/:tid/scheduled/:id
 *
 * `engine.scheduler.list` doesn't paginate — we wrap it with a cursor.
 * Limited to small N (≤ 500); the typical scheduled queue is short.
 */
import type { FastifyInstance } from 'fastify'
import type { ScheduledTransition, ScheduledTransitionStatus } from '@loki/core'
import { type Redactor, redactPayload } from '../redact.js'
import type { ReadEngine } from '../read-engine.js'
import type { CursorEncoder } from '../security/cursor.js'
import * as v from '../security/validation.js'
import { problem, resolveTenant } from './helpers.js'

export type SchedulerRouteContext = {
  readonly engine: ReadEngine
  readonly tenants: 'all' | readonly string[]
  readonly cursor: CursorEncoder
  readonly redactor: Redactor
}

const ALLOWED_STATUSES = new Set<ScheduledTransitionStatus>([
  'pending',
  'completed',
  'cancelled',
  'failed',
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerSchedulerRoutes(
  app: FastifyInstance,
  ctx: SchedulerRouteContext,
): void {
  app.get('/api/v1/tenants/:tid/scheduled', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply

    const q = req.query as Record<string, string | undefined>
    const limit = v.limit(q['limit'])
    if (!limit.ok) return problem(reply, 400, 'bad-limit', limit.reason)

    let status: ScheduledTransitionStatus | undefined
    if (q['status'] !== undefined) {
      if (!ALLOWED_STATUSES.has(q['status'] as ScheduledTransitionStatus)) {
        return problem(reply, 400, 'bad-status', `must be one of ${[...ALLOWED_STATUSES].join(', ')}`)
      }
      status = q['status'] as ScheduledTransitionStatus
    }

    const all = await ctx.engine.scheduler.list({
      tenantId: t.id,
      ...(status !== undefined ? { status } : {}),
    })
    // In-memory pagination by id; engine.scheduler.list returns all rows.
    // Acceptable because the scheduled queue is typically small.
    const sorted = [...all].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const route = 'scheduled'
    let startIdx = 0
    if (q['cursor'] !== undefined) {
      const dec = ctx.cursor.decode(route, q['cursor'])
      if (!dec.ok) return problem(reply, 400, 'bad-cursor', dec.reason)
      const idx = sorted.findIndex((s) => s.id > dec.inner)
      startIdx = idx === -1 ? sorted.length : idx
    }
    const slice = sorted.slice(startIdx, startIdx + limit.value)
    const last = slice[slice.length - 1]
    const nextCursor =
      startIdx + limit.value < sorted.length && last !== undefined
        ? ctx.cursor.encode(route, last.id)
        : null

    reply.header('Cache-Control', 'private, no-store')
    return {
      items: await Promise.all(slice.map((s) => projectScheduled(s, ctx, t.id))),
      nextCursor,
    }
  })

  app.get('/api/v1/tenants/:tid/scheduled/:id', async (req, reply) => {
    const params = req.params as { tid?: string; id?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    if (typeof params.id !== 'string' || !UUID_RE.test(params.id)) {
      return problem(reply, 400, 'bad-scheduled-id', 'expected UUID v4')
    }
    const row = await ctx.engine.dashboard.scheduledGet(t.id, params.id)
    if (row === null) return problem(reply, 404, 'scheduled-not-found')
    reply.header('Cache-Control', 'private, no-store')
    return projectScheduled(row, ctx, t.id)
  })
}

async function projectScheduled(
  s: ScheduledTransition,
  ctx: SchedulerRouteContext,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const payload = await redactPayload(
    ctx.engine.decryptPayload,
    s.payload,
    { kind: 'transition', tenantId, txnType: s.name, transitionName: s.name },
    ctx.redactor,
  )
  return {
    id: s.id,
    txnId: s.txnId,
    name: s.name,
    runAt: s.runAt.toISOString(),
    actor: s.actor,
    status: s.status,
    attempts: s.attempts,
    lastError: s.lastError,
    firedAt: s.firedAt !== null ? s.firedAt.toISOString() : null,
    firedTransitionId: s.firedTransitionId,
    createdAt: s.createdAt.toISOString(),
    withKey: s.withKey,
    payload,
  }
}
