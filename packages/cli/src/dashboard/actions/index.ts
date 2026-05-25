/**
 * Action route registration — DASHBOARD.md §9.
 *
 *   POST /api/v1/tenants/:tid/anomalies/:id/resolve
 *   POST /api/v1/tenants/:tid/reconciler/run-once
 *
 * Routes are registered only when `--allow-actions` AND an auth scheme
 * AND an actions pool are configured. With no actions, the routes
 * literally don't exist on the Fastify instance — Fastify's 404
 * handler picks them up. The idempotency / throttle / executor state
 * is per-process; one set of state for all actions.
 */
import type { FastifyInstance } from 'fastify'
import type { SchemaDef } from '@loki/core'
import type { AuditLog } from '../audit.js'
import { problem, resolveTenant } from '../routes/helpers.js'
import { type ConcurrencyCap, createConcurrencyCap } from '../sse.js'
import type { ReadEngine } from '../read-engine.js'
import {
  type ActionExecutorFactory,
  ActionPreconditionError,
  createActionExecutorFactory,
} from './executor.js'
import { runGate } from './gate.js'
import {
  type CachedResponse,
  type IdempotencyCache,
  createIdempotencyCache,
} from './idempotency.js'
import { type ActionThrottle, createActionThrottle } from './throttle.js'
import type {
  ActionGrants,
  ActionId,
  ActionRateLimit,
  ActionsConfig,
} from './types.js'

export type ActionsRouteContext = {
  readonly engine: ReadEngine
  readonly schema: SchemaDef
  readonly tenants: 'all' | readonly string[]
  readonly audit: AuditLog
  /** When `false`, no action routes are mounted — Fastify's 404 covers them (DASHBOARD.md §9.2 gate 1). */
  readonly enabled: boolean
  /** `null` mounts routes but the gate returns 503 on every request (§9.2 gate 2). */
  readonly config: ActionsConfig | null
  /** Tests inject a fake executor; production constructs from `config`. */
  readonly executorFactory?: ActionExecutorFactory
  /** Tests inject these to control time + state. */
  readonly throttle?: ActionThrottle
  readonly idempotency?: IdempotencyCache
  readonly concurrency?: ConcurrencyCap
  readonly maxSessionAgeMs?: number
  readonly now?: () => number
  /** Reconciler-run ring buffer; `reconciler.run-once` appends on success. */
  readonly runsBuffer?: import('../reconciler-runs.js').ReconcilerRunsBuffer
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTION_BODY_LIMIT = 4 * 1024

const RESOLVE_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['by', 'note'],
  properties: {
    by: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9._@:-]+$' },
    note: { type: 'string', minLength: 1, maxLength: 1000 },
  },
} as const

const RUN_ONCE_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fullSweep: { type: 'boolean' },
  },
} as const

export function registerActionRoutes(app: FastifyInstance, ctx: ActionsRouteContext): void {
  // Gate 1: routes only exist when --allow-actions is on. Otherwise
  // Fastify's 404 handler covers them.
  if (!ctx.enabled) return

  // Gate 2: the executor factory is the per-request handle to the
  // writable pool. `null` means "no actions.connectionUrl configured" —
  // routes are still mounted, but every request 503s.
  const grants: ActionGrants = ctx.config?.grants ?? {}
  const throttle: ActionThrottle = ctx.throttle ?? createActionThrottle(ctx.config?.rateLimit ?? {})
  const idempotency: IdempotencyCache = ctx.idempotency ?? createIdempotencyCache()
  const concurrency: ConcurrencyCap =
    ctx.concurrency ?? createConcurrencyCap(ctx.config?.maxInFlight ?? 4)
  const executorFactory: ActionExecutorFactory | null =
    ctx.executorFactory ?? (ctx.config !== null ? createActionExecutorFactory(ctx.config, ctx.schema) : null)

  // ---------- POST /anomalies/:id/resolve ----------
  app.post(
    '/api/v1/tenants/:tid/anomalies/:id/resolve',
    {
      schema: { body: RESOLVE_BODY_SCHEMA },
      bodyLimit: ACTION_BODY_LIMIT,
      // Fastify's body parser would otherwise turn `text/plain` into a
      // 400. Check content-type at the earliest hook so we 415 first.
      onRequest: contentTypeGuard(ctx.audit, 'anomalies.resolve'),
    },
    async (req, reply) => {
      const params = req.params as { tid?: string; id?: string }
      const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
      if (t === null) return reply
      if (typeof params.id !== 'string' || !UUID_RE.test(params.id)) {
        return problem(reply, 400, 'bad-anomaly-id', 'expected UUID v4')
      }

      const pass = await runGate(req, reply, {
        actionId: 'anomalies.resolve',
        grants,
        throttle,
        idempotency,
        concurrency,
        executorFactory,
        audit: ctx.audit,
        ...(ctx.maxSessionAgeMs !== undefined ? { maxSessionAgeMs: ctx.maxSessionAgeMs } : {}),
        ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      })
      if (pass === null) return reply

      const body = req.body as { by: string; note: string }
      let response: CachedResponse
      try {
        const executor = await (executorFactory as ActionExecutorFactory)()
        const result = await executor.resolveAnomaly({
          tenantId: t.id,
          anomalyId: params.id,
          by: body.by,
          note: body.note,
        })
        response = {
          status: 200,
          body: { ok: true, anomalyId: params.id, ...result },
        }
        throttle.recordSuccess(pass.subject, 'anomalies.resolve')
      } catch (err) {
        response = errorResponse(err)
        throttle.recordFailure(pass.subject, 'anomalies.resolve')
      } finally {
        concurrency.release()
      }

      idempotency.complete(pass.subject, 'anomalies.resolve', pass.idempotencyKey, response)
      ctx.audit.append({
        reqId: req.id,
        event: response.status === 200 ? 'action.ok' : 'action.error',
        sourceIp: req.ip,
        subject: pass.subject,
        detail: {
          action: 'anomalies.resolve',
          tenantId: t.id,
          anomalyId: params.id,
          idempotencyKey: pass.idempotencyKey,
          status: response.status,
        },
      })
      reply
        .code(response.status)
        .type('application/json')
        .header('Cache-Control', 'private, no-store')
        .send(response.body)
      return reply
    },
  )

  // ---------- POST /reconciler/run-once ----------
  app.post(
    '/api/v1/tenants/:tid/reconciler/run-once',
    {
      schema: { body: RUN_ONCE_BODY_SCHEMA },
      bodyLimit: ACTION_BODY_LIMIT,
      onRequest: contentTypeGuard(ctx.audit, 'reconciler.run-once'),
    },
    async (req, reply) => {
      const params = req.params as { tid?: string }
      const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
      if (t === null) return reply

      const pass = await runGate(req, reply, {
        actionId: 'reconciler.run-once',
        grants,
        throttle,
        idempotency,
        concurrency,
        executorFactory,
        audit: ctx.audit,
        ...(ctx.maxSessionAgeMs !== undefined ? { maxSessionAgeMs: ctx.maxSessionAgeMs } : {}),
        ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      })
      if (pass === null) return reply

      const body = (req.body as { fullSweep?: boolean }) ?? {}
      const fullSweep = body.fullSweep === true
      const startedAt = new Date()
      let response: CachedResponse
      try {
        const executor = await (executorFactory as ActionExecutorFactory)()
        const result = await executor.runReconciler({
          tenantId: t.id,
          fullSweep,
        })
        response = {
          status: 200,
          body: { ok: true, ...result },
        }
        ctx.runsBuffer?.append({
          tenantId: t.id, subject: pass.subject,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: result.durationMs,
          fullSweep,
          anomalies: result.anomalies,
          quarantined: result.quarantined,
          status: 'ok',
          errorMessage: null,
        })
        throttle.recordSuccess(pass.subject, 'reconciler.run-once')
      } catch (err) {
        response = errorResponse(err)
        ctx.runsBuffer?.append({
          tenantId: t.id, subject: pass.subject,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          fullSweep,
          anomalies: 0, quarantined: 0,
          status: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
        })
        throttle.recordFailure(pass.subject, 'reconciler.run-once')
      } finally {
        concurrency.release()
      }

      idempotency.complete(pass.subject, 'reconciler.run-once', pass.idempotencyKey, response)
      ctx.audit.append({
        reqId: req.id,
        event: response.status === 200 ? 'action.ok' : 'action.error',
        sourceIp: req.ip,
        subject: pass.subject,
        detail: {
          action: 'reconciler.run-once',
          tenantId: t.id,
          idempotencyKey: pass.idempotencyKey,
          status: response.status,
          fullSweep: body.fullSweep === true,
        },
      })
      reply
        .code(response.status)
        .type('application/json')
        .header('Cache-Control', 'private, no-store')
        .send(response.body)
      return reply
    },
  )
}

const ALLOWED_CONTENT_TYPES = new Set([
  'application/json',
  'application/json; charset=utf-8',
  'application/json;charset=utf-8',
])

/**
 * Run *before* Fastify's body parser so a stray `text/plain` POST gets
 * a clean 415 (matching §9.2 gate 7) rather than a 400 from the parser.
 */
function contentTypeGuard(audit: AuditLog, actionId: ActionId): (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void> {
  return async (req, reply) => {
    const raw = req.headers['content-type']
    const ct = (typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw[0] ?? '') : '')
      .toLowerCase()
      .trim()
    if (ct === '' || !ALLOWED_CONTENT_TYPES.has(ct)) {
      audit.append({
        reqId: req.id,
        event: 'action.deny',
        sourceIp: req.ip,
        ...(req.session?.subject !== undefined ? { subject: req.session.subject } : {}),
        detail: { action: actionId, gate: 'content-type', value: ct || null },
      })
      problem(reply, 415, 'unsupported-media-type', 'expected application/json')
    }
  }
}

function errorResponse(err: unknown): CachedResponse {
  if (err instanceof ActionPreconditionError) {
    return {
      status: 409,
      body: {
        type: `https://loki.dev/problems/${err.slug}`,
        title: 'Conflict',
        status: 409,
      },
    }
  }
  return {
    status: 500,
    body: {
      type: 'https://loki.dev/problems/internal',
      title: 'Internal Server Error',
      status: 500,
    },
  }
}

export type { ActionId, ActionGrants, ActionRateLimit, ActionsConfig } from './types.js'
