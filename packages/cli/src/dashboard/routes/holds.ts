/**
 * Hold routes — DASHBOARD.md §6.8.
 *
 *   GET /api/v1/tenants/:tid/holds?status=&limit=
 *   GET /api/v1/tenants/:tid/holds/:id
 */
import type { FastifyInstance } from 'fastify'
import type { Hold, HoldStatus } from '@loki/core'
import type { ReadEngine } from '../read-engine.js'
import * as v from '../security/validation.js'
import { problem, resolveTenant } from './helpers.js'

export type HoldsRouteContext = {
  readonly engine: ReadEngine
  readonly tenants: 'all' | readonly string[]
}

const ALLOWED_STATUSES = new Set<HoldStatus>(['placed', 'released', 'expired', 'captured'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerHoldRoutes(app: FastifyInstance, ctx: HoldsRouteContext): void {
  app.get('/api/v1/tenants/:tid/holds', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply

    const q = req.query as Record<string, string | undefined>
    const limit = v.limit(q['limit'])
    if (!limit.ok) return problem(reply, 400, 'bad-limit', limit.reason)

    let status: HoldStatus | undefined
    if (q['status'] !== undefined) {
      if (!ALLOWED_STATUSES.has(q['status'] as HoldStatus)) {
        return problem(reply, 400, 'bad-status', `must be one of ${[...ALLOWED_STATUSES].join(', ')}`)
      }
      status = q['status'] as HoldStatus
    }

    const rows = await ctx.engine.holds.list({
      tenantId: t.id,
      limit: limit.value,
      ...(status !== undefined ? { status } : {}),
    })
    reply.header('Cache-Control', 'private, no-store')
    return { items: rows.map(projectHold) }
  })

  app.get('/api/v1/tenants/:tid/holds/:id', async (req, reply) => {
    const params = req.params as { tid?: string; id?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    if (typeof params.id !== 'string' || !UUID_RE.test(params.id)) {
      return problem(reply, 400, 'bad-hold-id', 'expected UUID v4')
    }
    const row = await ctx.engine.holds.get(params.id)
    if (row === null || row.tenantId !== t.id) {
      return problem(reply, 404, 'hold-not-found')
    }
    reply.header('Cache-Control', 'private, no-store')
    return projectHold(row)
  })
}

function projectHold(h: Hold): Record<string, unknown> {
  return {
    id: h.id,
    txnId: h.txnId,
    holdAccountId: h.holdAccountId,
    amount: h.amount.toString(),
    status: h.status,
    expiresAt: h.expiresAt !== null ? h.expiresAt.toISOString() : null,
    releasedByTransitionId: h.releasedByTransitionId,
    placedAt: h.placedAt.toISOString(),
    releasedAt: h.releasedAt !== null ? h.releasedAt.toISOString() : null,
  }
}
