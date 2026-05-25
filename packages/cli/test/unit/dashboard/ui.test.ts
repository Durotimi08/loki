/**
 * UI mount tests — per-page shells (DASHBOARD.md §7).
 *
 * Asserts:
 *   - Every allowlisted URL serves its specific shell (data-page set)
 *   - `/_assets/app.css` + `app.js` + `state-machine.js` all reachable
 *   - Path traversal under `/_assets/` is refused
 *   - Unknown URL → 404 (not a generic shell fallback)
 *   - `/api/*` always wins over the UI catch-all
 *   - `opts.ui.enabled=false` disables the UI entirely
 */
import { randomBytes } from 'node:crypto'
import {
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '@loki/core'
import type { HealthReport, TenantRow } from '@loki/core'
import { describe, expect, it } from 'vitest'
import { createMemoryAuditLog } from '../../../src/dashboard/audit.js'
import type { ReadEngine } from '../../../src/dashboard/read-engine.js'
import { startDashboardServer } from '../../../src/dashboard/server.js'

const Org = defineTenant('Org')
const User = defineActor('User', { accounts: { wallet: { currency: 'NGN' } } })
const Driver = defineActor('Driver', { accounts: { balance: { currency: 'NGN' } } })
const Pay = defineTransaction('Pay', {
  states: ['pending', 'done'],
  initial: 'pending',
  terminal: ['done'],
  participants: { user: User, driver: Driver },
  transitions: (t) => ({ finish: t({ from: 'pending', to: 'done', by: [User] }) }),
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

async function boot() {
  return startDashboardServer(config, schema, {
    host: '127.0.0.1', port: 4488, skipListen: true,
    engine: fakeEngine(), audit: createMemoryAuditLog(),
    sessionSecret: SECRET,
  })
}

describe('UI mount — per-page shells', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['/', 'overview'],
    ['/overview', 'overview'],
    ['/schema', 'schema'],
    ['/flows', 'flows'],
    ['/flow/Pay', 'flow-detail'],
    ['/transactions', 'transactions'],
    ['/transactions/01234567-89ab-cdef-0123-456789abcdef', 'transaction-detail'],
    ['/anomalies', 'anomalies'],
    ['/outbox', 'outbox'],
    ['/scheduled', 'scheduled'],
    ['/holds', 'holds'],
    ['/disputes', 'disputes'],
    ['/reconciler', 'reconciler'],
    ['/fx', 'fx'],
  ]

  for (const [url, expectedPage] of cases) {
    it(`${url} serves the ${expectedPage} shell`, async () => {
      const server = await boot()
      try {
        const res = await server.app.inject({ method: 'GET', url, headers: LOOPBACK })
        expect(res.statusCode).toBe(200)
        expect(String(res.headers['content-type'])).toContain('text/html')
        expect(res.body).toContain(`data-page="${expectedPage}"`)
      } finally { await server.close() }
    })
  }

  it('unknown UI path 404s (no generic shell fallback)', async () => {
    const server = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/this-page-does-not-exist', headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(404)
      expect(String(res.headers['content-type'])).toContain('application/problem+json')
    } finally { await server.close() }
  })

  it('bad txn id format does NOT match the transaction-detail shell', async () => {
    const server = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/transactions/not-a-uuid', headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(404)
    } finally { await server.close() }
  })
})

describe('UI mount — static assets', () => {
  it('serves CSS + JS + state-machine.js + favicon under /_assets/', async () => {
    const server = await boot()
    try {
      for (const path of [
        '/_assets/app.css',
        '/_assets/app.js',
        '/_assets/state-machine.js',
        '/_assets/favicon.svg',
      ]) {
        const res = await server.app.inject({ method: 'GET', url: path, headers: LOOPBACK })
        expect(res.statusCode, `expected ${path} to 200`).toBe(200)
      }
    } finally { await server.close() }
  })

  it('refuses path traversal under /_assets/', async () => {
    const server = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/_assets/..%2F..%2Fpackage.json',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBeGreaterThanOrEqual(400)
    } finally { await server.close() }
  })
})

describe('UI mount — interplay with API', () => {
  it('/api/v1/version still returns JSON', async () => {
    const server = await boot()
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/version', headers: LOOPBACK })
      expect(res.statusCode).toBe(200)
      expect(String(res.headers['content-type'])).toContain('json')
    } finally { await server.close() }
  })

  it('unknown /api/* returns problem+json, NOT the HTML shell', async () => {
    const server = await boot()
    try {
      const res = await server.app.inject({ method: 'GET', url: '/api/v1/no-such-route', headers: LOOPBACK })
      expect(res.statusCode).toBe(404)
      expect(String(res.headers['content-type'])).toContain('application/problem+json')
    } finally { await server.close() }
  })

  it('opts.ui.enabled=false disables the UI', async () => {
    const server = await startDashboardServer(config, schema, {
      host: '127.0.0.1', port: 4488, skipListen: true,
      engine: fakeEngine(), audit: createMemoryAuditLog(),
      sessionSecret: SECRET,
      ui: { enabled: false },
    })
    try {
      const res = await server.app.inject({ method: 'GET', url: '/', headers: LOOPBACK })
      expect(res.statusCode).toBe(404)
    } finally { await server.close() }
  })
})
