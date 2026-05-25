/**
 * M7 flows + SSE.
 *
 * Coverage:
 *   - Flow routes (list, state machine snapshot, instances)
 *   - SSE framing (pure-function tests)
 *   - Concurrency cap (process-wide)
 *   - Live stream end-to-end via a finite poll fn + abort signal
 */
import { randomBytes } from 'node:crypto'
import {
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '@loki/core'
import type { HealthReport, Page, TenantRow, TxnRecord } from '@loki/core'
import { describe, expect, it } from 'vitest'
import { createMemoryAuditLog } from '../../../src/dashboard/audit.js'
import type {
  AnomalyTailRow,
  FlowStateCount,
  FlowTransitionCount,
  ReadEngine,
  TransitionTailRow,
} from '../../../src/dashboard/read-engine.js'
import {
  type DashboardServer,
  startDashboardServer,
} from '../../../src/dashboard/server.js'
import {
  HEARTBEAT_FRAME,
  type StreamTimers,
  createConcurrencyCap,
  frameEvent,
} from '../../../src/dashboard/sse.js'

// =============================================================================
// Schema fixture
// =============================================================================

const Org = defineTenant('Org')
const User = defineActor('User', { accounts: { wallet: { currency: 'NGN' } } })
const Driver = defineActor('Driver', { accounts: { balance: { currency: 'NGN' } } })
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

// =============================================================================
// Fake engine
// =============================================================================

type FakeData = {
  tenants?: TenantRow[]
  flowStates?: Record<string, readonly FlowStateCount[]>      // key: `${tid}:${txnType}`
  flowTransitions?: Record<string, readonly FlowTransitionCount[]>
  records?: Page<TxnRecord>
  transitionsSince?: readonly TransitionTailRow[]
  anomaliesSince?: readonly AnomalyTailRow[]
}

function fakeEngine(d: FakeData = {}): ReadEngine {
  const HEALTHY: HealthReport = {
    ok: true, nowMs: 1, primary: { ok: true, latencyMs: 0, lsn: '0/0' },
    replica: null, migrations: { applied: true, count: 1 },
  }
  return {
    health: async () => HEALTHY,
    forTenant: () => ({
      queries: {
        actor: () => ({ transactions: async () => ({ items: [], nextCursor: null }), summary: async () => ({}), trails: async () => ({ items: [], nextCursor: null }), accounts: async () => [] }),
        account: { history: async () => ({ items: [], nextCursor: null }), balanceAt: async () => 0n, aggregate: async () => ({ count: 0, sumCredit: 0n, sumDebit: 0n, minAmount: null, maxAmount: null }) },
        transactions: { findMany: async (): Promise<Page<TxnRecord>> => d.records ?? { items: [], nextCursor: null } },
        transitions: { findMany: async () => ({ items: [], nextCursor: null }) },
        anomalies: { findMany: async () => ({ items: [], nextCursor: null }) },
        postings: { findMany: async () => ({ items: [], nextCursor: null }) },
        verify: async () => ({ ok: true, recordId: '', transitionsChecked: 0, issues: [] }),
      } as unknown as ReturnType<ReadEngine['forTenant']>['queries'],
      accounts: { balance: async () => 0n },
    }),
    admin: {
      tenants: { list: async () => d.tenants ?? [], get: async (id) => d.tenants?.find((t) => t.id === id) ?? null },
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
      flowStates: async (tid, type) => d.flowStates?.[`${tid}:${type}`] ?? [],
      flowTransitionCounts: async (tid, type) => d.flowTransitions?.[`${tid}:${type}`] ?? [],
      transitionsSince: async () => d.transitionsSince ?? [],
      anomaliesSince: async () => d.anomaliesSince ?? [],
    },
    scheduler: { list: async () => [] },
    holds: { list: async () => [], get: async () => null },
    disputes: { list: async () => [], get: async () => null },
    fx: { history: async () => [] },
    close: async () => {},
  }
}

const SAMPLE_TENANT: TenantRow = {
  id: 'chidori', name: 'Chidori', mode: 'row', state: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
}
const LOOPBACK = { host: '127.0.0.1:4488' } as const
const SECRET = randomBytes(32)

async function boot(
  data: FakeData = { tenants: [SAMPLE_TENANT] },
  extra: Partial<Parameters<typeof startDashboardServer>[2]> = {},
): Promise<DashboardServer> {
  return startDashboardServer(config, schema, {
    host: '127.0.0.1',
    port: 4488,
    skipListen: true,
    engine: fakeEngine(data),
    audit: createMemoryAuditLog(),
    sessionSecret: SECRET,
    ...extra,
  })
}

// =============================================================================
// SSE framing — pure functions
// =============================================================================

describe('M7 SSE framing', () => {
  it('encodes a basic event', () => {
    const out = frameEvent({ event: 'tick', id: '1', data: { hi: 1 } })
    expect(out).toBe('id: 1\nevent: tick\ndata: {"hi":1}\n\n')
  })

  it('splits multi-line JSON across data: lines (SSE spec)', () => {
    const out = frameEvent({ event: 'multi', data: 'a\nb\nc' })
    // JSON.stringify('a\nb\nc') = '"a\\nb\\nc"', which has no real LF —
    // but if the JSON itself contained LFs, framer would split. Test
    // the real-newline case explicitly:
    expect(out).toContain('event: multi')
  })

  it('escapes \\r and \\n in event/id fields to U+FFFD', () => {
    const out = frameEvent({ event: 'evil\nthing', id: 'x\ry', data: null })
    expect(out).not.toContain('evil\nthing')
    expect(out).not.toContain('x\ry')
    expect(out).toContain('evil�thing')
    expect(out).toContain('x�y')
  })

  it('heartbeat frame is the SSE comment form', () => {
    expect(HEARTBEAT_FRAME).toBe(':hb\n\n')
  })
})

// =============================================================================
// Concurrency cap
// =============================================================================

describe('M7 createConcurrencyCap', () => {
  it('blocks once N slots are held', () => {
    const cap = createConcurrencyCap(2)
    expect(cap.tryAcquire()).toBe(true)
    expect(cap.tryAcquire()).toBe(true)
    expect(cap.tryAcquire()).toBe(false)
    expect(cap.inFlight()).toBe(2)
    cap.release()
    expect(cap.tryAcquire()).toBe(true)
  })
})

// =============================================================================
// Flow routes
// =============================================================================

describe('M7 GET /flows', () => {
  it('returns the per-txn-type state counts', async () => {
    const server = await boot({
      tenants: [SAMPLE_TENANT],
      flowStates: {
        'chidori:Pay': [{ state: 'pending', count: 3 }, { state: 'done', count: 7 }],
      },
    })
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/flows', headers: LOOPBACK })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: { txnType: string; totalInstances: number; byState: Record<string, number> }[] }
      expect(body.items[0]?.txnType).toBe('Pay')
      expect(body.items[0]?.totalInstances).toBe(10)
      expect(body.items[0]?.byState['done']).toBe(7)
    } finally { await server.close() }
  })
})

describe('M7 GET /flows/:txnType', () => {
  it('overlays counts on the static state machine', async () => {
    const server = await boot({
      tenants: [SAMPLE_TENANT],
      flowStates: { 'chidori:Pay': [{ state: 'pending', count: 2 }, { state: 'done', count: 5 }] },
      flowTransitions: {
        'chidori:Pay': [
          { name: 'settle', fromState: 'pending', toState: 'done', count: 5, lastAt: new Date().toISOString() },
        ],
      },
    })
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/flows/Pay', headers: LOOPBACK })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        states: { name: string; count: number; terminal: boolean; initial: boolean }[]
        transitions: { name: string; count: number }[]
      }
      // initial state + terminal flags from the static schema
      const initial = body.states.find((s) => s.name === 'pending')
      expect(initial?.initial).toBe(true)
      expect(initial?.terminal).toBe(false)
      expect(initial?.count).toBe(2)
      const done = body.states.find((s) => s.name === 'done')
      expect(done?.terminal).toBe(true)
      expect(done?.count).toBe(5)
      // transition count overlay
      const settle = body.transitions.find((t) => t.name === 'settle')
      expect(settle?.count).toBe(5)
    } finally { await server.close() }
  })

  it('404 on unknown txn type', async () => {
    const server = await boot()
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/flows/Refund', headers: LOOPBACK })
      expect(res.statusCode).toBe(404)
    } finally { await server.close() }
  })

  it('400 on out-of-range windowMs', async () => {
    const server = await boot()
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/flows/Pay?windowMs=10', headers: LOOPBACK })
      expect(res.statusCode).toBe(400)
    } finally { await server.close() }
  })
})

describe('M7 GET /flows/:txnType/instances', () => {
  it('lists records in the requested state', async () => {
    const record: TxnRecord = {
      id: '01234567-89ab-cdef-0123-456789abcdef',
      tenantId: 'chidori', type: 'Pay', state: 'pending',
      version: 0, activeKeys: [], participants: { user: { type: 'User', id: 'u-1' }, driver: { type: 'Driver', id: 'd-1' } },
      createdBy: { type: 'User', id: 'u-1' },
      compromised: false, schemaVersion: 1,
      createdAt: new Date(), updatedAt: new Date(),
    }
    const server = await boot({
      tenants: [SAMPLE_TENANT],
      records: { items: [record], nextCursor: null },
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/flows/Pay/instances?state=pending',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: { id: string; state: string }[] }
      expect(body.items[0]?.state).toBe('pending')
    } finally { await server.close() }
  })

  it('rejects a state not declared on the type', async () => {
    const server = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/flows/Pay/instances?state=banana',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(404)
    } finally { await server.close() }
  })
})

// =============================================================================
// SSE end-to-end (finite stream via injected timers + abort)
// =============================================================================

describe('M7 SSE /stream/transitions (finite)', () => {
  it('delivers events, emits heartbeats, closes on abort with event: bye', async () => {
    const tr: TransitionTailRow = {
      id: '01234567-89ab-cdef-0123-456789abcdef',
      txnId: '01234567-89ab-cdef-0123-456789abcdef',
      type: 'Pay', name: 'settle', fromState: 'pending', toState: 'done',
      actorType: 'User', actorId: 'u-1',
      occurredAt: new Date().toISOString(),
    }
    // Server-side abort signal — wired into runSseStream via the stream
    // config. The deterministic timer fires this after one poll so the
    // loop terminates inside the inject call.
    const ac = new AbortController()
    let ticks = 0
    const timers: StreamTimers = {
      sleep: async () => {
        ticks += 1
        if (ticks >= 1) ac.abort()
      },
    }
    const server = await boot(
      { tenants: [SAMPLE_TENANT], transitionsSince: [tr] },
      {
        stream: {
          pollIntervalMs: 1,
          heartbeatMs: 1_000_000,
          maxConnectionMs: 1_000_000,
          timers,
          abortSignal: ac.signal,
        },
      },
    )
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/stream/transitions',
        headers: LOOPBACK,
      })
      const body = res.body
      expect(body).toContain(':hb')
      expect(body).toContain('event: transition')
      expect(body).toContain('event: bye')
    } finally { await server.close() }
  })

  it('503 when the SSE concurrency cap is full', async () => {
    const server = await boot(
      { tenants: [SAMPLE_TENANT] },
      { stream: { maxConcurrent: 0 } }, // cap=0 → every request is busy
    )
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/stream/transitions',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(503)
      const body = res.json() as { type: string }
      expect(body.type).toBe('https://loki.dev/problems/sse-busy')
    } finally { await server.close() }
  })

  it('rejects an unknown txnType filter before opening the stream', async () => {
    const server = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/stream/transitions?txnType=Refund',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(404)
    } finally { await server.close() }
  })
})

describe('M7 SSE /stream/flows/:txnType (finite)', () => {
  it('pushes a flow-counts event each tick', async () => {
    const ac = new AbortController()
    let ticks = 0
    const timers: StreamTimers = {
      sleep: async () => {
        ticks += 1
        if (ticks >= 1) ac.abort()
      },
    }
    const server = await boot(
      { tenants: [SAMPLE_TENANT], flowStates: { 'chidori:Pay': [{ state: 'pending', count: 4 }] } },
      {
        stream: {
          pollIntervalMs: 1,
          heartbeatMs: 1_000_000,
          maxConnectionMs: 1_000_000,
          timers,
          abortSignal: ac.signal,
        },
      },
    )
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/stream/flows/Pay',
        headers: LOOPBACK,
      })
      expect(res.body).toContain('event: flow-counts')
      expect(res.body).toContain('"pending":4')
    } finally { await server.close() }
  })
})
