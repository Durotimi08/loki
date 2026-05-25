/**
 * Reconciler routes — DASHBOARD.md §6.7.
 *
 *   GET /api/v1/tenants/:tid/reconciler/state            → watermarks per check kind
 *   GET /api/v1/tenants/:tid/reconciler/runs?since=&limit=  → recent dashboard-triggered runs
 *
 * The /runs endpoint reads from an in-memory ring buffer the action
 * subtree appends to after each successful `reconciler.run-once` call.
 * Lost on dashboard restart — for a persistent run log the operator
 * exports the dashboard's audit JSONL to long-term storage.
 */
import type { FastifyInstance } from 'fastify'
import type { ReadEngine } from '../read-engine.js'
import type { ReconcilerRunsBuffer } from '../reconciler-runs.js'
import * as v from '../security/validation.js'
import { problem, resolveTenant } from './helpers.js'

export type ReconcilerRouteContext = {
  readonly engine: ReadEngine
  readonly tenants: 'all' | readonly string[]
  readonly runsBuffer?: ReconcilerRunsBuffer
}

export function registerReconcilerRoutes(
  app: FastifyInstance,
  ctx: ReconcilerRouteContext,
): void {
  app.get('/api/v1/tenants/:tid/reconciler/state', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    const items = await ctx.engine.dashboard.reconcilerState(t.id)
    reply.header('Cache-Control', 'private, no-store')
    return { items }
  })

  app.get('/api/v1/tenants/:tid/reconciler/runs', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply

    const q = req.query as Record<string, string | undefined>
    const limit = v.limit(q['limit'])
    if (!limit.ok) return problem(reply, 400, 'bad-limit', limit.reason)

    let since: string | undefined
    if (q['since'] !== undefined) {
      const r = v.isoTimestamp(q['since'])
      if (!r.ok) return problem(reply, 400, 'bad-since', r.reason)
      since = r.value.toISOString()
    }

    const items = ctx.runsBuffer?.list(t.id, {
      limit: limit.value,
      ...(since !== undefined ? { since } : {}),
    }) ?? []

    reply.header('Cache-Control', 'private, no-store')
    return {
      items,
      // Operators reading this for the first time get a hint about scope.
      note: ctx.runsBuffer === undefined
        ? 'run-log not configured (in-memory buffer disabled)'
        : 'in-memory ring buffer (lost on restart); dashboard-triggered runs only',
    }
  })
}
