/**
 * M9 polish — schema-description snapshot, observability hooks,
 * --open CLI parsing.
 */
import { randomBytes } from 'node:crypto'
import {
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '@loki/core'
import type {
  Counter,
  Gauge,
  HealthReport,
  Histogram,
  LogFields,
  Logger,
  MetricLabels,
  MetricsAdapter,
  Span,
  TenantRow,
  Tracer,
} from '@loki/core'
import { describe, expect, it } from 'vitest'
import { createMemoryAuditLog } from '../../../src/dashboard/audit.js'
import type { ReadEngine } from '../../../src/dashboard/read-engine.js'
import { describeSchema } from '../../../src/dashboard/schema-fingerprint.js'
import {
  type DashboardServer,
  startDashboardServer,
} from '../../../src/dashboard/server.js'
import { parseDashboardArgs } from '../../../src/commands/dashboard.js'

// =============================================================================
// Fixture
// =============================================================================

const Org = defineTenant('Org')
const User = defineActor('User', { accounts: { wallet: { currency: 'NGN' } } })
const Driver = defineActor('Driver', { accounts: { balance: { currency: 'USD' } } })
const Pay = defineTransaction('Pay', {
  states: ['pending', 'done', 'failed'],
  initial: 'pending',
  terminal: ['done', 'failed'],
  participants: { user: User, driver: Driver },
  transitions: (t) => ({
    settle: t({ from: 'pending', to: 'done', by: [User] }),
    fail: t({ from: 'pending', to: 'failed', by: [User] }),
  }),
})
const schema = defineSchema({ tenant: Org, actors: [User, Driver], transactions: [Pay] })
const config = { schema, connection: { url: 'postgres://x:x@localhost:1/x' } } as const
const HEALTHY: HealthReport = {
  ok: true, nowMs: 1, primary: { ok: true, latencyMs: 0, lsn: '0/0' },
  replica: null, migrations: { applied: true, count: 1 },
}
const SAMPLE_TENANT: TenantRow = {
  id: 'chidori', name: 'Chidori', mode: 'row', state: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
}
const LOOPBACK = { host: '127.0.0.1:4488' } as const
const SECRET = randomBytes(32)

function fakeEngine(): ReadEngine {
  return {
    health: async () => HEALTHY,
    forTenant: () => ({
      queries: {} as ReturnType<ReadEngine['forTenant']>['queries'],
      accounts: { balance: async () => 0n },
    }),
    admin: {
      tenants: { list: async () => [SAMPLE_TENANT], get: async (id) => id === 'chidori' ? SAMPLE_TENANT : null },
      schema: { versions: (async () => []) as ReadEngine['admin']['schema']['versions'] },
    },
    decryptPayload: async (v) => v,
    dashboard: {
      tenantSummary: async () => ({ id: '', records: 0, transitions: 0, accounts: 0, compromised: 0, openAnomalies: 0, outbox: { pending: 0, inflight: 0, terminal: 0 }, scheduler: { scheduled: 0, due: 0 } }),
      actorIds: async () => ({ items: [], nextCursor: null }),
      actorAccounts: async () => [],
      txnRecord: async () => null,
      txnPostings: async () => ({ items: [], nextCursor: null }),
      txnKeys: async () => [],
      anomalyGet: async () => null,
      outboxList: async () => ({ items: [], nextCursor: null }),
      outboxGet: async () => null,
      scheduledGet: async () => null,
      reconcilerState: async () => [],
      flowStates: async () => [],
      flowTransitionCounts: async () => [],
      transitionsSince: async () => [],
      anomaliesSince: async () => [],
    },
    scheduler: { list: async () => [] },
    holds: { list: async () => [], get: async () => null },
    disputes: { list: async () => [], get: async () => null },
    fx: { history: async () => [] },
    close: async () => {},
  }
}

// =============================================================================
// Schema fingerprint snapshot
// =============================================================================

describe('M9 schema description snapshot', () => {
  it('returns a stable structural projection of the schema', () => {
    expect(describeSchema(schema)).toMatchInlineSnapshot(`
      {
        "actors": [
          {
            "accounts": [
              {
                "allowOverdraft": false,
                "currency": "USD",
                "name": "balance",
                "shards": 1,
              },
            ],
            "name": "Driver",
          },
          {
            "accounts": [
              {
                "allowOverdraft": false,
                "currency": "NGN",
                "name": "wallet",
                "shards": 1,
              },
            ],
            "name": "User",
          },
        ],
        "projections": [],
        "tenant": "Org",
        "transactions": [
          {
            "initial": "pending",
            "name": "Pay",
            "states": [
              "pending",
              "done",
              "failed",
            ],
            "terminal": [
              "done",
              "failed",
            ],
            "transitions": [
              "fail",
              "settle",
            ],
          },
        ],
        "version": 1,
      }
    `)
  })
})

// =============================================================================
// Observability hooks
// =============================================================================

function makeMetrics(): { adapter: MetricsAdapter; calls: { counter: Record<string, { value: number; labels: MetricLabels }[]>, histogram: Record<string, { value: number; labels: MetricLabels }[]>, gauge: Record<string, number[]> } } {
  const counterCalls: Record<string, { value: number; labels: MetricLabels }[]> = {}
  const histogramCalls: Record<string, { value: number; labels: MetricLabels }[]> = {}
  const gaugeCalls: Record<string, number[]> = {}
  return {
    calls: { counter: counterCalls, histogram: histogramCalls, gauge: gaugeCalls },
    adapter: {
      counter: (name): Counter => ({
        inc(value = 1, labels = {}) {
          ;(counterCalls[name] ??= []).push({ value, labels })
        },
      }),
      histogram: (name): Histogram => ({
        observe(value, labels = {}) {
          ;(histogramCalls[name] ??= []).push({ value, labels })
        },
      }),
      gauge: (name): Gauge => ({
        set(value) { (gaugeCalls[name] ??= []).push(value) },
        inc(value = 1) { (gaugeCalls[name] ??= []).push(value) },
        dec(value = 1) { (gaugeCalls[name] ??= []).push(-value) },
      }),
    },
  }
}

function makeTracer(): { tracer: Tracer; spans: { name: string; ended: boolean; status: string | null; attrs: Record<string, unknown> }[] } {
  const spans: { name: string; ended: boolean; status: string | null; attrs: Record<string, unknown> }[] = []
  return {
    spans,
    tracer: {
      startSpan(name): Span {
        const record = { name, ended: false, status: null as string | null, attrs: {} as Record<string, unknown> }
        spans.push(record)
        return {
          setAttribute(k, v) { record.attrs[k] = v },
          setStatus(s) { record.status = s },
          recordException() {},
          end() { record.ended = true },
        }
      },
    },
  }
}

function makeLogger(): { logger: Logger; events: { level: string; msg: string; fields: LogFields }[] } {
  const events: { level: string; msg: string; fields: LogFields }[] = []
  const log = (level: string) => (msg: string, fields: LogFields = {}) => {
    events.push({ level, msg, fields })
  }
  return {
    events,
    logger: {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      child: () => ({}) as Logger,
    },
  }
}

async function bootObservable(): Promise<{
  server: DashboardServer
  metrics: ReturnType<typeof makeMetrics>
  tracer: ReturnType<typeof makeTracer>
  logger: ReturnType<typeof makeLogger>
}> {
  const metrics = makeMetrics()
  const tracer = makeTracer()
  const logger = makeLogger()
  const server = await startDashboardServer(config, schema, {
    host: '127.0.0.1',
    port: 4488,
    skipListen: true,
    engine: fakeEngine(),
    audit: createMemoryAuditLog(),
    sessionSecret: SECRET,
    metrics: metrics.adapter,
    tracer: tracer.tracer,
    logger: logger.logger,
  })
  return { server, metrics, tracer, logger }
}

describe('M9 observability hooks', () => {
  it('records counter + histogram + span + log per request', async () => {
    const { server, metrics, tracer, logger } = await bootObservable()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)

      const counterEntries = metrics.calls.counter['loki_dashboard_requests_total']
      expect(counterEntries).toBeDefined()
      expect(counterEntries?.[0]?.labels['status']).toBe(200)
      expect(counterEntries?.[0]?.labels['method']).toBe('GET')
      expect(counterEntries?.[0]?.labels['route']).toBe('/api/v1/version')

      const histogramEntries = metrics.calls.histogram['loki_dashboard_request_duration_seconds']
      expect(histogramEntries).toBeDefined()
      expect(histogramEntries?.[0]?.value).toBeGreaterThanOrEqual(0)

      // One span, ended, status ok.
      expect(tracer.spans).toHaveLength(1)
      expect(tracer.spans[0]?.name).toBe('dashboard.request')
      expect(tracer.spans[0]?.ended).toBe(true)
      expect(tracer.spans[0]?.status).toBe('ok')
      expect(tracer.spans[0]?.attrs['status']).toBe(200)

      // info-level log on 200.
      const infoEvents = logger.events.filter((e) => e.level === 'info' && e.msg === 'dashboard request')
      expect(infoEvents).toHaveLength(1)
      expect(infoEvents[0]?.fields['status']).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('logs at error level on 5xx and sets span status=error', async () => {
    const { server, tracer, logger } = await bootObservable()
    try {
      // Synthetic 500 via a route that throws.
      server.app.get('/_/boom', async () => {
        throw new Error('boom')
      })
      const res = await server.app.inject({ method: 'GET', url: '/_/boom', headers: LOOPBACK })
      expect(res.statusCode).toBe(500)
      const errorEvents = logger.events.filter((e) => e.level === 'error')
      expect(errorEvents.length).toBeGreaterThan(0)
      expect(tracer.spans.some((s) => s.status === 'error')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('logs at warn level on 4xx', async () => {
    const { server, logger } = await bootObservable()
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/version', headers: { host: 'evil.example' } })
      expect(res.statusCode).toBe(421)
      const warnEvents = logger.events.filter((e) => e.level === 'warn' && e.msg === 'dashboard request')
      expect(warnEvents).toHaveLength(1)
      expect(warnEvents[0]?.fields['status']).toBe(421)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// --open CLI parsing
// =============================================================================

describe('M9 --open arg', () => {
  it('sets open=true when --open is passed', () => {
    const out = parseDashboardArgs(['--open'])
    if ('error' in out) throw new Error(out.error)
    expect(out.open).toBe(true)
  })

  it('omits open when the flag is absent', () => {
    const out = parseDashboardArgs([])
    if ('error' in out) throw new Error(out.error)
    expect(out.open).toBeUndefined()
  })
})
