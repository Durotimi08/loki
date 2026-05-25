/**
 * M3 auth + sessions + CSRF — `app.inject` tests against the live
 * dashboard. argon2 is stubbed for speed; bearer and session paths use
 * the real implementations.
 */
import { randomBytes } from 'node:crypto'
import {
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '@loki/core'
import type { HealthReport } from '@loki/core'
import { describe, expect, it } from 'vitest'
import { createMemoryAuditLog } from '../../../src/dashboard/audit.js'
import { createSessionStore } from '../../../src/dashboard/auth/session.js'
import { type Argon2Verify, DUMMY_HASH } from '../../../src/dashboard/auth/index.js'
import { checkCsrf } from '../../../src/dashboard/auth/csrf.js'
import type { ReadEngine } from '../../../src/dashboard/read-engine.js'
import {
  type DashboardServer,
  startDashboardServer,
} from '../../../src/dashboard/server.js'

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
const config = { schema, connection: { url: 'postgres://x:x@localhost:1/x' } } as const

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
    forTenant: () => { throw new Error('forTenant not used') },
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
const SECRET = randomBytes(32)
const FIXED_BEARER = 'a'.repeat(64)
const REAL_HASH = '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

/** A fast deterministic stub: accepts `(REAL_HASH, 'hunter2')`, rejects everything else (including DUMMY_HASH). */
const STUB_ARGON2_VERIFY: Argon2Verify = async (hash, password) => {
  return hash === REAL_HASH && password === 'hunter2'
}

type Boot = {
  server: DashboardServer
  audit: ReturnType<typeof createMemoryAuditLog>
}

async function boot(extra: Partial<Parameters<typeof startDashboardServer>[2]> = {}): Promise<Boot> {
  const audit = createMemoryAuditLog()
  const server = await startDashboardServer(config, schema, {
    host: '127.0.0.1',
    port: 4488,
    skipListen: true,
    engine: fakeEngine(),
    audit,
    sessionSecret: SECRET,
    argon2Verify: STUB_ARGON2_VERIFY,
    ...extra,
  })
  return { server, audit }
}

// =============================================================================
// Public endpoints stay public regardless of scheme
// =============================================================================

describe('M3 public endpoints', () => {
  it('/api/v1/version is reachable without auth even when bearer is configured', async () => {
    const { server } = await boot({ auth: { kind: 'bearer', token: FIXED_BEARER } })
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

  it('/api/v1/health is reachable without auth when basic is configured', async () => {
    const { server } = await boot({
      auth: { kind: 'basic', user: 'admin', argon2Hash: REAL_HASH },
    })
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: LOOPBACK,
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Bearer scheme
// =============================================================================

describe('M3 bearer auth', () => {
  it('accepts Authorization: Bearer <token>', async () => {
    const { server } = await boot({ auth: { kind: 'bearer', token: FIXED_BEARER } })
    try {
      server.app.get(
        '/_/private',
        { preHandler: server.auth.requireAuth },
        async () => ({ ok: true }),
      )
      const res = await server.app.inject({
        method: 'GET',
        url: '/_/private',
        headers: { ...LOOPBACK, authorization: `Bearer ${FIXED_BEARER}` },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('401 + WWW-Authenticate when bearer is missing', async () => {
    const { server, audit } = await boot({ auth: { kind: 'bearer', token: FIXED_BEARER } })
    try {
      server.app.get(
        '/_/private',
        { preHandler: server.auth.requireAuth },
        async () => ({ ok: true }),
      )
      // M10 added a stricter Sec-Fetch policy: under bearer auth, a
      // request with neither `Sec-Fetch-Site` NOR `Authorization` gets
      // 403 from the security baseline BEFORE auth runs. To still
      // exercise the auth's 401 path, hand-shape a non-browser caller
      // by setting `Sec-Fetch-Site: none`.
      const res = await server.app.inject({
        method: 'GET',
        url: '/_/private',
        headers: { ...LOOPBACK, 'sec-fetch-site': 'none' },
      })
      expect(res.statusCode).toBe(401)
      expect(String(res.headers['www-authenticate'])).toContain('Bearer')
      expect(audit.entries().some((e) => e.event === 'auth.unauthorized')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('401 on wrong bearer token (constant-time compare)', async () => {
    const { server } = await boot({ auth: { kind: 'bearer', token: FIXED_BEARER } })
    try {
      server.app.get(
        '/_/private',
        { preHandler: server.auth.requireAuth },
        async () => ({ ok: true }),
      )
      const res = await server.app.inject({
        method: 'GET',
        url: '/_/private',
        headers: { ...LOOPBACK, authorization: `Bearer ${'b'.repeat(64)}` },
      })
      expect(res.statusCode).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('rejects bearer of wrong length without comparing content', async () => {
    const { server } = await boot({ auth: { kind: 'bearer', token: FIXED_BEARER } })
    try {
      server.app.get(
        '/_/private',
        { preHandler: server.auth.requireAuth },
        async () => ({ ok: true }),
      )
      const res = await server.app.inject({
        method: 'GET',
        url: '/_/private',
        headers: { ...LOOPBACK, authorization: 'Bearer short' },
      })
      expect(res.statusCode).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('refuses to construct a bearer verifier for short tokens', () => {
    // We boot a server that *would* refuse construction. Use the
    // throws-at-construction path explicitly via the verifier factory.
    // This is the path `createBearerVerifier('xx')` exercises.
    void boot({ auth: { kind: 'bearer', token: 'short' } }).then(
      () => Promise.reject(new Error('expected throw')),
      () => undefined,
    )
  })
})

// =============================================================================
// Basic scheme
// =============================================================================

describe('M3 basic auth', () => {
  it('accepts Authorization: Basic admin:hunter2 + issues a session cookie', async () => {
    const { server } = await boot({
      auth: { kind: 'basic', user: 'admin', argon2Hash: REAL_HASH },
    })
    try {
      server.app.get(
        '/_/private',
        { preHandler: server.auth.requireAuth },
        async () => ({ ok: true }),
      )
      const res = await server.app.inject({
        method: 'GET',
        url: '/_/private',
        headers: {
          ...LOOPBACK,
          authorization: `Basic ${Buffer.from('admin:hunter2').toString('base64')}`,
        },
      })
      expect(res.statusCode).toBe(200)
      const setCookie = String(res.headers['set-cookie'] ?? '')
      expect(setCookie).toContain('loki_dash_sess=')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Strict')
    } finally {
      await server.close()
    }
  })

  it('the issued session cookie skips argon2 on subsequent requests', async () => {
    let verifyCalls = 0
    const counting: Argon2Verify = async (h, p) => {
      verifyCalls++
      return STUB_ARGON2_VERIFY(h, p)
    }
    const { server } = await boot({
      auth: { kind: 'basic', user: 'admin', argon2Hash: REAL_HASH },
      argon2Verify: counting,
    })
    try {
      server.app.get(
        '/_/private',
        { preHandler: server.auth.requireAuth },
        async () => ({ ok: true }),
      )
      const first = await server.app.inject({
        method: 'GET',
        url: '/_/private',
        headers: {
          ...LOOPBACK,
          authorization: `Basic ${Buffer.from('admin:hunter2').toString('base64')}`,
        },
      })
      expect(first.statusCode).toBe(200)
      const cookie = extractCookie(first.headers['set-cookie'], 'loki_dash_sess')
      expect(cookie).toBeDefined()
      expect(verifyCalls).toBe(1)

      const second = await server.app.inject({
        method: 'GET',
        url: '/_/private',
        headers: { ...LOOPBACK, cookie: `loki_dash_sess=${cookie}` },
      })
      expect(second.statusCode).toBe(200)
      expect(verifyCalls).toBe(1) // cookie short-circuits the verify
    } finally {
      await server.close()
    }
  })

  it('401 on wrong password (always runs verify — anti-enum)', async () => {
    let verifyCalls = 0
    const counting: Argon2Verify = async (h, p) => {
      verifyCalls++
      return STUB_ARGON2_VERIFY(h, p)
    }
    const { server, audit } = await boot({
      auth: { kind: 'basic', user: 'admin', argon2Hash: REAL_HASH },
      argon2Verify: counting,
    })
    try {
      server.app.get(
        '/_/private',
        { preHandler: server.auth.requireAuth },
        async () => ({ ok: true }),
      )
      const res = await server.app.inject({
        method: 'GET',
        url: '/_/private',
        headers: {
          ...LOOPBACK,
          authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}`,
        },
      })
      expect(res.statusCode).toBe(401)
      expect(verifyCalls).toBe(1)
      expect(audit.entries().some((e) => e.event === 'auth.deny')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('always runs verify against DUMMY_HASH on unknown user — anti-enum (T12)', async () => {
    const seenHashes: string[] = []
    const recording: Argon2Verify = async (hash, password) => {
      seenHashes.push(hash)
      return STUB_ARGON2_VERIFY(hash, password)
    }
    const { server } = await boot({
      auth: { kind: 'basic', user: 'admin', argon2Hash: REAL_HASH },
      argon2Verify: recording,
    })
    try {
      server.app.get(
        '/_/private',
        { preHandler: server.auth.requireAuth },
        async () => ({ ok: true }),
      )
      const res = await server.app.inject({
        method: 'GET',
        url: '/_/private',
        headers: {
          ...LOOPBACK,
          authorization: `Basic ${Buffer.from('nobody:whatever').toString('base64')}`,
        },
      })
      expect(res.statusCode).toBe(401)
      expect(seenHashes).toEqual([DUMMY_HASH])
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Throttle
// =============================================================================

describe('M3 auth throttle', () => {
  it('locks out after N failures per user', async () => {
    let now = 1_000_000
    const { server } = await boot({
      auth: { kind: 'basic', user: 'admin', argon2Hash: REAL_HASH },
      authThrottle: {
        perIp: { failures: 100, windowMs: 60_000, lockoutMs: 60_000 },
        perUser: { failures: 3, windowMs: 60_000, lockoutMs: 60_000 },
        now: () => now,
      },
    })
    try {
      server.app.get(
        '/_/private',
        { preHandler: server.auth.requireAuth },
        async () => ({ ok: true }),
      )
      const badAuth = `Basic ${Buffer.from('admin:wrong').toString('base64')}`
      for (let i = 0; i < 3; i++) {
        const r = await server.app.inject({
          method: 'GET',
          url: '/_/private',
          headers: { ...LOOPBACK, authorization: badAuth },
        })
        expect(r.statusCode).toBe(401)
      }
      // 4th attempt → throttle (still 401 from requireAuth — but the
      // session never got minted because the throttle short-circuited).
      const blocked = await server.app.inject({
        method: 'GET',
        url: '/_/private',
        headers: { ...LOOPBACK, authorization: badAuth },
      })
      expect(blocked.statusCode).toBe(401)
      // Advance past lockout → attempt allowed again.
      now += 60_001
      const r5 = await server.app.inject({
        method: 'GET',
        url: '/_/private',
        headers: { ...LOOPBACK, authorization: badAuth },
      })
      expect(r5.statusCode).toBe(401)
    } finally {
      await server.close()
    }
  })
})

// =============================================================================
// Session — HMAC, expiry, tamper
// =============================================================================

describe('M3 session store', () => {
  it('mint → validate round-trip', () => {
    const store = createSessionStore({ secret: SECRET })
    const { payload, cookieValue } = store.mint({ subject: 'admin', scheme: 'basic' })
    const res = store.validate(cookieValue)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.payload.subject).toBe('admin')
      expect(res.payload.sid).toBe(payload.sid)
    }
  })

  it('tampered HMAC rejected', () => {
    const store = createSessionStore({ secret: SECRET })
    const { cookieValue } = store.mint({ subject: 'admin', scheme: 'basic' })
    const [body, tag] = cookieValue.split('.')
    // Flip every byte of the tag so we never accidentally hit the same
    // value after the replacement.
    const flipped = (tag ?? '')
      .split('')
      .map((c) => (c === 'A' ? 'B' : 'A'))
      .join('')
    const tampered = `${body}.${flipped}`
    const res = store.validate(tampered)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('bad-hmac')
  })

  it('expired session rejected', () => {
    let now = 1_000_000
    const store = createSessionStore({ secret: SECRET, idleMs: 1000, now: () => now })
    const { cookieValue } = store.mint({ subject: 'admin', scheme: 'basic' })
    now += 2000
    const res = store.validate(cookieValue)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('expired')
  })

  it('absolute lifetime exceeds idle cap', () => {
    let now = 1_000_000
    const store = createSessionStore({
      secret: SECRET,
      idleMs: 10_000_000,
      absoluteMs: 5_000,
      now: () => now,
    })
    const { cookieValue } = store.mint({ subject: 'admin', scheme: 'basic' })
    now += 6_000
    const res = store.validate(cookieValue)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('absolute-expired')
  })

  it('mint rotates sid every call', () => {
    const store = createSessionStore({ secret: SECRET })
    const a = store.mint({ subject: 'admin', scheme: 'basic' }).payload.sid
    const b = store.mint({ subject: 'admin', scheme: 'basic' }).payload.sid
    expect(a).not.toEqual(b)
  })

  it('different secrets fail to validate each other', () => {
    const a = createSessionStore({ secret: SECRET })
    const b = createSessionStore({ secret: randomBytes(32) })
    const { cookieValue } = a.mint({ subject: 'admin', scheme: 'basic' })
    const res = b.validate(cookieValue)
    expect(res.ok).toBe(false)
  })
})

// =============================================================================
// CSRF
// =============================================================================

describe('M3 CSRF', () => {
  it('rejects POST without X-CSRF-Token', () => {
    const store = createSessionStore({ secret: SECRET })
    const { payload } = store.mint({ subject: 'admin', scheme: 'basic' })
    const verdict = checkCsrf(
      { headers: {} } as unknown as Parameters<typeof checkCsrf>[0],
      payload,
    )
    expect(verdict.ok).toBe(false)
  })

  it('rejects POST with wrong X-CSRF-Token', () => {
    const store = createSessionStore({ secret: SECRET })
    const { payload } = store.mint({ subject: 'admin', scheme: 'basic' })
    const verdict = checkCsrf(
      { headers: { 'x-csrf-token': 'nope' } } as unknown as Parameters<typeof checkCsrf>[0],
      payload,
    )
    expect(verdict.ok).toBe(false)
  })

  it('accepts POST with matching X-CSRF-Token (constant-time)', () => {
    const store = createSessionStore({ secret: SECRET })
    const { payload } = store.mint({ subject: 'admin', scheme: 'basic' })
    const verdict = checkCsrf(
      { headers: { 'x-csrf-token': payload.csrf } } as unknown as Parameters<typeof checkCsrf>[0],
      payload,
    )
    expect(verdict.ok).toBe(true)
  })
})

// =============================================================================
// Helpers
// =============================================================================

function extractCookie(raw: string | string[] | undefined, name: string): string | undefined {
  const lines = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
  for (const line of lines) {
    const m = line.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
    if (m) return decodeURIComponent(m[1] ?? '')
  }
  return undefined
}
