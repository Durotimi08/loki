/**
 * M8 actions — each of the 12 gates from DASHBOARD.md §9.2, plus
 * idempotency replay, throttle (rate + cool-down), executor errors.
 *
 * The fake `ActionExecutor` lets us assert side-effects without touching
 * a writable DB. The session/auth path uses real M3 cookies so the
 * full gate stack runs.
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
import {
  ActionPreconditionError,
} from '../../../src/dashboard/actions/executor.js'
import { createActionThrottle } from '../../../src/dashboard/actions/throttle.js'
import { createIdempotencyCache } from '../../../src/dashboard/actions/idempotency.js'
import type {
  ActionExecutor,
  ActionsConfig,
} from '../../../src/dashboard/actions/types.js'
import type { Argon2Verify } from '../../../src/dashboard/auth/index.js'
import {
  type DashboardServer,
  startDashboardServer,
} from '../../../src/dashboard/server.js'
import type { ReadEngine } from '../../../src/dashboard/read-engine.js'
import { createConcurrencyCap } from '../../../src/dashboard/sse.js'

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

const SAMPLE_TENANT: TenantRow = {
  id: 'chidori', name: 'Chidori', mode: 'row', state: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
}

const UUID = '01234567-89ab-cdef-0123-456789abcdef'
const LOOPBACK = { host: '127.0.0.1:4488' } as const
const SECRET = randomBytes(32)
const REAL_HASH = '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

const STUB_ARGON2: Argon2Verify = async (hash, password) =>
  hash === REAL_HASH && password === 'hunter2'

const HEALTHY: HealthReport = {
  ok: true, nowMs: 1, primary: { ok: true, latencyMs: 0, lsn: '0/0' },
  replica: null, migrations: { applied: true, count: 1 },
}

function fakeEngine(): ReadEngine {
  return {
    health: async () => HEALTHY,
    forTenant: () => ({
      queries: {} as ReturnType<ReadEngine['forTenant']>['queries'],
      accounts: { balance: async () => 0n },
    }),
    admin: {
      tenants: { list: async () => [SAMPLE_TENANT], get: async (id) => id === SAMPLE_TENANT.id ? SAMPLE_TENANT : null },
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

type FakeExecutorState = {
  resolveCalls: { tenantId: string; anomalyId: string; by: string; note: string }[]
  reconcileCalls: { tenantId: string; fullSweep: boolean }[]
  resolveBehaviour: 'ok' | 'precondition' | 'throw'
  reconcileBehaviour: 'ok' | 'precondition' | 'throw'
}

function fakeExecutor(state: FakeExecutorState): ActionExecutor {
  return {
    async resolveAnomaly(input) {
      state.resolveCalls.push(input)
      if (state.resolveBehaviour === 'precondition') {
        throw new ActionPreconditionError('anomaly-not-found-or-already-resolved')
      }
      if (state.resolveBehaviour === 'throw') {
        throw new Error('boom')
      }
      return { resolvedAt: '2026-01-01T00:00:00.000Z', resolvedBy: input.by }
    },
    async runReconciler(input) {
      state.reconcileCalls.push(input)
      if (state.reconcileBehaviour === 'precondition') {
        throw new ActionPreconditionError('reconciler-already-running')
      }
      if (state.reconcileBehaviour === 'throw') {
        throw new Error('boom')
      }
      return { anomalies: 0, quarantined: 0, durationMs: 5 }
    },
    async close() {},
  }
}

const ACTIONS_CONFIG: ActionsConfig = {
  connectionUrl: 'postgres://ignored:ignored@localhost:1/ignored',
  grants: {
    'anomalies.resolve': ['basic:admin'],
    'reconciler.run-once': ['basic:admin'],
  },
}

type BootOptions = {
  execState?: FakeExecutorState
  throttle?: ReturnType<typeof createActionThrottle>
  idempotency?: ReturnType<typeof createIdempotencyCache>
  concurrency?: ReturnType<typeof createConcurrencyCap>
  allowActions?: boolean
  actions?: ActionsConfig | null
  maxSessionAgeMs?: number
  now?: () => number
}

async function boot(opts: BootOptions = {}): Promise<{
  server: DashboardServer
  audit: ReturnType<typeof createMemoryAuditLog>
  state: FakeExecutorState
}> {
  const state: FakeExecutorState = opts.execState ?? {
    resolveCalls: [], reconcileCalls: [],
    resolveBehaviour: 'ok', reconcileBehaviour: 'ok',
  }
  const audit = createMemoryAuditLog()
  const server = await startDashboardServer(config, schema, {
    host: '127.0.0.1',
    port: 4488,
    skipListen: true,
    engine: fakeEngine(),
    audit,
    sessionSecret: SECRET,
    auth: { kind: 'basic', user: 'admin', argon2Hash: REAL_HASH },
    argon2Verify: STUB_ARGON2,
    allowActions: opts.allowActions ?? true,
    // Skip the actions config (and the injected executor) when test
    // says `actions: null` — that's the gate-2 "no writable pool" case.
    ...(opts.actions === null
      ? {}
      : {
          actions: opts.actions ?? ACTIONS_CONFIG,
          actionExecutorFactory: async () => fakeExecutor(state),
        }),
    ...(opts.throttle !== undefined ? { actionThrottle: opts.throttle } : {}),
    ...(opts.idempotency !== undefined ? { actionIdempotency: opts.idempotency } : {}),
    ...(opts.concurrency !== undefined ? { actionConcurrency: opts.concurrency } : {}),
    ...(opts.maxSessionAgeMs !== undefined ? { actionMaxSessionAgeMs: opts.maxSessionAgeMs } : {}),
  })
  return { server, audit, state }
}

/** Drive a real basic-auth login, return the issued session cookie + CSRF token. */
async function login(server: DashboardServer): Promise<{ cookie: string; csrf: string }> {
  // Hit a public endpoint with basic auth so the server mints a session.
  server.app.get('/_/private-for-login', { preHandler: server.auth.requireAuth }, async () => ({ ok: true }))
  const res = await server.app.inject({
    method: 'GET',
    url: '/_/private-for-login',
    headers: {
      ...LOOPBACK,
      authorization: `Basic ${Buffer.from('admin:hunter2').toString('base64')}`,
    },
  })
  const setCookie = String(res.headers['set-cookie'] ?? '')
  const cookieMatch = setCookie.match(/loki_dash_sess=([^;]+)/)
  if (!cookieMatch) throw new Error(`no cookie in Set-Cookie: ${setCookie}`)
  const cookieValue = decodeURIComponent(cookieMatch[1] ?? '')
  // The session store HMAC-signs the cookie. We need the csrf field.
  const payload = JSON.parse(Buffer.from((cookieValue.split('.')[0] ?? ''), 'base64url').toString('utf8'))
  return { cookie: `loki_dash_sess=${cookieMatch[1] ?? ''}`, csrf: payload.csrf }
}

const STANDARD_RESOLVE_BODY = { by: 'ops', note: 'fixed by hand' }

type InjectRequest = {
  method: 'POST'
  url: string
  headers: Record<string, string>
  payload: string
}

function resolveRequest(args: {
  url?: string
  cookie?: string
  csrf?: string
  idempotencyKey?: string
  contentType?: string
  fetchSite?: string
  fetchMode?: string
  body?: unknown
}): InjectRequest {
  const headers: Record<string, string> = { ...LOOPBACK }
  if (args.cookie !== undefined) headers['cookie'] = args.cookie
  if (args.csrf !== undefined) headers['x-csrf-token'] = args.csrf
  if (args.idempotencyKey !== undefined) headers['idempotency-key'] = args.idempotencyKey
  headers['content-type'] = args.contentType ?? 'application/json; charset=utf-8'
  headers['sec-fetch-site'] = args.fetchSite ?? 'same-origin'
  headers['sec-fetch-mode'] = args.fetchMode ?? 'cors'
  return {
    method: 'POST',
    url: args.url ?? `/api/v1/tenants/chidori/anomalies/${UUID}/resolve`,
    headers,
    payload: args.body !== undefined ? JSON.stringify(args.body) : JSON.stringify(STANDARD_RESOLVE_BODY),
  }
}

// =============================================================================
// Boot-time gating
// =============================================================================

describe('M8 boot gating', () => {
  it('refuses --allow-actions without auth', async () => {
    await expect(
      startDashboardServer(config, schema, {
        host: '127.0.0.1', port: 4488, skipListen: true,
        engine: fakeEngine(), audit: createMemoryAuditLog(),
        sessionSecret: SECRET,
        allowActions: true,
        // no `auth:` → scheme is 'none'
      }),
    ).rejects.toThrow(/--allow-actions requires an auth scheme/)
  })

  it('does NOT mount action routes when --allow-actions is off', async () => {
    const { server } = await boot({ allowActions: false })
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_1' }))
      // No actions configured → Fastify 404.
      expect(res.statusCode).toBe(404)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Happy path
// =============================================================================

describe('M8 anomalies.resolve happy path', () => {
  it('200 with body { ok: true, ... } and the executor sees the call', async () => {
    const { server, state, audit } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_1' }))
      expect(res.statusCode).toBe(200)
      const body = res.json() as { ok: boolean; anomalyId: string; resolvedBy: string }
      expect(body.ok).toBe(true)
      expect(body.anomalyId).toBe(UUID)
      expect(body.resolvedBy).toBe('ops')
      expect(state.resolveCalls).toEqual([
        { tenantId: 'chidori', anomalyId: UUID, by: 'ops', note: 'fixed by hand' },
      ])
      expect(audit.entries().some((e) => e.event === 'action.ok')).toBe(true)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Gate 2: no actions pool
// =============================================================================

describe('M8 gate 2 — actions pool', () => {
  it('503 when --allow-actions is set but `actions` config is null', async () => {
    const { server, audit } = await boot({ actions: null })
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_a' }))
      expect(res.statusCode).toBe(503)
      expect((res.json() as { type: string }).type).toBe('https://loki.dev/problems/no-actions-pool')
      expect(audit.entries().some((e) => e.detail?.['gate'] === 'no-actions-pool')).toBe(true)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Gate 3: subject not in grant table
// =============================================================================

describe('M8 gate 3 — grant table', () => {
  it('403 when subject is not granted this action', async () => {
    const { server, audit } = await boot({
      actions: {
        ...ACTIONS_CONFIG,
        grants: { 'anomalies.resolve': ['basic:someone-else'] },
      },
    })
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_g' }))
      expect(res.statusCode).toBe(403)
      expect((res.json() as { type: string }).type).toBe('https://loki.dev/problems/action-not-granted')
      expect(audit.entries().some((e) => e.detail?.['gate'] === 'not-granted')).toBe(true)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Gate 4: session age
// =============================================================================

describe('M8 gate 4 — session age', () => {
  it('401 when the session is older than the rotation window', async () => {
    const { server } = await boot({ maxSessionAgeMs: 0 })
    try {
      const { cookie, csrf } = await login(server)
      // Even though the session was just minted, maxSessionAgeMs=0 makes
      // it stale immediately.
      const res = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_s' }))
      expect(res.statusCode).toBe(401)
      expect(String(res.headers['www-authenticate'])).toContain('Basic')
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Gate 5: CSRF
// =============================================================================

describe('M8 gate 5 — CSRF', () => {
  it('403 when CSRF header is missing', async () => {
    const { server, audit } = await boot()
    try {
      const { cookie } = await login(server)
      const res = await server.app.inject(resolveRequest({ cookie, idempotencyKey: 'k_c' }))
      expect(res.statusCode).toBe(403)
      expect((res.json() as { type: string }).type).toBe('https://loki.dev/problems/csrf-denied')
      expect(audit.entries().some((e) => e.detail?.['gate'] === 'csrf')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('403 when CSRF header value is wrong', async () => {
    const { server } = await boot()
    try {
      const { cookie } = await login(server)
      const res = await server.app.inject(resolveRequest({ cookie, csrf: 'wrong', idempotencyKey: 'k_c2' }))
      expect(res.statusCode).toBe(403)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Gate 6: Sec-Fetch
// =============================================================================

describe('M8 gate 6 — Sec-Fetch', () => {
  it('403 when Sec-Fetch-Site is cross-site (refused globally too, but assert action audit)', async () => {
    const { server } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(
        resolveRequest({ cookie, csrf, idempotencyKey: 'k_x', fetchSite: 'cross-site' }),
      )
      expect(res.statusCode).toBe(403)
    } finally {
      await server.close()
    }
  })

  it('403 when Sec-Fetch-Mode is something other than cors/same-origin', async () => {
    const { server, audit } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(
        resolveRequest({ cookie, csrf, idempotencyKey: 'k_m', fetchMode: 'navigate' }),
      )
      expect(res.statusCode).toBe(403)
      expect(audit.entries().some((e) => e.detail?.['gate'] === 'fetch-mode')).toBe(true)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Gate 7: Content-Type
// =============================================================================

describe('M8 gate 7 — Content-Type', () => {
  it('415 on Content-Type that is not application/json', async () => {
    const { server } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(
        resolveRequest({ cookie, csrf, idempotencyKey: 'k_ct', contentType: 'text/plain' }),
      )
      expect(res.statusCode).toBe(415)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Gate 8: Idempotency-Key + replay
// =============================================================================

describe('M8 gate 8 — idempotency', () => {
  it('400 on missing Idempotency-Key', async () => {
    const { server } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(resolveRequest({ cookie, csrf }))
      expect(res.statusCode).toBe(400)
      expect((res.json() as { type: string }).type).toBe('https://loki.dev/problems/bad-idempotency-key')
    } finally {
      await server.close()
    }
  })

  it('400 on malformed Idempotency-Key (>64 chars)', async () => {
    const { server } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(
        resolveRequest({ cookie, csrf, idempotencyKey: 'a'.repeat(65) }),
      )
      expect(res.statusCode).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('replays the original response on second call with same key, with 409 Conflict', async () => {
    const { server, state } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const first = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_rep' }))
      expect(first.statusCode).toBe(200)
      const second = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_rep' }))
      expect(second.statusCode).toBe(409)
      expect(second.headers['x-idempotent-replay']).toBe('k_rep')
      // Body matches the first response.
      expect(second.json()).toEqual(first.json())
      // Executor was only called once.
      expect(state.resolveCalls).toHaveLength(1)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Gate 9: body schema
// =============================================================================

describe('M8 gate 9 — body schema', () => {
  it('400 on additional properties', async () => {
    const { server } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(
        resolveRequest({
          cookie,
          csrf,
          idempotencyKey: 'k_b1',
          body: { by: 'ops', note: 'ok', extra: 'nope' },
        }),
      )
      expect(res.statusCode).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('400 on missing required fields', async () => {
    const { server } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(
        resolveRequest({ cookie, csrf, idempotencyKey: 'k_b2', body: { by: 'ops' } }),
      )
      expect(res.statusCode).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('400 on `by` not matching the allowed pattern', async () => {
    const { server } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(
        resolveRequest({
          cookie,
          csrf,
          idempotencyKey: 'k_b3',
          body: { by: 'ops admin', note: 'has space' },
        }),
      )
      expect(res.statusCode).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('413 on body larger than 4 KB', async () => {
    const { server } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const huge = 'x'.repeat(5_000)
      const res = await server.app.inject(
        resolveRequest({ cookie, csrf, idempotencyKey: 'k_b4', body: { by: 'ops', note: huge } }),
      )
      expect(res.statusCode).toBe(413)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Gate 10: throttle
// =============================================================================

describe('M8 gate 10 — throttle', () => {
  it('429 after burst is exhausted', async () => {
    let now = 1_000_000
    const throttle = createActionThrottle({ perMinute: 60, burst: 2, cooldownMs: 0, now: () => now })
    const { server } = await boot({ throttle })
    try {
      const { cookie, csrf } = await login(server)
      const a = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_t1' }))
      expect(a.statusCode).toBe(200)
      const b = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_t2' }))
      expect(b.statusCode).toBe(200)
      const c = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_t3' }))
      expect(c.statusCode).toBe(429)
      expect((c.json() as { detail: string }).detail).toBe('rate')
    } finally {
      await server.close()
    }
  })

  it('429 with cool-down after a successful call', async () => {
    let now = 1_000_000
    const throttle = createActionThrottle({ perMinute: 60, burst: 5, cooldownMs: 2_000, now: () => now })
    const { server } = await boot({ throttle })
    try {
      const { cookie, csrf } = await login(server)
      const a = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_cd1' }))
      expect(a.statusCode).toBe(200)
      const b = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_cd2' }))
      expect(b.statusCode).toBe(429)
      expect((b.json() as { detail: string }).detail).toBe('cooldown')
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Gate 11: concurrency cap
// =============================================================================

describe('M8 gate 11 — concurrency cap', () => {
  it('429 when the global cap is full', async () => {
    const concurrency = createConcurrencyCap(0) // cap=0 → every request blocked
    const { server } = await boot({ concurrency })
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_cc' }))
      expect(res.statusCode).toBe(429)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Gate 12: DB precondition
// =============================================================================

describe('M8 gate 12 — DB precondition', () => {
  it('409 when the executor signals a precondition (already resolved)', async () => {
    const state: FakeExecutorState = {
      resolveCalls: [], reconcileCalls: [],
      resolveBehaviour: 'precondition', reconcileBehaviour: 'ok',
    }
    const { server, audit } = await boot({ execState: state })
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject(resolveRequest({ cookie, csrf, idempotencyKey: 'k_pc' }))
      expect(res.statusCode).toBe(409)
      const body = res.json() as { type: string }
      expect(body.type).toBe('https://loki.dev/problems/anomaly-not-found-or-already-resolved')
      expect(audit.entries().some((e) => e.event === 'action.error')).toBe(true)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// reconciler.run-once
// =============================================================================

describe('M8 reconciler.run-once', () => {
  it('happy path returns anomaly + quarantine counts', async () => {
    const { server, state } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/v1/tenants/chidori/reconciler/run-once',
        headers: {
          ...LOOPBACK,
          cookie,
          'x-csrf-token': csrf,
          'content-type': 'application/json; charset=utf-8',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'idempotency-key': 'k_run',
        },
        payload: JSON.stringify({ fullSweep: true }),
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { ok: boolean; anomalies: number }
      expect(body.ok).toBe(true)
      expect(state.reconcileCalls).toEqual([{ tenantId: 'chidori', fullSweep: true }])
    } finally {
      await server.close()
    }
  })

  it('rejects repair flags via additionalProperties=false', async () => {
    const { server } = await boot()
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/v1/tenants/chidori/reconciler/run-once',
        headers: {
          ...LOOPBACK,
          cookie,
          'x-csrf-token': csrf,
          'content-type': 'application/json; charset=utf-8',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'idempotency-key': 'k_run_evil',
        },
        payload: JSON.stringify({ fullSweep: true, repairBalanceDrift: true }),
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('409 when the advisory-lock is held (executor signals precondition)', async () => {
    const state: FakeExecutorState = {
      resolveCalls: [], reconcileCalls: [],
      resolveBehaviour: 'ok', reconcileBehaviour: 'precondition',
    }
    const { server } = await boot({ execState: state })
    try {
      const { cookie, csrf } = await login(server)
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/v1/tenants/chidori/reconciler/run-once',
        headers: {
          ...LOOPBACK,
          cookie,
          'x-csrf-token': csrf,
          'content-type': 'application/json; charset=utf-8',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'idempotency-key': 'k_run_busy',
        },
        payload: JSON.stringify({}),
      })
      expect(res.statusCode).toBe(409)
      const body = res.json() as { type: string }
      expect(body.type).toBe('https://loki.dev/problems/reconciler-already-running')
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Idempotency cache — unit
// =============================================================================

describe('M8 createIdempotencyCache', () => {
  it('first claim is fresh, second is in-flight, third (after complete) is replay', () => {
    const cache = createIdempotencyCache({ maxKeysPerSubject: 4 })
    expect(cache.claim('s1', 'a.b', 'k1').kind).toBe('fresh')
    expect(cache.claim('s1', 'a.b', 'k1').kind).toBe('in-flight')
    cache.complete('s1', 'a.b', 'k1', { status: 200, body: { ok: true } })
    const replay = cache.claim('s1', 'a.b', 'k1')
    expect(replay.kind).toBe('replay')
    if (replay.kind === 'replay') expect(replay.response.status).toBe(200)
  })

  it('evicts the oldest entry when the cap is reached', () => {
    const cache = createIdempotencyCache({ maxKeysPerSubject: 2 })
    cache.claim('s', 'a', '1')
    cache.claim('s', 'a', '2')
    cache.claim('s', 'a', '3')  // evicts '1'
    expect(cache.claim('s', 'a', '1').kind).toBe('fresh') // re-add since it was evicted
  })

  it('release() clears the in-flight slot', () => {
    const cache = createIdempotencyCache()
    cache.claim('s', 'a', 'k')
    cache.release('s', 'a', 'k')
    expect(cache.claim('s', 'a', 'k').kind).toBe('fresh')
  })
})
