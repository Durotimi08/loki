/**
 * Streaming routes — DASHBOARD.md §6.11.
 *
 *   GET /api/v1/tenants/:tid/stream/transitions?txnType=&since=
 *   GET /api/v1/tenants/:tid/stream/flows/:txnType
 *   GET /api/v1/tenants/:tid/stream/anomalies?severity=
 *   GET /api/v1/tenants/:tid/stream/reconciler
 *
 * Each is a server-polled loop (see `dashboard/sse.ts`). Concurrency is
 * bounded process-wide; refusals return `503 Service Unavailable`.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { SchemaDef } from '@loki/core'
import type { AuditLog } from '../audit.js'
import type { ReadEngine, StreamWatermark } from '../read-engine.js'
import * as v from '../security/validation.js'
import {
  type SessionScopedCap,
  type SseEvent,
  type StreamTimers,
  runSseStream,
} from '../sse.js'
import { problem, resolveTenant } from './helpers.js'

export type StreamsRouteContext = {
  readonly engine: ReadEngine
  readonly schema: SchemaDef
  readonly tenants: 'all' | readonly string[]
  readonly audit: AuditLog
  /** Two-tier cap on concurrent SSE connections (process + per-session). */
  readonly concurrency: SessionScopedCap
  /** Default 2_000 ms, overridable for tests. */
  readonly pollIntervalMs?: number
  readonly heartbeatMs?: number
  readonly maxConnectionMs?: number
  /** Inject `setTimeout`-like sleep for tests. */
  readonly timers?: StreamTimers
  /**
   * Test-only escape hatch: every stream listens on this signal in
   * addition to the request socket. Aborting it terminates every
   * open stream — useful in `app.inject` tests where no real socket
   * close event fires.
   */
  readonly abortSignal?: AbortSignal
}

const MAX_PER_TICK = 200

export function registerStreamRoutes(app: FastifyInstance, ctx: StreamsRouteContext): void {
  registerTransitionStream(app, ctx)
  registerFlowsStream(app, ctx)
  registerAnomaliesStream(app, ctx)
  registerReconcilerStream(app, ctx)
}

// =============================================================================
// /stream/transitions
// =============================================================================

type TransitionState = { watermark: StreamWatermark }

function registerTransitionStream(app: FastifyInstance, ctx: StreamsRouteContext): void {
  app.get('/api/v1/tenants/:tid/stream/transitions', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply

    const q = req.query as Record<string, string | undefined>
    let txnType: string | undefined
    if (q['txnType'] !== undefined) {
      const r = v.txnType(q['txnType'], ctx.schema)
      if (!r.ok) return problem(reply, 404, 'unknown-txn-type', r.reason)
      txnType = r.value
    }

    const key = claim(ctx, req, reply)
    if (key === null) return reply

    try {
      await runSseStream<TransitionState>(req, reply, {
        ...streamBase(ctx, 'transitions', t.id),
        initialState: { watermark: null },
        poll: async (state) => {
          const rows = await ctx.engine.dashboard.transitionsSince(t.id, {
            since: state.watermark,
            limit: MAX_PER_TICK,
            ...(txnType !== undefined ? { txnType } : {}),
          })
          const last = rows[rows.length - 1]
          const events: SseEvent[] = rows.map((r) => ({
            event: 'transition',
            id: r.id,
            data: r,
          }))
          return {
            events,
            nextState: {
              watermark: last !== undefined
                ? { occurredAt: last.occurredAt, id: last.id }
                : state.watermark,
            },
          }
        },
      })
    } finally {
      ctx.concurrency.release(key)
    }
    return reply
  })
}

// =============================================================================
// /stream/flows/:txnType
// =============================================================================

function registerFlowsStream(app: FastifyInstance, ctx: StreamsRouteContext): void {
  app.get('/api/v1/tenants/:tid/stream/flows/:txnType', async (req, reply) => {
    const params = req.params as { tid?: string; txnType?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    const tt = v.txnType(params.txnType, ctx.schema)
    if (!tt.ok) return problem(reply, 404, 'unknown-txn-type', tt.reason)

    const key = claim(ctx, req, reply)
    if (key === null) return reply
    try {
      await runSseStream<{ tick: number }>(req, reply, {
        ...streamBase(ctx, `flows:${tt.value}`, t.id),
        initialState: { tick: 0 },
        poll: async (state) => {
          const counts = await ctx.engine.dashboard.flowStates(t.id, tt.value)
          const total = counts.reduce((acc, c) => acc + c.count, 0)
          return {
            events: [
              {
                event: 'flow-counts',
                data: {
                  txnType: tt.value,
                  total,
                  byState: Object.fromEntries(counts.map((c) => [c.state, c.count])),
                },
              },
            ],
            nextState: { tick: state.tick + 1 },
          }
        },
      })
    } finally {
      ctx.concurrency.release(key)
    }
    return reply
  })
}

// =============================================================================
// /stream/anomalies
// =============================================================================

function registerAnomaliesStream(app: FastifyInstance, ctx: StreamsRouteContext): void {
  app.get('/api/v1/tenants/:tid/stream/anomalies', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply

    const q = req.query as Record<string, string | undefined>
    let sev: 'warn' | 'error' | 'critical' | undefined
    if (q['severity'] !== undefined) {
      const r = v.severity(q['severity'])
      if (!r.ok) return problem(reply, 400, 'bad-severity', r.reason)
      sev = r.value
    }

    const key = claim(ctx, req, reply)
    if (key === null) return reply
    try {
      await runSseStream<{ watermark: StreamWatermark }>(req, reply, {
        ...streamBase(ctx, 'anomalies', t.id),
        initialState: { watermark: null },
        poll: async (state) => {
          const rows = await ctx.engine.dashboard.anomaliesSince(t.id, {
            since: state.watermark,
            limit: MAX_PER_TICK,
            ...(sev !== undefined ? { severity: sev } : {}),
          })
          const last = rows[rows.length - 1]
          return {
            events: rows.map((r) => ({ event: 'anomaly', id: r.id, data: r })),
            nextState: {
              watermark: last !== undefined
                ? { occurredAt: last.detectedAt, id: last.id }
                : state.watermark,
            },
          }
        },
      })
    } finally {
      ctx.concurrency.release(key)
    }
    return reply
  })
}

// =============================================================================
// /stream/reconciler
// =============================================================================

function registerReconcilerStream(app: FastifyInstance, ctx: StreamsRouteContext): void {
  app.get('/api/v1/tenants/:tid/stream/reconciler', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply

    const key = claim(ctx, req, reply)
    if (key === null) return reply
    try {
      await runSseStream<{ lastFingerprint: string }>(req, reply, {
        ...streamBase(ctx, 'reconciler', t.id),
        initialState: { lastFingerprint: '' },
        poll: async (state) => {
          const items = await ctx.engine.dashboard.reconcilerState(t.id)
          const fingerprint = JSON.stringify(items)
          if (fingerprint === state.lastFingerprint) {
            return { events: [], nextState: state }
          }
          return {
            events: [{ event: 'reconciler-state', data: { items } }],
            nextState: { lastFingerprint: fingerprint },
          }
        },
      })
    } finally {
      ctx.concurrency.release(key)
    }
    return reply
  })
}

// =============================================================================
// Shared helpers
// =============================================================================

function sessionKey(req: { session?: { sid?: string } | null; ip: string }): string {
  // Authenticated → use the rotating session id (M3 §8.5). Anonymous /
  // bearer (sid: 'stateless') → fall back to the source IP.
  const sid = req.session?.sid
  if (typeof sid === 'string' && sid.length > 0 && sid !== 'stateless' && sid !== 'anon') {
    return `sid:${sid}`
  }
  return `ip:${req.ip}`
}

function claim(
  ctx: StreamsRouteContext,
  req: { session?: { sid?: string } | null; ip: string },
  reply: FastifyReply,
): string | null {
  const key = sessionKey(req)
  if (ctx.concurrency.tryAcquire(key)) return key
  ctx.audit.append({
    reqId: 'sse',
    event: 'stream.busy',
    detail: {
      globalInFlight: ctx.concurrency.globalInFlight(),
      perKeyInFlight: ctx.concurrency.perKeyInFlight(key),
    },
  })
  problem(reply, 503, 'sse-busy', 'too many concurrent streams; try again shortly')
  return null
}

function streamBase(
  ctx: StreamsRouteContext,
  name: string,
  tenantId: string,
): Pick<
  Parameters<typeof runSseStream>[2],
  | 'audit'
  | 'streamName'
  | 'tenantId'
  | 'pollIntervalMs'
  | 'heartbeatMs'
  | 'maxConnectionMs'
  | 'timers'
  | 'abortSignal'
> {
  return {
    audit: ctx.audit,
    streamName: name,
    tenantId,
    ...(ctx.pollIntervalMs !== undefined ? { pollIntervalMs: ctx.pollIntervalMs } : {}),
    ...(ctx.heartbeatMs !== undefined ? { heartbeatMs: ctx.heartbeatMs } : {}),
    ...(ctx.maxConnectionMs !== undefined ? { maxConnectionMs: ctx.maxConnectionMs } : {}),
    ...(ctx.timers !== undefined ? { timers: ctx.timers } : {}),
    ...(ctx.abortSignal !== undefined ? { abortSignal: ctx.abortSignal } : {}),
  }
}
