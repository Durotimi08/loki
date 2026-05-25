/**
 * M2 security baseline — `app.inject`-based tests, one block per control.
 * No Postgres needed: a fake ReadEngine is injected, all assertions are
 * on response shape / headers / audit-log entries.
 */
import {
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '@loki/core'
import type { HealthReport } from '@loki/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryAuditLog } from '../../../src/dashboard/audit.js'
import type { ReadEngine } from '../../../src/dashboard/read-engine.js'
import {
  type DashboardServer,
  startDashboardServer,
} from '../../../src/dashboard/server.js'
import { safeJsonInScript } from '../../../src/dashboard/security/json-encoder.js'

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

const HEALTHY: HealthReport = {
  ok: true,
  nowMs: 1_000_000,
  primary: { ok: true, latencyMs: 4, lsn: '0/0' },
  replica: null,
  migrations: { applied: true, count: 1 },
}

function fakeEngine(): ReadEngine {
  return {
    health: async () => HEALTHY,
    forTenant: () => {
      throw new Error('forTenant not used in M2 tests')
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

const HOST = '127.0.0.1:4488'
const LOOPBACK = { host: HOST } as const
const SAME_ORIGIN_FETCH = {
  host: HOST,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
} as const

type Harness = {
  server: DashboardServer
  audit: ReturnType<typeof createMemoryAuditLog>
}

async function boot(extra: Partial<Parameters<typeof startDashboardServer>[2]> = {}): Promise<Harness> {
  const audit = createMemoryAuditLog()
  const server = await startDashboardServer(config, schema, {
    host: '127.0.0.1',
    port: 4488,
    skipListen: true,
    engine: fakeEngine(),
    audit,
    ...extra,
  })
  return { server, audit }
}

// =============================================================================
// §8.2 Host allowlist (DNS rebinding)
// =============================================================================

describe('M2 §8.2 Host allowlist', () => {
  it('accepts loopback Host', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: { host: '127.0.0.1:4488' },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('421 + audit on Host that is not in the allowlist (DNS rebinding)', async () => {
    const { server, audit } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: { host: 'evil.example:4488' },
      })
      expect(res.statusCode).toBe(421)
      expect(audit.entries().some((e) => e.event === 'host-allowlist.deny')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('421 when Host header is missing entirely', async () => {
    // light-my-request always sets some Host; force empty via override.
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: { host: '' },
      })
      expect(res.statusCode).toBe(421)
    } finally {
      await server.close()
    }
  })

  it('accepts an operator-configured allowedHost', async () => {
    const { server } = await boot({ allowedHosts: ['dashboard.local:4488'] })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: { host: 'dashboard.local:4488' },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// §8.3 Sec-Fetch + CORS
// =============================================================================

describe('M2 §8.3 Fetch-Metadata + CORS', () => {
  it('allows Sec-Fetch-Site: same-origin', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: SAME_ORIGIN_FETCH,
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('403 + audit on Sec-Fetch-Site: cross-site', async () => {
    const { server, audit } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: { ...LOOPBACK, 'sec-fetch-site': 'cross-site' },
      })
      expect(res.statusCode).toBe(403)
      expect(audit.entries().some((e) => e.event === 'fetch-metadata.deny')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('403 on Origin not in allowlist', async () => {
    const { server, audit } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: { ...LOOPBACK, origin: 'https://evil.example' },
      })
      expect(res.statusCode).toBe(403)
      expect(audit.entries().some((e) => e.event === 'fetch-metadata.origin-deny')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('allows missing Sec-Fetch-* in M2 (non-browser clients)', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('OPTIONS preflight → 403, never emits Access-Control-Allow-Origin', async () => {
    const { server, audit } = await boot()
    try {
      const res = await server.app.inject({
        method: 'OPTIONS',
        url: '/api/v1/version',
        headers: { ...LOOPBACK, origin: 'https://evil.example' },
      })
      expect(res.statusCode).toBe(403)
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
      expect(audit.entries().some((e) => e.event === 'cors.preflight-deny')).toBe(true)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// §8.7 Security headers
// =============================================================================

describe('M2 §8.7 Security headers', () => {
  let server: DashboardServer
  beforeEach(async () => {
    ;({ server } = await boot())
  })

  async function fetchVersion(): Promise<Awaited<ReturnType<typeof server.app.inject>>> {
    return server.app.inject({
      method: 'GET',
      url: '/api/v1/version',
      headers: LOOPBACK,
    })
  }

  it('sets a strict CSP', async () => {
    const res = await fetchVersion()
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("require-trusted-types-for 'script'")
    await server.close()
  })

  it('sets the rest of the hardening headers', async () => {
    const res = await fetchVersion()
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp')
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.headers['vary']).toBe('Cookie, Authorization')
    expect(res.headers['permissions-policy']).toContain('camera=()')
    await server.close()
  })

  it('strips Server / X-Powered-By', async () => {
    const res = await fetchVersion()
    expect(res.headers['server']).toBeUndefined()
    expect(res.headers['x-powered-by']).toBeUndefined()
    await server.close()
  })

  it('omits HSTS when not behind TLS', async () => {
    const res = await fetchVersion()
    expect(res.headers['strict-transport-security']).toBeUndefined()
    await server.close()
  })
})

describe('M2 §8.7 Security headers (TLS mode)', () => {
  it('emits HSTS when trustProxyTls is set', async () => {
    // Configure unsafe-host + auth + allowedHosts so the refusal matrix accepts trustProxyTls.
    // For this header test, we still bind loopback so the request path stays simple.
    const audit = createMemoryAuditLog()
    const server = await startDashboardServer(config, schema, {
      host: '127.0.0.1',
      port: 4488,
      skipListen: true,
      engine: fakeEngine(),
      audit,
      trustProxyTls: true,
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: LOOPBACK,
      })
      expect(res.headers['strict-transport-security']).toContain('max-age=31536000')
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// §8.7 JSON-in-HTML encoder
// =============================================================================

describe('M2 §8.19.6 safeJsonInScript', () => {
  it('escapes <, >, &, apostrophe', () => {
    const out = safeJsonInScript({ s: "</script><img onerror='alert(1)'>" })
    expect(out).not.toContain('</script>')
    expect(out).not.toContain('>')
    expect(out).not.toContain('<')
    expect(out).not.toContain("'")
  })

  it('escapes U+2028 and U+2029', () => {
    // Build the value via String.fromCharCode so the test source itself
    // doesn't carry literal line terminators.
    const s = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`
    const out = safeJsonInScript({ s })
    expect(out).toContain('\\u2028')
    expect(out).toContain('\\u2029')
    expect(out).not.toContain(String.fromCharCode(0x2028))
    expect(out).not.toContain(String.fromCharCode(0x2029))
  })

  it('round-trips through JSON.parse', () => {
    const original = { greeting: "hi, it's <fine>" }
    const round = JSON.parse(safeJsonInScript(original))
    expect(round).toEqual(original)
  })
})

// =============================================================================
// §8.7 RFC 7807 problem doc / 404
// =============================================================================

describe('M2 §8.7 RFC 7807 problem doc', () => {
  it('404 on unknown route is a problem doc', async () => {
    const { server } = await boot()
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/nope',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(404)
      expect(res.headers['content-type']).toContain('application/problem+json')
      const body = res.json() as Record<string, unknown>
      expect(body['type']).toBe('https://loki.dev/problems/not-found')
      expect(body['status']).toBe(404)
      expect(body['title']).toBe('Not Found')
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// §8.8 Smuggling guard
// =============================================================================

describe('M2 §8.8 smuggling guard', () => {
  it('rejects TE + CL combination', async () => {
    const { server, audit } = await boot()
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/v1/version',
        headers: {
          ...LOOPBACK,
          'transfer-encoding': 'chunked',
          'content-length': '5',
          'content-type': 'application/json',
        },
        payload: '"hi"',
      })
      expect(res.statusCode).toBe(400)
      expect(audit.entries().some((e) => e.event === 'smuggling.deny')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('rejects TE other than chunked', async () => {
    const { server, audit } = await boot()
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/v1/version',
        headers: { ...LOOPBACK, 'transfer-encoding': 'gzip' },
        payload: 'x',
      })
      expect(res.statusCode).toBe(400)
      expect(audit.entries().some((e) => e.event === 'smuggling.deny')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('rejects multi-value Content-Length', async () => {
    const { server, audit } = await boot()
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/v1/version',
        headers: { ...LOOPBACK, 'content-length': '5, 6', 'content-type': 'application/json' },
        payload: '"x"',
      })
      expect(res.statusCode).toBe(400)
      expect(audit.entries().some((e) => e.event === 'smuggling.deny')).toBe(true)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// §8.13 Rate limit
// =============================================================================

describe('M2 §8.13 rate limit', () => {
  it('429 + Retry-After + audit when burst is exceeded', async () => {
    const { server, audit } = await boot({
      rateLimit: { perMinute: 60, burst: 3 },
    })
    try {
      // Three successes (burst = 3), the fourth is denied.
      for (let i = 0; i < 3; i++) {
        const r = await server.app.inject({
          method: 'GET',
          url: '/api/v1/version',
          headers: LOOPBACK,
        })
        expect(r.statusCode).toBe(200)
      }
      const r4 = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: LOOPBACK,
      })
      expect(r4.statusCode).toBe(429)
      expect(r4.headers['retry-after']).toBeDefined()
      expect(audit.entries().some((e) => e.event === 'rate-limit.deny')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('refills as time advances', async () => {
    let now = 1_000_000
    const { server } = await boot({
      rateLimit: { perMinute: 60, burst: 2, now: () => now },
    })
    try {
      for (let i = 0; i < 2; i++) {
        const r = await server.app.inject({
          method: 'GET',
          url: '/api/v1/version',
          headers: LOOPBACK,
        })
        expect(r.statusCode).toBe(200)
      }
      // Third request immediately → denied.
      const r3 = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: LOOPBACK,
      })
      expect(r3.statusCode).toBe(429)
      // Advance a minute → bucket refills above burst.
      now += 60_000
      const r4 = await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: LOOPBACK,
      })
      expect(r4.statusCode).toBe(200)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// §8.14 Audit log
// =============================================================================

describe('M2 §8.14 audit log', () => {
  it('captures every refusal event with a timestamp', async () => {
    const { server, audit } = await boot()
    try {
      // Trigger a host-allowlist refusal.
      await server.app.inject({
        method: 'GET',
        url: '/api/v1/version',
        headers: { host: 'evil.example:4488' },
      })
      // Trigger a CORS refusal.
      await server.app.inject({
        method: 'OPTIONS',
        url: '/api/v1/version',
        headers: LOOPBACK,
      })
      const events = audit.entries().map((e) => e.event)
      expect(events).toContain('host-allowlist.deny')
      expect(events).toContain('cors.preflight-deny')
      for (const e of audit.entries()) {
        expect(typeof e.ts).toBe('string')
        expect(e.ts).toMatch(/T\d\d:\d\d:\d\d/)
      }
    } finally {
      await server.close()
    }
  })
})
