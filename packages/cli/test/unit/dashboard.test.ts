/**
 * M1 unit tests for the dashboard skeleton. No Postgres — we fabricate
 * a minimal `ReadEngine` and inject it. Integration tests against a
 * real Postgres land alongside the security baseline (M2).
 */
import {
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
  LOKI_CORE_VERSION,
} from '@loki/core'
import type { HealthReport } from '@loki/core'
import { describe, expect, it } from 'vitest'
import { applyRefusalMatrix, startDashboardServer } from '../../src/dashboard/server.js'
import type { ReadEngine } from '../../src/dashboard/read-engine.js'
import { fingerprintSchema } from '../../src/dashboard/schema-fingerprint.js'
import { CLI_VERSION } from '../../src/version.js'

// =============================================================================
// Fixture
// =============================================================================

const Org = defineTenant('Org')
const User = defineActor('User', { accounts: { wallet: { currency: 'NGN' } } })
const Driver = defineActor('Driver', { accounts: { balance: { currency: 'NGN' } } })
const Simple = defineTransaction('Simple', {
  states: ['pending', 'done'],
  initial: 'pending',
  terminal: ['done'],
  participants: { user: User, driver: Driver },
  transitions: (t) => ({ finish: t({ from: 'pending', to: 'done', by: [User] }) }),
})
const schema = defineSchema({ tenant: Org, actors: [User, Driver], transactions: [Simple] })

const config = {
  schema,
  connection: { url: 'postgres://unused:unused@localhost:1/unused' },
} as const

function fakeEngine(health: HealthReport): ReadEngine {
  return {
    health: async () => health,
    forTenant: () => {
      throw new Error('fakeEngine: forTenant not implemented for M1 tests')
    },
    admin: {
      tenants: { list: async () => [], get: async () => null },
      schema: { versions: (async () => []) as ReadEngine['admin']['schema']['versions'] },
    },
    decryptPayload: async (v) => v,
    dashboard: {
      tenantSummary: async () => { throw new Error('not used') },
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

const HEALTHY: HealthReport = {
  ok: true,
  nowMs: 1_000_000,
  primary: { ok: true, latencyMs: 4, lsn: '0/0' },
  replica: null,
  migrations: { applied: true, count: 1 },
}

const DEGRADED: HealthReport = {
  ok: false,
  nowMs: 1_000_000,
  primary: { ok: false, error: 'connection refused', latencyMs: 2000 },
  replica: null,
  migrations: { applied: false, count: 0 },
}

// =============================================================================
// Refusal matrix
// =============================================================================

const BASE_REFUSAL = {
  host: '127.0.0.1',
  nodeEnv: 'development',
  allowProd: false,
  unsafeHost: false,
  trustProxyTls: false,
  directTls: false,
  allowedHosts: [] as readonly string[],
  allowActions: false,
  noRedact: false,
  allowProdLeakage: false,
  authScheme: 'none' as const,
}

describe('applyRefusalMatrix', () => {
  it('accepts loopback + development by default', () => {
    expect(() => applyRefusalMatrix({ ...BASE_REFUSAL, host: '127.0.0.1' })).not.toThrow()
    expect(() => applyRefusalMatrix({ ...BASE_REFUSAL, host: '::1' })).not.toThrow()
    expect(() => applyRefusalMatrix({ ...BASE_REFUSAL, host: 'localhost' })).not.toThrow()
  })

  it('refuses production without --allow-prod', () => {
    expect(() => applyRefusalMatrix({ ...BASE_REFUSAL, nodeEnv: 'production' })).toThrow(
      /NODE_ENV=production.*--allow-prod/,
    )
  })

  it('refuses production without auth even when --allow-prod is set', () => {
    expect(() =>
      applyRefusalMatrix({ ...BASE_REFUSAL, nodeEnv: 'production', allowProd: true }),
    ).toThrow(/production requires an auth scheme/)
  })

  it('accepts production with --allow-prod + auth', () => {
    expect(() =>
      applyRefusalMatrix({
        ...BASE_REFUSAL,
        nodeEnv: 'production',
        allowProd: true,
        authScheme: 'bearer',
      }),
    ).not.toThrow()
  })

  it('refuses non-loopback host without --unsafe-host', () => {
    expect(() => applyRefusalMatrix({ ...BASE_REFUSAL, host: '0.0.0.0' })).toThrow(
      /non-loopback.*--unsafe-host/,
    )
    expect(() => applyRefusalMatrix({ ...BASE_REFUSAL, host: '10.0.0.5' })).toThrow(
      /non-loopback.*--unsafe-host/,
    )
  })

  it('refuses --unsafe-host without auth', () => {
    expect(() =>
      applyRefusalMatrix({
        ...BASE_REFUSAL,
        host: '0.0.0.0',
        unsafeHost: true,
        allowedHosts: ['dashboard.example:443'],
        trustProxyTls: true,
      }),
    ).toThrow(/--unsafe-host requires an auth scheme/)
  })

  it('refuses --unsafe-host without allowedHosts', () => {
    expect(() =>
      applyRefusalMatrix({
        ...BASE_REFUSAL,
        host: '0.0.0.0',
        unsafeHost: true,
        trustProxyTls: true,
        authScheme: 'bearer',
      }),
    ).toThrow(/--allowed-host/)
  })

  it('refuses --unsafe-host without TLS', () => {
    expect(() =>
      applyRefusalMatrix({
        ...BASE_REFUSAL,
        host: '0.0.0.0',
        unsafeHost: true,
        allowedHosts: ['dashboard.example:443'],
        authScheme: 'bearer',
      }),
    ).toThrow(/TLS in front/)
  })

  it('accepts non-loopback bind when all gates pass', () => {
    expect(() =>
      applyRefusalMatrix({
        ...BASE_REFUSAL,
        host: '0.0.0.0',
        unsafeHost: true,
        allowedHosts: ['dashboard.example:443'],
        trustProxyTls: true,
        authScheme: 'bearer',
      }),
    ).not.toThrow()
  })

  it('refuses --allow-actions without auth', () => {
    expect(() => applyRefusalMatrix({ ...BASE_REFUSAL, allowActions: true })).toThrow(
      /--allow-actions requires an auth scheme/,
    )
  })

  it('refuses --no-redact in production without --allow-prod-leakage', () => {
    expect(() =>
      applyRefusalMatrix({
        ...BASE_REFUSAL,
        nodeEnv: 'production',
        allowProd: true,
        authScheme: 'bearer',
        noRedact: true,
      }),
    ).toThrow(/--no-redact under NODE_ENV=production/)
  })
})

// =============================================================================
// /api/v1/version
// =============================================================================

describe('GET /api/v1/version', () => {
  it('returns runtime + schema fingerprint without touching the DB', async () => {
    const server = await startDashboardServer(config, schema, {
      host: '127.0.0.1',
      port: 4488,
      skipListen: true,
      engine: fakeEngine(HEALTHY),
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: { host: '127.0.0.1:4488' },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Record<string, unknown>
      expect(body['core']).toBe(LOKI_CORE_VERSION)
      expect(body['cli']).toBe(CLI_VERSION)
      expect(body['schemaFingerprint']).toBe(fingerprintSchema(schema))
      expect(body['schemaVersion']).toBe(schema.version)
      expect(typeof body['startedAt']).toBe('string')
      expect(body['buildHash']).toBe('dev')
      expect(res.headers['cache-control']).toBe('private, no-store')
    } finally {
      await server.close()
    }
  })

  it('schemaFingerprint is stable across multiple boots of the same schema', () => {
    const a = fingerprintSchema(schema)
    const b = fingerprintSchema(schema)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })
})

// =============================================================================
// /api/v1/health
// =============================================================================

describe('GET /api/v1/health', () => {
  it('returns 200 + report when the engine is healthy', async () => {
    const server = await startDashboardServer(config, schema, {
      host: '127.0.0.1',
      port: 4488,
      skipListen: true,
      engine: fakeEngine(HEALTHY),
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { host: '127.0.0.1:4488' },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as HealthReport
      expect(body.ok).toBe(true)
      expect(body.primary.ok).toBe(true)
      expect(res.headers['cache-control']).toBe('private, no-store')
    } finally {
      await server.close()
    }
  })

  it('returns 503 + report when the engine is degraded', async () => {
    const server = await startDashboardServer(config, schema, {
      host: '127.0.0.1',
      port: 4488,
      skipListen: true,
      engine: fakeEngine(DEGRADED),
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { host: '127.0.0.1:4488' },
      })
      expect(res.statusCode).toBe(503)
      const body = res.json() as HealthReport
      expect(body.ok).toBe(false)
      expect(body.primary.ok).toBe(false)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Boot refuses bad inputs
// =============================================================================

describe('startDashboardServer refusal', () => {
  it('refuses non-loopback host without --unsafe-host', async () => {
    await expect(
      startDashboardServer(config, schema, {
        host: '0.0.0.0',
        port: 0,
        engine: fakeEngine(HEALTHY),
      }),
    ).rejects.toThrow(/non-loopback/)
  })

  it('refuses NODE_ENV=production without --allow-prod', async () => {
    await expect(
      startDashboardServer(config, schema, {
        host: '127.0.0.1',
        port: 0,
        engine: fakeEngine(HEALTHY),
        nodeEnv: 'production',
      }),
    ).rejects.toThrow(/production/)
  })
})

// =============================================================================
// Help wiring
// =============================================================================

describe('runner --help', () => {
  it('mentions the dashboard subcommand', async () => {
    const { run, bufferedIo } = await import('../../src/index.js')
    const io = bufferedIo()
    const code = await run({ args: ['--help'], io })
    expect(code).toBe(0)
    expect(io.stdout()).toContain('dashboard')
  })
})
