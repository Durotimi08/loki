/**
 * Dispute routes — DASHBOARD.md §6.8.
 *
 *   GET /api/v1/tenants/:tid/disputes?status=&limit=
 *   GET /api/v1/tenants/:tid/disputes/:id
 */
import type { FastifyInstance } from 'fastify'
import type { Dispute, DisputeStatus } from '@loki/core'
import type { ReadEngine } from '../read-engine.js'
import * as v from '../security/validation.js'
import { problem, resolveTenant } from './helpers.js'

export type DisputesRouteContext = {
  readonly engine: ReadEngine
  readonly tenants: 'all' | readonly string[]
}

const ALLOWED_STATUSES = new Set<DisputeStatus>([
  'open',
  'resolved_customer',
  'resolved_merchant',
  'expired',
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerDisputeRoutes(app: FastifyInstance, ctx: DisputesRouteContext): void {
  app.get('/api/v1/tenants/:tid/disputes', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply

    const q = req.query as Record<string, string | undefined>
    const limit = v.limit(q['limit'])
    if (!limit.ok) return problem(reply, 400, 'bad-limit', limit.reason)

    let status: DisputeStatus | undefined
    if (q['status'] !== undefined) {
      if (!ALLOWED_STATUSES.has(q['status'] as DisputeStatus)) {
        return problem(reply, 400, 'bad-status', `must be one of ${[...ALLOWED_STATUSES].join(', ')}`)
      }
      status = q['status'] as DisputeStatus
    }

    const rows = await ctx.engine.disputes.list({
      tenantId: t.id,
      limit: limit.value,
      ...(status !== undefined ? { status } : {}),
    })
    reply.header('Cache-Control', 'private, no-store')
    return { items: rows.map(projectDispute) }
  })

  app.get('/api/v1/tenants/:tid/disputes/:id', async (req, reply) => {
    const params = req.params as { tid?: string; id?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    if (typeof params.id !== 'string' || !UUID_RE.test(params.id)) {
      return problem(reply, 400, 'bad-dispute-id', 'expected UUID v4')
    }
    const row = await ctx.engine.disputes.get(params.id)
    if (row === null || row.tenantId !== t.id) {
      return problem(reply, 404, 'dispute-not-found')
    }
    reply.header('Cache-Control', 'private, no-store')
    return projectDispute(row)
  })
}

function projectDispute(d: Dispute): Record<string, unknown> {
  return {
    id: d.id,
    originalTransitionId: d.originalTransitionId,
    status: d.status,
    openedAt: d.openedAt.toISOString(),
    deadlineAt: d.deadlineAt !== null ? d.deadlineAt.toISOString() : null,
    resolvedAt: d.resolvedAt !== null ? d.resolvedAt.toISOString() : null,
    resolution: d.resolution,
    reason: d.reason,
  }
}
