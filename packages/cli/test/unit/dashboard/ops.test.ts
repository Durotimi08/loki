/**
 * M6 operational routes — anomalies, reconciler, outbox, scheduler,
 * holds, disputes, fx.
 *
 * Fake engine returns canned data for each surface; tests assert the
 * route boundary (validation, cursor signing, redaction).
 */
import { randomBytes } from 'node:crypto'
import {
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '@loki/core'
import type {
  AnomalyRow,
  Dispute,
  FxRate,
  HealthReport,
  Hold,
  Page,
  ScheduledTransition,
  TenantRow,
} from '@loki/core'
import { describe, expect, it } from 'vitest'
import { createMemoryAuditLog } from '../../../src/dashboard/audit.js'
import { defaultProdRedactor } from '../../../src/dashboard/redact.js'
import type {
  OutboxRow,
  ReadEngine,
  ReconcilerWatermark,
} from '../../../src/dashboard/read-engine.js'
import {
  type DashboardServer,
  startDashboardServer,
} from '../../../src/dashboard/server.js'

// =============================================================================
// Schema fixture
// =============================================================================

const Org = defineTenant('Org')
const User = defineActor('User', { accounts: { wallet: { currency: 'NGN' } } })
const Driver = defineActor('Driver', { accounts: { balance: { currency: 'USD' } } })
const Pay = defineTransaction('Pay', {
  states: ['pending', 'done'],
  initial: 'pending',
  terminal: ['done'],
  participants: { user: User, driver: Driver },
  transitions: (t) => ({ finish: t({ from: 'pending', to: 'done', by: [User] }) }),
})
const schema = defineSchema({ tenant: Org, actors: [User, Driver], transactions: [Pay] })
const config = { schema, connection: { url: 'postgres://x:x@localhost:1/x' } } as const

// =============================================================================
// Fake engine
// =============================================================================

type FakeData = {
  tenants?: TenantRow[]
  anomaliesPage?: Page<AnomalyRow>
  anomalyDetail?: Record<string, AnomalyRow>      // key = `${tid}:${id}`
  reconcilerState?: Record<string, readonly ReconcilerWatermark[]>
  outboxPage?: Record<string, { items: readonly OutboxRow[]; nextCursor: string | null }>
  outboxDetail?: Record<string, OutboxRow>
  scheduled?: readonly ScheduledTransition[]
  scheduledDetail?: Record<string, ScheduledTransition>
  holds?: readonly Hold[]
  holdDetail?: Record<string, Hold>
  disputes?: readonly Dispute[]
  disputeDetail?: Record<string, Dispute>
  fxHistory?: readonly FxRate[]
}

function fakeEngine(d: FakeData = {}): ReadEngine {
  const HEALTHY: HealthReport = {
    ok: true,
    nowMs: 1_000_000,
    primary: { ok: true, latencyMs: 4, lsn: '0/0' },
    replica: null,
    migrations: { applied: true, count: 1 },
  }
  return {
    health: async () => HEALTHY,
    forTenant: () => ({
      queries: {
        actor: () => ({ transactions: async () => ({ items: [], nextCursor: null }), summary: async () => ({}), trails: async () => ({ items: [], nextCursor: null }), accounts: async () => [] }),
        account: { history: async () => ({ items: [], nextCursor: null }), balanceAt: async () => 0n, aggregate: async () => ({ count: 0, sumCredit: 0n, sumDebit: 0n, minAmount: null, maxAmount: null }) },
        transactions: { findMany: async () => ({ items: [], nextCursor: null }) },
        transitions: { findMany: async () => ({ items: [], nextCursor: null }) },
        anomalies: { findMany: async () => d.anomaliesPage ?? { items: [], nextCursor: null } },
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
      anomalyGet: async (tid, id) => d.anomalyDetail?.[`${tid}:${id}`] ?? null,
      outboxList: async (tid) => d.outboxPage?.[tid] ?? { items: [], nextCursor: null },
      outboxGet: async (tid, id) => d.outboxDetail?.[`${tid}:${id}`] ?? null,
      scheduledGet: async (tid, id) => d.scheduledDetail?.[`${tid}:${id}`] ?? null,
      reconcilerState: async (tid) => d.reconcilerState?.[tid] ?? [],
      flowStates: async () => [],
      flowTransitionCounts: async () => [],
      transitionsSince: async () => [],
      anomaliesSince: async () => [],
    },
    scheduler: { list: async () => d.scheduled ?? [] },
    holds: { list: async () => d.holds ?? [], get: async (id) => d.holdDetail?.[id] ?? null },
    disputes: { list: async () => d.disputes ?? [], get: async (id) => d.disputeDetail?.[id] ?? null },
    fx: { history: async () => d.fxHistory ?? [] },
    close: async () => {},
  }
}

const SAMPLE_TENANT: TenantRow = {
  id: 'chidori',
  name: 'Chidori',
  mode: 'row',
  state: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
}
const UUID = '01234567-89ab-cdef-0123-456789abcdef'
const LOOPBACK = { host: '127.0.0.1:4488' } as const
const SECRET = randomBytes(32)

async function boot(
  data: FakeData = { tenants: [SAMPLE_TENANT] },
  extra: Partial<Parameters<typeof startDashboardServer>[2]> = {},
): Promise<{ server: DashboardServer }> {
  const audit = createMemoryAuditLog()
  const server = await startDashboardServer(config, schema, {
    host: '127.0.0.1',
    port: 4488,
    skipListen: true,
    engine: fakeEngine(data),
    audit,
    sessionSecret: SECRET,
    ...extra,
  })
  return { server }
}

// =============================================================================
// Anomalies
// =============================================================================

describe('M6 anomalies', () => {
  it('lists anomalies via queries.anomalies.findMany', async () => {
    const anomaly: AnomalyRow = {
      id: UUID, tenantId: 'chidori', detectedAt: new Date(), check: 'balance_drift',
      txnId: null, accountId: null, severity: 'error',
      expected: { amount: 1000 }, observed: { amount: 999 },
      resolvedAt: null, resolvedBy: null, resolution: null,
    }
    const { server } = await boot({
      tenants: [SAMPLE_TENANT],
      anomaliesPage: { items: [anomaly], nextCursor: null },
    }, { redactor: defaultProdRedactor })
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/anomalies', headers: LOOPBACK })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: { id: string; expected: Record<string, unknown> }[] }
      expect(body.items[0]?.id).toBe(UUID)
      // amount is in SAFE_KEYS so it passes the redactor
      expect(body.items[0]?.expected['amount']).toBe(1000)
    } finally { await server.close() }
  })

  it('400 on bad severity', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/anomalies?severity=critical-ish', headers: LOOPBACK })
      expect(res.statusCode).toBe(400)
    } finally { await server.close() }
  })

  it('detail by id', async () => {
    const anomaly: AnomalyRow = {
      id: UUID, tenantId: 'chidori', detectedAt: new Date(), check: 'hash_chain_break',
      txnId: null, accountId: null, severity: 'critical',
      expected: { secret: 'no' }, observed: { secret: 'yes' },
      resolvedAt: null, resolvedBy: null, resolution: null,
    }
    const { server } = await boot(
      { tenants: [SAMPLE_TENANT], anomalyDetail: { [`chidori:${UUID}`]: anomaly } },
      { redactor: defaultProdRedactor },
    )
    try {
      const res = await server.app.inject({ method: 'GET', url: `/api/v1/tenants/chidori/anomalies/${UUID}`, headers: LOOPBACK })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { expected: Record<string, unknown>; observed: Record<string, unknown> }
      // 'secret' is not a SAFE_KEY → redacted in both fields
      expect(body.expected['secret']).toBe('<redacted>')
      expect(body.observed['secret']).toBe('<redacted>')
    } finally { await server.close() }
  })

  it('404 on missing anomaly', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({ method: 'GET', url: `/api/v1/tenants/chidori/anomalies/${UUID}`, headers: LOOPBACK })
      expect(res.statusCode).toBe(404)
    } finally { await server.close() }
  })

  it('400 on bad UUID', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/anomalies/not-a-uuid', headers: LOOPBACK })
      expect(res.statusCode).toBe(400)
    } finally { await server.close() }
  })
})

// =============================================================================
// Reconciler
// =============================================================================

describe('M6 reconciler', () => {
  it('returns watermark state', async () => {
    const wm: ReconcilerWatermark = {
      checkKind: 'hash_chain',
      watermark: '01234',
      lastSweepAt: new Date().toISOString(),
      fullSweepAt: null,
    }
    const { server } = await boot({ tenants: [SAMPLE_TENANT], reconcilerState: { chidori: [wm] } })
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/reconciler/state', headers: LOOPBACK })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: { checkKind: string }[] }
      expect(body.items[0]?.checkKind).toBe('hash_chain')
    } finally { await server.close() }
  })
})

// =============================================================================
// Outbox
// =============================================================================

describe('M6 outbox', () => {
  const row: OutboxRow = {
    id: UUID,
    txnId: UUID,
    transitionId: UUID,
    event: 'delivery.paid',
    intent: 'stripe.capture',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
    lastError: null,
    createdAt: new Date().toISOString(),
    payload: { amount: 1500, secret: 'pii' },
  }

  it('lists outbox events + redacts payloads', async () => {
    const { server } = await boot(
      { tenants: [SAMPLE_TENANT], outboxPage: { chidori: { items: [row], nextCursor: null } } },
      { redactor: defaultProdRedactor },
    )
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/outbox', headers: LOOPBACK })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: { payload: Record<string, unknown> }[] }
      expect(body.items[0]?.payload['amount']).toBe(1500)
      expect(body.items[0]?.payload['secret']).toBe('<redacted>')
    } finally { await server.close() }
  })

  it('400 on bad status', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/outbox?status=panicked', headers: LOOPBACK })
      expect(res.statusCode).toBe(400)
    } finally { await server.close() }
  })

  it('detail by id', async () => {
    const { server } = await boot(
      { tenants: [SAMPLE_TENANT], outboxDetail: { [`chidori:${UUID}`]: row } },
      { redactor: defaultProdRedactor },
    )
    try {
      const res = await server.app.inject({ method: 'GET', url: `/api/v1/tenants/chidori/outbox/${UUID}`, headers: LOOPBACK })
      expect(res.statusCode).toBe(200)
      expect((res.json() as { event: string }).event).toBe('delivery.paid')
    } finally { await server.close() }
  })
})

// =============================================================================
// Scheduler
// =============================================================================

describe('M6 scheduler', () => {
  const sched: ScheduledTransition = {
    id: UUID,
    tenantId: 'chidori',
    txnId: UUID,
    name: 'finish',
    runAt: new Date(),
    actor: { type: 'User', id: 'u-1' },
    payload: { amount: 500, secret: 'pii' },
    withKey: null,
    idempotencyKey: 'k-1',
    status: 'pending',
    attempts: 0,
    lastError: null,
    firedAt: null,
    firedTransitionId: null,
    createdAt: new Date(),
  }

  it('lists scheduled transitions + paginates', async () => {
    const { server } = await boot({ tenants: [SAMPLE_TENANT], scheduled: [sched] }, { redactor: defaultProdRedactor })
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/scheduled?limit=10', headers: LOOPBACK })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: { id: string; payload: Record<string, unknown> }[] }
      expect(body.items[0]?.id).toBe(UUID)
      expect(body.items[0]?.payload['secret']).toBe('<redacted>')
    } finally { await server.close() }
  })

  it('400 on bad status filter', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/scheduled?status=banana', headers: LOOPBACK })
      expect(res.statusCode).toBe(400)
    } finally { await server.close() }
  })

  it('detail by id', async () => {
    const { server } = await boot(
      { tenants: [SAMPLE_TENANT], scheduledDetail: { [`chidori:${UUID}`]: sched } },
      { redactor: defaultProdRedactor },
    )
    try {
      const res = await server.app.inject({ method: 'GET', url: `/api/v1/tenants/chidori/scheduled/${UUID}`, headers: LOOPBACK })
      expect(res.statusCode).toBe(200)
    } finally { await server.close() }
  })
})

// =============================================================================
// Holds
// =============================================================================

describe('M6 holds', () => {
  const hold: Hold = {
    id: UUID,
    tenantId: 'chidori',
    txnId: null,
    holdAccountId: 'a-1',
    amount: 1000n,
    status: 'placed',
    expiresAt: null,
    releasedByTransitionId: null,
    placedAt: new Date(),
    releasedAt: null,
  }

  it('lists holds and renders bigint amount as string', async () => {
    const { server } = await boot({ tenants: [SAMPLE_TENANT], holds: [hold] })
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/holds', headers: LOOPBACK })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: { amount: string }[] }
      expect(body.items[0]?.amount).toBe('1000')
    } finally { await server.close() }
  })

  it('detail enforces tenant scope', async () => {
    const otherTenant: Hold = { ...hold, tenantId: 'other' }
    const { server } = await boot({ tenants: [SAMPLE_TENANT], holdDetail: { [UUID]: otherTenant } })
    try {
      const res = await server.app.inject({ method: 'GET', url: `/api/v1/tenants/chidori/holds/${UUID}`, headers: LOOPBACK })
      expect(res.statusCode).toBe(404) // cross-tenant lookup → 404
    } finally { await server.close() }
  })

  it('400 on bad status', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/holds?status=nope', headers: LOOPBACK })
      expect(res.statusCode).toBe(400)
    } finally { await server.close() }
  })
})

// =============================================================================
// Disputes
// =============================================================================

describe('M6 disputes', () => {
  const dispute: Dispute = {
    id: UUID,
    tenantId: 'chidori',
    originalTransitionId: UUID,
    status: 'open',
    openedAt: new Date(),
    deadlineAt: null,
    resolvedAt: null,
    resolution: null,
    reason: 'fraud claim',
  }

  it('lists disputes', async () => {
    const { server } = await boot({ tenants: [SAMPLE_TENANT], disputes: [dispute] })
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/tenants/chidori/disputes', headers: LOOPBACK })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: { reason: string }[] }
      expect(body.items[0]?.reason).toBe('fraud claim')
    } finally { await server.close() }
  })

  it('detail enforces tenant scope', async () => {
    const { server } = await boot({
      tenants: [SAMPLE_TENANT],
      disputeDetail: { [UUID]: { ...dispute, tenantId: 'other' } },
    })
    try {
      const res = await server.app.inject({ method: 'GET', url: `/api/v1/tenants/chidori/disputes/${UUID}`, headers: LOOPBACK })
      expect(res.statusCode).toBe(404)
    } finally { await server.close() }
  })
})

// =============================================================================
// FX
// =============================================================================

describe('M6 fx', () => {
  const rate: FxRate = {
    id: UUID,
    tenantId: 'chidori',
    baseCurrency: 'USD',
    quoteCurrency: 'NGN',
    rate: '1500.123456789012345678',
    fixedAt: new Date(),
    expiresAt: null,
    source: 'cbn',
    createdAt: new Date(),
  }

  it('returns the history', async () => {
    const { server } = await boot({ tenants: [SAMPLE_TENANT], fxHistory: [rate] })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/fx?base=USD&quote=NGN',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: { rate: string }[] }
      expect(body.items[0]?.rate).toBe('1500.123456789012345678')
    } finally { await server.close() }
  })

  it('400 on malformed base', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/fx?base=usd&quote=NGN',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(400)
    } finally { await server.close() }
  })

  it('404 on currency the schema does not declare', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/fx?base=XYZ&quote=NGN',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(404)
    } finally { await server.close() }
  })

  it('400 on bad ISO timestamp', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/fx?base=USD&quote=NGN&since=not-a-date',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(400)
    } finally { await server.close() }
  })
})
