/**
 * M5 transactions + trace + verify + postings + keys + payload redaction.
 *
 * The fake engine returns canned trace/posting/key data; tests exercise
 * the route boundary (validation, cursor signing, redaction) without
 * touching Postgres.
 */
import { randomBytes } from 'node:crypto'
import {
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '@loki/core'
import type {
  HealthReport,
  Page,
  Posting,
  TenantRow,
  TxnRecord,
  TxnTransition,
  VerifyResult,
} from '@loki/core'
import { describe, expect, it } from 'vitest'
import { createMemoryAuditLog } from '../../../src/dashboard/audit.js'
import type {
  CapabilityKeyEvent,
  ReadEngine,
  TxnPostingRow,
  TxnRecordRow,
} from '../../../src/dashboard/read-engine.js'
import { defaultProdRedactor, identityRedactor } from '../../../src/dashboard/redact.js'
import {
  type DashboardServer,
  startDashboardServer,
} from '../../../src/dashboard/server.js'

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
  records?: Record<string, TxnRecordRow>           // key = `${tid}:${txnId}`
  transactionsPage?: Record<string, Page<TxnRecord>> // key = `${tid}`
  transitions?: Record<string, readonly TxnTransition[]>   // key = `${tid}:${txnId}`
  postings?: Record<string, readonly TxnPostingRow[]>     // key = `${tid}:${txnId}`
  keys?: Record<string, readonly CapabilityKeyEvent[]>    // key = `${tid}:${txnId}`
  verifyResult?: VerifyResult
}

function fakeEngine(d: FakeData = {}): ReadEngine {
  const HEALTHY: HealthReport = {
    ok: true,
    nowMs: 1_000_000,
    primary: { ok: true, latencyMs: 4, lsn: '0/0' },
    replica: null,
    migrations: { applied: true, count: 1 },
  }
  const tenants = d.tenants ?? []
  return {
    health: async () => HEALTHY,
    forTenant: (tid) => ({
      // The engine declares two `Posting` types (schema-level vs runtime
      // mapper). The mismatch leaks into TypeScript here; cast at the
      // boundary so the rest of the fake stays readable.
      queries: ({
        actor: () => ({
          transactions: async () => ({ items: [], nextCursor: null }),
          summary: async () => ({ transitions: 0 }),
          trails: async () => ({ items: [], nextCursor: null }),
          accounts: async () => [],
        }),
        account: {
          history: async () => ({ items: [], nextCursor: null }),
          balanceAt: async () => 0n,
          aggregate: async () => ({ count: 0, sumCredit: 0n, sumDebit: 0n, minAmount: null, maxAmount: null }),
        },
        transactions: {
          findMany: async (): Promise<Page<TxnRecord>> =>
            d.transactionsPage?.[tid] ?? { items: [], nextCursor: null },
        },
        transitions: {
          findMany: async (args: { where?: { txnId?: string } } | undefined): Promise<Page<TxnTransition>> => {
            const all = d.transitions?.[`${tid}:${args?.where?.txnId}`] ?? []
            return { items: all, nextCursor: null }
          },
        },
        anomalies: { findMany: async () => ({ items: [], nextCursor: null }) },
        postings:  { findMany: async () => ({ items: [], nextCursor: null }) },
        verify: async (_id: string, _hasher: unknown): Promise<VerifyResult> =>
          d.verifyResult ?? {
            ok: true,
            recordId: _id,
            transitionsChecked: 0,
            issues: [],
          },
      }) as unknown as ReturnType<ReadEngine['forTenant']>['queries'],
      accounts: { balance: async () => 0n },
    }),
    admin: {
      tenants: { list: async () => tenants, get: async (id) => tenants.find((t) => t.id === id) ?? null },
      schema: { versions: (async () => []) as ReadEngine['admin']['schema']['versions'] },
    },
    decryptPayload: async (v) => v,
    dashboard: {
      tenantSummary: async () => ({
        id: '', records: 0, transitions: 0, accounts: 0, compromised: 0, openAnomalies: 0,
        outbox: { pending: 0, inflight: 0, terminal: 0 },
        scheduler: { scheduled: 0, due: 0 },
      }),
      actorIds: async () => ({ items: [], nextCursor: null }),
      actorAccounts: async () => [],
      txnRecord: async (tid, txnId) => d.records?.[`${tid}:${txnId}`] ?? null,
      txnPostings: async (tid, txnId, args) => {
        const all = d.postings?.[`${tid}:${txnId}`] ?? []
        return { items: all.slice(0, args.limit), nextCursor: null }
      },
      txnKeys: async (tid, txnId) => d.keys?.[`${tid}:${txnId}`] ?? [],
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

const SAMPLE_TENANT: TenantRow = {
  id: 'chidori',
  name: 'Chidori',
  mode: 'row',
  state: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
}

const TXN_ID = '01234567-89ab-cdef-0123-456789abcdef'

const HOST = '127.0.0.1:4488'
const LOOPBACK = { host: HOST } as const
const SECRET = randomBytes(32)

type Boot = { server: DashboardServer; audit: ReturnType<typeof createMemoryAuditLog> }
async function boot(
  data: FakeData = { tenants: [SAMPLE_TENANT] },
  extra: Partial<Parameters<typeof startDashboardServer>[2]> = {},
): Promise<Boot> {
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
  return { server, audit }
}

const FIXED_DATE = new Date('2026-01-02T03:04:05Z')

function makeRecord(overrides: Partial<TxnRecordRow> = {}): TxnRecordRow {
  return {
    id: TXN_ID,
    tenantId: 'chidori',
    type: 'Pay',
    state: 'pending',
    version: 0,
    compromised: false,
    schemaVersion: 1,
    activeKeys: [],
    createdBy: { type: 'User', id: 'u-1' },
    participants: { user: { type: 'User', id: 'u-1' }, driver: { type: 'Driver', id: 'd-1' } },
    createdAt: FIXED_DATE.toISOString(),
    updatedAt: FIXED_DATE.toISOString(),
    ...overrides,
  }
}

function makeTransition(overrides: Partial<TxnTransition> = {}): TxnTransition {
  return {
    id: 'tr-1',
    tenantId: 'chidori',
    txnId: TXN_ID,
    type: 'Pay',
    fromState: 'pending',
    toState: 'done',
    name: 'settle',
    schemaVersion: 1,
    actor: { type: 'User', id: 'u-1' },
    payload: { amount: 1500n, currency: 'NGN', secret: 'do-not-leak' },
    idempotencyKey: 'idem-1',
    traceId: null,
    prevHash: null,
    rowHash: Buffer.alloc(32, 0xa1),
    postingsChecksum: Buffer.alloc(32, 0xa2),
    reverses: null,
    occurredAt: FIXED_DATE,
    ...overrides,
  }
}

// =============================================================================
// /api/v1/tenants/:tid/transactions (findMany)
// =============================================================================

describe('M5 GET /transactions', () => {
  it('returns the page', async () => {
    const record = makeRecord()
    const { server } = await boot({
      tenants: [SAMPLE_TENANT],
      transactionsPage: {
        chidori: {
          items: [
            {
              id: record.id,
              tenantId: record.tenantId,
              type: record.type,
              state: record.state,
              version: record.version,
              activeKeys: record.activeKeys,
              participants: record.participants,
              createdBy: record.createdBy,
              compromised: record.compromised,
              schemaVersion: record.schemaVersion,
              createdAt: FIXED_DATE,
              updatedAt: FIXED_DATE,
            },
          ],
          nextCursor: null,
        },
      },
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/transactions',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: { id: string; type: string }[] }
      expect(body.items[0]?.type).toBe('Pay')
    } finally {
      await server.close()
    }
  })

  it('rejects unknown txn type (closed enum)', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/transactions?type=Refund',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('refuses state without type', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/transactions?state=done',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('rejects state that isn\'t declared on the given type', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/transactions?type=Pay&state=banana',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// /api/v1/tenants/:tid/transactions/:txnId
// =============================================================================

describe('M5 GET /transactions/:txnId', () => {
  it('400 on bad txn id (not a UUID)', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/transactions/not-a-uuid',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('404 on unknown txn id', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: `/api/v1/tenants/chidori/transactions/${TXN_ID}`,
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('returns the record header when found', async () => {
    const { server } = await boot({
      tenants: [SAMPLE_TENANT],
      records: { [`chidori:${TXN_ID}`]: makeRecord() },
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: `/api/v1/tenants/chidori/transactions/${TXN_ID}`,
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as { id: string }).id).toBe(TXN_ID)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// /trace — redaction + idempotency hashing
// =============================================================================

describe('M5 GET /transactions/:txnId/trace', () => {
  it('redacts payloads in prod mode and hashes idempotency keys', async () => {
    const { server } = await boot(
      {
        tenants: [SAMPLE_TENANT],
        records: { [`chidori:${TXN_ID}`]: makeRecord() },
        transitions: { [`chidori:${TXN_ID}`]: [makeTransition()] },
      },
      { redactor: defaultProdRedactor },
    )
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: `/api/v1/tenants/chidori/transactions/${TXN_ID}/trace`,
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        transitions: { payload: Record<string, unknown>; idempotencyKey: string }[]
      }
      const tr = body.transitions[0]
      // bigint → decimal-string at the redactor layer (matches the rest
      // of the dashboard's bigint convention).
      expect(tr?.payload['amount']).toBe('1500')
      expect(tr?.payload['currency']).toBe('NGN')
      expect(tr?.payload['secret']).toBe('<redacted>')
      expect(tr?.idempotencyKey).toMatch(/^sha256:[0-9a-f]{16}$/)
    } finally {
      await server.close()
    }
  })

  it('passes payloads through in dev mode (identity redactor)', async () => {
    const { server } = await boot(
      {
        tenants: [SAMPLE_TENANT],
        records: { [`chidori:${TXN_ID}`]: makeRecord() },
        transitions: {
          [`chidori:${TXN_ID}`]: [makeTransition({ payload: { ok: 'visible' } })],
        },
      },
      { redactor: identityRedactor },
    )
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: `/api/v1/tenants/chidori/transactions/${TXN_ID}/trace`,
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { transitions: { payload: Record<string, unknown> }[] }
      expect(body.transitions[0]?.payload).toEqual({ ok: 'visible' })
    } finally {
      await server.close()
    }
  })

  it('surfaces $encrypted envelope when decrypt throws', async () => {
    // Inject an engine whose decryptPayload throws — the route should
    // return { $encrypted: true, alg } in place of the payload.
    const eng = fakeEngine({
      tenants: [SAMPLE_TENANT],
      records: { [`chidori:${TXN_ID}`]: makeRecord() },
      transitions: {
        [`chidori:${TXN_ID}`]: [makeTransition({ payload: { $encrypted: 'v1:aes:abc' } })],
      },
    })
    const erroring: ReadEngine = {
      ...eng,
      decryptPayload: async () => { throw new Error('no key') },
    }
    const server = await startDashboardServer(config, schema, {
      host: '127.0.0.1',
      port: 4488,
      skipListen: true,
      engine: erroring,
      audit: createMemoryAuditLog(),
      sessionSecret: SECRET,
      redactor: defaultProdRedactor,
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: `/api/v1/tenants/chidori/transactions/${TXN_ID}/trace`,
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { transitions: { payload: Record<string, unknown> }[] }
      expect(body.transitions[0]?.payload).toMatchObject({ $encrypted: true, alg: 'aes' })
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// /verify
// =============================================================================

describe('M5 GET /transactions/:txnId/verify', () => {
  it('returns the engine\'s verify result', async () => {
    const { server } = await boot({
      tenants: [SAMPLE_TENANT],
      records: { [`chidori:${TXN_ID}`]: makeRecord() },
      verifyResult: {
        ok: false,
        recordId: TXN_ID,
        transitionsChecked: 3,
        issues: [
          { transitionId: 'tr-1', check: 'hash_chain_break', expected: 'a', observed: 'b' },
        ],
      },
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: `/api/v1/tenants/chidori/transactions/${TXN_ID}/verify`,
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { ok: boolean; issues: { check: string }[] }
      expect(body.ok).toBe(false)
      expect(body.issues[0]?.check).toBe('hash_chain_break')
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// /postings & /keys
// =============================================================================

describe('M5 GET /transactions/:txnId/postings', () => {
  it('returns the page', async () => {
    const posting: TxnPostingRow = {
      id: 'p-1',
      transitionId: 'tr-1',
      accountId: 'a-1',
      ownerActorType: 'User',
      ownerActorId: 'u-1',
      accountName: 'wallet',
      currency: 'NGN',
      direction: 'D',
      amount: '1500',
      occurredAt: FIXED_DATE.toISOString(),
    }
    const { server } = await boot({
      tenants: [SAMPLE_TENANT],
      records: { [`chidori:${TXN_ID}`]: makeRecord() },
      postings: { [`chidori:${TXN_ID}`]: [posting] },
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: `/api/v1/tenants/chidori/transactions/${TXN_ID}/postings`,
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: TxnPostingRow[] }
      expect(body.items).toHaveLength(1)
      expect(body.items[0]?.amount).toBe('1500')
    } finally {
      await server.close()
    }
  })
})

describe('M5 GET /transactions/:txnId/keys', () => {
  it('returns the capability lineage', async () => {
    const { server } = await boot({
      tenants: [SAMPLE_TENANT],
      records: { [`chidori:${TXN_ID}`]: makeRecord() },
      keys: {
        [`chidori:${TXN_ID}`]: [
          {
            id: 'k-1',
            name: 'refund',
            status: 'active',
            grantedByTransitionId: 'tr-1',
            consumedByTransitionId: null,
            expiresAt: null,
          },
        ],
      },
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: `/api/v1/tenants/chidori/transactions/${TXN_ID}/keys`,
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: { name: string; status: string }[] }
      expect(body.items[0]?.name).toBe('refund')
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Redactor unit tests
// =============================================================================

describe('M5 redactor', () => {
  const ctx = { kind: 'transition', tenantId: 't', txnType: 'Pay', transitionName: 'settle' } as const

  it('preserves SAFE_KEYS and redacts everything else', () => {
    const out = defaultProdRedactor({ amount: 1500, currency: 'NGN', secret: 'PII' }, ctx) as Record<string, unknown>
    expect(out['amount']).toBe(1500)
    expect(out['currency']).toBe('NGN')
    expect(out['secret']).toBe('<redacted>')
  })

  it('hashes idempotency / PSP reference fields', () => {
    const out = defaultProdRedactor(
      { idempotencyKey: 'k-1', psp_reference: 'pi_abc' },
      ctx,
    ) as Record<string, unknown>
    expect(out['idempotencyKey']).toMatch(/^sha256:[0-9a-f]{16}$/)
    expect(out['psp_reference']).toMatch(/^sha256:[0-9a-f]{16}$/)
  })

  it('truncates long safe strings', () => {
    const long = 'x'.repeat(2000)
    const out = defaultProdRedactor({ reason: long }, ctx) as Record<string, unknown>
    expect((out['reason'] as string).length).toBeLessThanOrEqual(1025)
    expect((out['reason'] as string).endsWith('…')).toBe(true)
  })

  it('passes encrypted envelopes through untouched', () => {
    const env = { $encrypted: 'v1:aes:abc' }
    const out = defaultProdRedactor(env, ctx)
    expect(out).toEqual(env)
  })

  it('walks nested objects and arrays', () => {
    const out = defaultProdRedactor(
      { meta: { secret: 'x', currency: 'NGN' }, list: [{ amount: 1 }, { evil: 'y' }] },
      ctx,
    ) as Record<string, unknown>
    expect((out['meta'] as Record<string, unknown>)['secret']).toBe('<redacted>')
    expect((out['meta'] as Record<string, unknown>)['currency']).toBe('NGN')
    expect((out['list'] as Record<string, unknown>[])[0]?.['amount']).toBe(1)
    expect((out['list'] as Record<string, unknown>[])[1]?.['evil']).toBe('<redacted>')
  })
})
