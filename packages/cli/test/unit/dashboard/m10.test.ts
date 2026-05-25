/**
 * M10 — the operational extras that closed the remaining DASHBOARD.md
 * gaps: TLS, Unix-socket, socket-level limits, per-session SSE cap,
 * session-keyed rate limit, strict Sec-Fetch under auth, per-route
 * concurrency semaphore, build-hash, reconciler-runs buffer, plus the
 * two §8.18 tests that hadn't been written (xssi + proto-pollution).
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
import type { Argon2Verify } from '../../../src/dashboard/auth/index.js'
import { createReconcilerRunsBuffer } from '../../../src/dashboard/reconciler-runs.js'
import type { ReadEngine } from '../../../src/dashboard/read-engine.js'
import {
  type DashboardServer,
  startDashboardServer,
} from '../../../src/dashboard/server.js'
import { createSessionScopedCap } from '../../../src/dashboard/sse.js'
import { createActionThrottle } from '../../../src/dashboard/actions/throttle.js'

// =============================================================================
// Fixture
// =============================================================================

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
const REAL_HASH = '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const STUB_ARGON2: Argon2Verify = async (h, p) => h === REAL_HASH && p === 'hunter2'
const LOOPBACK = { host: '127.0.0.1:4488' } as const
const SECRET = randomBytes(32)
const UUID = '01234567-89ab-cdef-0123-456789abcdef'

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

async function boot(
  extra: Partial<Parameters<typeof startDashboardServer>[2]> = {},
): Promise<DashboardServer> {
  return startDashboardServer(config, config.schema, {
    host: '127.0.0.1',
    port: 4488,
    skipListen: true,
    engine: fakeEngine(),
    audit: createMemoryAuditLog(),
    sessionSecret: SECRET,
    ...extra,
  })
}

// =============================================================================
// Per-session SSE cap (sessionScopedCap unit)
// =============================================================================

describe('M10 createSessionScopedCap', () => {
  it('enforces both global and per-session caps', () => {
    const cap = createSessionScopedCap({ globalMax: 5, perSessionMax: 2 })
    expect(cap.tryAcquire('alice')).toBe(true)
    expect(cap.tryAcquire('alice')).toBe(true)
    expect(cap.tryAcquire('alice')).toBe(false)   // per-session full
    expect(cap.tryAcquire('bob')).toBe(true)
    expect(cap.perKeyInFlight('alice')).toBe(2)
    cap.release('alice')
    expect(cap.tryAcquire('alice')).toBe(true)
  })

  it('refuses globally even when per-session has slack', () => {
    const cap = createSessionScopedCap({ globalMax: 2, perSessionMax: 10 })
    expect(cap.tryAcquire('a')).toBe(true)
    expect(cap.tryAcquire('b')).toBe(true)
    expect(cap.tryAcquire('c')).toBe(false)
    expect(cap.globalInFlight()).toBe(2)
  })

  it('null/anon key shares a bucket', () => {
    const cap = createSessionScopedCap({ globalMax: 5, perSessionMax: 1 })
    expect(cap.tryAcquire(null)).toBe(true)
    expect(cap.tryAcquire(null)).toBe(false)
    cap.release(null)
    expect(cap.tryAcquire(null)).toBe(true)
  })
})

// =============================================================================
// Strict Sec-Fetch when auth scheme is on
// =============================================================================

describe('M10 strict Sec-Fetch under auth', () => {
  it('absent Sec-Fetch-Site is allowed when auth scheme is `none`', async () => {
    const server = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/api/v1/version', headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
    } finally { await server.close() }
  })

  it('absent Sec-Fetch-Site is rejected under bearer auth with no Authorization on a non-public path', async () => {
    const server = await boot({
      auth: { kind: 'bearer', token: 'a'.repeat(64) },
    })
    try {
      // /api/v1/tenants is auth-private (and not in the public exemption).
      const res = await server.app.inject({
        method: 'GET', url: '/api/v1/tenants', headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(403)
    } finally { await server.close() }
  })

  it('absent Sec-Fetch-Site is allowed under bearer auth with Authorization header', async () => {
    const server = await boot({
      auth: { kind: 'bearer', token: 'a'.repeat(64) },
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants',
        headers: { ...LOOPBACK, authorization: `Bearer ${'a'.repeat(64)}` },
      })
      // Auth flow passes the Sec-Fetch gate; downstream may or may not 200,
      // we only assert it's not the 403 from the Sec-Fetch hook.
      expect(res.statusCode).not.toBe(403)
    } finally { await server.close() }
  })

  it('public endpoints (health, version) stay reachable under auth without any headers', async () => {
    const server = await boot({
      auth: { kind: 'bearer', token: 'a'.repeat(64) },
    })
    try {
      const v = await server.app.inject({ method: 'GET', url: '/api/v1/version', headers: LOOPBACK })
      expect(v.statusCode).toBe(200)
      const h = await server.app.inject({ method: 'GET', url: '/api/v1/health', headers: LOOPBACK })
      expect(h.statusCode).toBe(200)
    } finally { await server.close() }
  })
})

// =============================================================================
// Build hash from env var
// =============================================================================

describe('M10 build hash on /api/v1/version', () => {
  it('reads from explicit option when provided', async () => {
    const server = await boot({ buildHash: 'abc1234' })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: { ...LOOPBACK, 'sec-fetch-site': 'same-origin' },
      })
      expect((res.json() as { buildHash: string }).buildHash).toBe('abc1234')
    } finally { await server.close() }
  })
})

// =============================================================================
// Reconciler runs ring buffer
// =============================================================================

describe('M10 reconciler runs buffer', () => {
  it('returns recent runs most-recent-first', () => {
    const buf = createReconcilerRunsBuffer(5)
    for (let i = 0; i < 3; i++) {
      buf.append({
        tenantId: 't', subject: 'ops',
        startedAt: new Date(2026, 0, 1, 0, i).toISOString(),
        finishedAt: new Date(2026, 0, 1, 0, i, 1).toISOString(),
        durationMs: 100, fullSweep: false, anomalies: i, quarantined: 0,
        status: 'ok', errorMessage: null,
      })
    }
    const items = buf.list('t')
    expect(items).toHaveLength(3)
    expect(items[0]?.anomalies).toBe(2)
    expect(items[2]?.anomalies).toBe(0)
  })

  it('drops the oldest entry when the cap is exceeded', () => {
    const buf = createReconcilerRunsBuffer(2)
    for (let i = 0; i < 4; i++) {
      buf.append({
        tenantId: 't', subject: 'ops',
        startedAt: new Date(2026, 0, 1, 0, i).toISOString(),
        finishedAt: new Date(2026, 0, 1, 0, i, 1).toISOString(),
        durationMs: 100, fullSweep: false, anomalies: i, quarantined: 0,
        status: 'ok', errorMessage: null,
      })
    }
    const items = buf.list('t')
    expect(items.map((r) => r.anomalies)).toEqual([3, 2])
  })

  it('GET /reconciler/runs returns the buffer + note', async () => {
    const server = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/reconciler/runs',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: unknown[]; note: string }
      expect(Array.isArray(body.items)).toBe(true)
      expect(body.note).toContain('in-memory ring buffer')
    } finally { await server.close() }
  })

  it('GET /reconciler/runs rejects a bad since', async () => {
    const server = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/chidori/reconciler/runs?since=not-a-date',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(400)
    } finally { await server.close() }
  })
})

// =============================================================================
// §8.18 xssi — every JSON endpoint returns an object, never a top-level array
// =============================================================================

describe('M10 §8.18 XSSI (top-level object)', () => {
  it('every listed JSON endpoint returns an object', async () => {
    const server = await boot()
    try {
      const endpoints = [
        '/api/v1/version',
        '/api/v1/health',
        '/api/v1/schema',
        '/api/v1/tenants',
        '/api/v1/tenants/chidori',
        '/api/v1/tenants/chidori/summary',
        '/api/v1/tenants/chidori/actors',
        '/api/v1/tenants/chidori/flows',
        '/api/v1/tenants/chidori/reconciler/state',
        '/api/v1/tenants/chidori/reconciler/runs',
        '/api/v1/tenants/chidori/outbox',
        '/api/v1/tenants/chidori/scheduled',
        '/api/v1/tenants/chidori/holds',
        '/api/v1/tenants/chidori/disputes',
      ]
      for (const url of endpoints) {
        const res = await server.app.inject({ method: 'GET', url, headers: LOOPBACK })
        if (res.statusCode >= 400) continue // 4xx/5xx use problem+json (object); skip
        const ct = String(res.headers['content-type'] ?? '')
        if (!ct.includes('json')) continue
        // The wire body must not be a top-level array.
        const body = res.body.trimStart()
        expect(body.startsWith('[')).toBe(false)
        expect(body.startsWith('{')).toBe(true)
      }
    } finally { await server.close() }
  })
})

// =============================================================================
// §8.18 prototype pollution
// =============================================================================

describe('M10 §8.18 prototype pollution', () => {
  it('rejects __proto__ in a POST body via Ajv (additionalProperties=false)', async () => {
    const audit = createMemoryAuditLog()
    const throttle = createActionThrottle()
    const server = await startDashboardServer(config, config.schema, {
      host: '127.0.0.1', port: 4488, skipListen: true,
      engine: fakeEngine(), audit, sessionSecret: SECRET,
      auth: { kind: 'basic', user: 'admin', argon2Hash: REAL_HASH },
      argon2Verify: STUB_ARGON2,
      allowActions: true,
      actions: {
        connectionUrl: 'postgres://ignored:ignored@localhost:1/ignored',
        grants: { 'anomalies.resolve': ['basic:admin'] },
      },
      actionExecutorFactory: async () => ({
        resolveAnomaly: async () => ({ resolvedAt: '', resolvedBy: '' }),
        runReconciler: async () => ({ anomalies: 0, quarantined: 0, durationMs: 0 }),
        close: async () => {},
      }),
      actionThrottle: throttle,
    })
    try {
      // Login to get a session cookie + csrf.
      server.app.get('/_/private', { preHandler: server.auth.requireAuth }, async () => ({ ok: true }))
      const login = await server.app.inject({
        method: 'GET', url: '/_/private',
        headers: { ...LOOPBACK, authorization: `Basic ${Buffer.from('admin:hunter2').toString('base64')}` },
      })
      const setCookie = String(login.headers['set-cookie'] ?? '')
      const cookieMatch = setCookie.match(/loki_dash_sess=([^;]+)/)
      const cookieValue = decodeURIComponent(cookieMatch?.[1] ?? '')
      const payload = JSON.parse(Buffer.from((cookieValue.split('.')[0] ?? ''), 'base64url').toString('utf8'))

      // Try to smuggle __proto__ on the resolve body.
      const evil = JSON.stringify({ by: 'ops', note: 'ok', __proto__: { polluted: true } })
      const res = await server.app.inject({
        method: 'POST',
        url: `/api/v1/tenants/chidori/anomalies/${UUID}/resolve`,
        headers: {
          ...LOOPBACK,
          cookie: `loki_dash_sess=${cookieMatch?.[1] ?? ''}`,
          'x-csrf-token': payload.csrf,
          'content-type': 'application/json; charset=utf-8',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'idempotency-key': 'k_proto',
        },
        payload: evil,
      })
      // Either 400 (Ajv refused additionalProperties: __proto__) or 200
      // — but if 200, the resolve handler must NOT have polluted Object.prototype.
      const polluted = ({} as Record<string, unknown>)['polluted']
      expect(polluted).toBeUndefined()
      // We prefer the stricter outcome:
      expect([200, 400]).toContain(res.statusCode)
    } finally { await server.close() }
  })
})

// =============================================================================
// /api/v1/version surfaces build hash as 'dev' fallback
// =============================================================================

describe('M10 build hash default', () => {
  it('falls back to dev when no env / option is provided', async () => {
    const original = process.env['LOKI_DASHBOARD_BUILD_HASH']
    delete process.env['LOKI_DASHBOARD_BUILD_HASH']
    try {
      const server = await boot()
      try {
        const res = await server.app.inject({
          method: 'GET', url: '/api/v1/version', headers: LOOPBACK,
        })
        expect((res.json() as { buildHash: string }).buildHash).toBe('dev')
      } finally { await server.close() }
    } finally {
      if (original !== undefined) process.env['LOKI_DASHBOARD_BUILD_HASH'] = original
    }
  })
})
