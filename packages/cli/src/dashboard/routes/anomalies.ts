/**
 * Anomaly routes — DASHBOARD.md §6.6.
 *
 *   GET /api/v1/tenants/:tid/anomalies?severity=&check=&unresolved=&cursor=&limit=
 *   GET /api/v1/tenants/:tid/anomalies/:id
 *
 * Anomaly `expected` / `observed` JSONB columns can contain serialised
 * payload fragments. The detail route runs both through the redactor
 * (`kind: 'anomaly'`) so PII never leaks via a reconciler finding.
 */
import type { FastifyInstance } from 'fastify'
import type { AnomalyRow } from '@loki/core'
import { type Redactor, redactPayload } from '../redact.js'
import type { CursorEncoder } from '../security/cursor.js'
import type { RouteSemaphore } from '../security/route-concurrency.js'
import * as v from '../security/validation.js'
import type { ReadEngine } from '../read-engine.js'
import { problem, resolveTenant } from './helpers.js'

export type AnomalyRouteContext = {
  readonly engine: ReadEngine
  readonly tenants: 'all' | readonly string[]
  readonly cursor: CursorEncoder
  readonly redactor: Redactor
  /** Optional per-route concurrency semaphore (§8.13). */
  readonly findManyConcurrency?: RouteSemaphore
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHECK_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/

export function registerAnomalyRoutes(app: FastifyInstance, ctx: AnomalyRouteContext): void {
  const findManyHooks = ctx.findManyConcurrency
    ? { preHandler: ctx.findManyConcurrency.preHandler, onResponse: ctx.findManyConcurrency.onResponse }
    : {}
  app.get('/api/v1/tenants/:tid/anomalies', findManyHooks, async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply

    const q = req.query as Record<string, string | undefined>
    const limit = v.limit(q['limit'])
    if (!limit.ok) return problem(reply, 400, 'bad-limit', limit.reason)

    let severityFilter: 'warn' | 'error' | 'critical' | undefined
    if (q['severity'] !== undefined) {
      const r = v.severity(q['severity'])
      if (!r.ok) return problem(reply, 400, 'bad-severity', r.reason)
      severityFilter = r.value
    }

    let checkFilter: string | undefined
    if (q['check'] !== undefined) {
      if (!CHECK_NAME_RE.test(q['check'])) {
        return problem(reply, 400, 'bad-check', 'expected lower-snake check name')
      }
      checkFilter = q['check']
    }

    const unresolvedOnly = q['unresolved'] === 'true'

    const route = 'anomalies'
    let innerCursor: string | undefined
    if (q['cursor'] !== undefined) {
      const dec = ctx.cursor.decode(route, q['cursor'])
      if (!dec.ok) return problem(reply, 400, 'bad-cursor', dec.reason)
      innerCursor = dec.inner
    }

    const client = ctx.engine.forTenant(t.id)
    const page = await client.queries.anomalies.findMany({
      where: {
        ...(severityFilter !== undefined ? { severity: severityFilter } : {}),
        ...(checkFilter !== undefined ? { check: checkFilter } : {}),
        ...(unresolvedOnly ? { resolved: false } : {}),
      },
      limit: limit.value,
      ...(innerCursor !== undefined ? { cursor: innerCursor } : {}),
    })

    reply.header('Cache-Control', 'private, no-store')
    return {
      items: await Promise.all(page.items.map((a) => projectAnomaly(a, ctx, t.id))),
      nextCursor:
        page.nextCursor !== null ? ctx.cursor.encode(route, page.nextCursor) : null,
    }
  })

  app.get('/api/v1/tenants/:tid/anomalies/:id', async (req, reply) => {
    const params = req.params as { tid?: string; id?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    if (typeof params.id !== 'string' || !UUID_RE.test(params.id)) {
      return problem(reply, 400, 'bad-anomaly-id', 'expected UUID v4')
    }
    const row = await ctx.engine.dashboard.anomalyGet(t.id, params.id)
    if (row === null) return problem(reply, 404, 'anomaly-not-found')
    reply.header('Cache-Control', 'private, no-store')
    return projectAnomaly(row, ctx, t.id)
  })
}

async function projectAnomaly(
  a: AnomalyRow,
  ctx: AnomalyRouteContext,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const redCtx = { kind: 'anomaly' as const, tenantId, check: a.check }
  const expected = await redactPayload(ctx.engine.decryptPayload, a.expected, redCtx, ctx.redactor)
  const observed = await redactPayload(ctx.engine.decryptPayload, a.observed, redCtx, ctx.redactor)
  return {
    id: a.id,
    detectedAt: a.detectedAt.toISOString(),
    check: a.check,
    txnId: a.txnId,
    accountId: a.accountId,
    severity: a.severity,
    expected,
    observed,
    resolvedAt: a.resolvedAt !== null ? a.resolvedAt.toISOString() : null,
    resolvedBy: a.resolvedBy,
    resolution: a.resolution,
  }
}
