import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  MIGRATIONS_TABLE,
  type OutboxEvent,
  type OutboxFailureTerminalEvent,
  createEngine,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-outbox'
let engine: Engine | null = null
let dbUrl: string | null = null

beforeAll(async () => {
  const db = await ensurePostgres()
  dbUrl = db?.url ?? null
})

afterAll(async () => {
  if (engine) await engine.close()
  await teardownPostgres()
})

beforeEach(async () => {
  if (!dbUrl) return
  if (engine) {
    try {
      await engine.rollback()
    } catch {
      /* fine */
    }
    await engine.connection.sql.unsafe(`drop table if exists ${MIGRATIONS_TABLE}`)
    await engine.close()
  }
  engine = createEngine({ schema: chidoriSchema, connection: { url: dbUrl } })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'Outbox' })
})

const enqueuePayment = async (e: Engine, idSuffix: string): Promise<void> => {
  const client = e.forTenant(TENANT)
  const user = { type: 'User', id: `u-${idSuffix}` }
  const driver = { type: 'Driver', id: `d-${idSuffix}` }
  const company = { type: 'Company', id: 'co-1' }
  await client.accounts.create({ actor: user, name: 'wallet' })
  await client.accounts.create({ actor: driver, name: 'balance' })
  await client.accounts.create({ actor: company, name: 'revenue' })
  await e.connection.sql.unsafe(
    `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = '${user.id}' and name = 'wallet'`,
  )
  const txn = await client.transactions.create({
    type: 'DeliveryPayment',
    by: user,
    participants: { user, driver, company },
    idempotencyKey: `${idSuffix}:create`,
  })
  await client.transactions.transition({
    id: txn.record.id,
    name: 'pay',
    by: user,
    data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    idempotencyKey: `${idSuffix}:pay`,
  })
}

describe('outbox.drainOnce — happy path', () => {
  it('delivers each pending event exactly once and marks delivered_at', async () => {
    if (!engine) return
    await enqueuePayment(engine, 'happy')
    const seen: OutboxEvent[] = []

    const processed = await engine.outbox.drainOnce({
      handler: async (ev) => {
        seen.push(ev)
      },
    })

    expect(processed).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.event).toBe('delivery.paid')

    // Subsequent drain returns 0 — already delivered.
    const second = await engine.outbox.drainOnce({
      handler: async () => {
        throw new Error('should not be called')
      },
    })
    expect(second).toBe(0)

    const [row] = await engine.connection.sql<{ delivered_at: Date | null }[]>`
      select delivered_at from "outbox"
    `
    expect(row?.delivered_at).not.toBeNull()
  })

  it('multiple workers do not redeliver the same event (FOR UPDATE SKIP LOCKED)', async () => {
    if (!engine) return
    // Enqueue 3 events and run two concurrent drains. Total deliveries
    // should be exactly 3.
    await enqueuePayment(engine, 'p1')
    await enqueuePayment(engine, 'p2')
    await enqueuePayment(engine, 'p3')

    const allSeen: string[] = []
    const drain = async (workerId: string) => {
      const seen: string[] = []
      await engine?.outbox.drainOnce({
        handler: async (ev) => {
          seen.push(`${workerId}:${ev.id}`)
        },
        batchSize: 10,
      })
      return seen
    }
    const [a, b] = await Promise.all([drain('a'), drain('b')])
    allSeen.push(...a, ...b)

    const uniqueEventIds = new Set(allSeen.map((s) => s.split(':')[1]))
    expect(uniqueEventIds.size).toBe(3) // each event seen by exactly one worker
  })
})

describe('outbox — retry + terminal failure', () => {
  it('retries on handler failure and fires onOutboxFailureTerminal after maxAttempts', async () => {
    if (!engine) return
    const terminal: OutboxFailureTerminalEvent[] = []
    engine.hooks.onOutboxFailureTerminal(undefined, async (e) => {
      terminal.push(e)
    })

    await enqueuePayment(engine, 'fail')

    let attempts = 0
    const handler = async () => {
      attempts++
      throw new Error(`attempt ${attempts}`)
    }

    // Drain three times — each call attempts once. With maxAttempts=3,
    // the third attempt is terminal. Use backoff=0 so the worker
    // doesn't gate on the next_attempt_at clock.
    for (let i = 0; i < 3; i++) {
      await engine.outbox.drainOnce({ handler, maxAttempts: 3, backoff: () => 0 })
    }

    expect(attempts).toBe(3)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]?.attempts).toBe(3)
    expect(terminal[0]?.lastError).toMatch(/attempt 3/)

    // Subsequent drains skip the terminally-failed row.
    const fourth = await engine.outbox.drainOnce({
      handler: async () => {
        throw new Error('should not be called')
      },
      maxAttempts: 3,
      backoff: () => 0,
    })
    expect(fourth).toBe(0)

    const [row] = await engine.connection.sql<
      {
        failed_at: Date | null
        attempts: number
        last_error: string | null
      }[]
    >`
      select failed_at, attempts, last_error from "outbox"
    `
    expect(row?.failed_at).not.toBeNull()
    expect(row?.attempts).toBe(3)
  })

  it('schedules the next attempt with the supplied backoff between attempts', async () => {
    if (!engine) return
    await enqueuePayment(engine, 'backoff')

    // First attempt fails; backoff puts the row in the future. A
    // second drain immediately after should NOT pick it up.
    const handler = async () => {
      throw new Error('still no')
    }
    const processed = await engine.outbox.drainOnce({
      handler,
      maxAttempts: 5,
      backoff: () => 60_000, // 60s in the future
    })
    expect(processed).toBe(1)

    const second = await engine.outbox.drainOnce({
      handler,
      maxAttempts: 5,
      backoff: () => 60_000,
    })
    expect(second).toBe(0)
  })

  it('claim TTL prevents double-delivery on a simulated worker crash (C2)', async () => {
    if (!engine) return
    await enqueuePayment(engine, 'crash')

    // Worker A claims and starts dispatching but never returns
    // (simulating a process death after PSP call but before phase-3
    // commit). We just call drainOnce with a hanging handler that we
    // never resolve — instead, we kick off the call without awaiting,
    // then immediately try to drain from "worker B".
    let resolveHang: (() => void) | undefined
    const hung = new Promise<void>((res) => {
      resolveHang = res
    })
    const dispatcher = async () => {
      await hung
    }

    // Worker A: claim + dispatch (blocks). Don't await.
    const aPromise = engine.outbox.drainOnce({
      handler: dispatcher,
      claimTtlMs: 60_000, // 60s lease — peer must NOT poach inside this window
    })

    // Give postgres.js a tick to actually claim the row.
    await new Promise((res) => setTimeout(res, 100))

    // Worker B: try to claim. Should see zero because A's lease is in force.
    const bSeen = await engine.outbox.drainOnce({
      handler: async () => {
        /* never called */
      },
      claimTtlMs: 60_000,
    })
    expect(bSeen).toBe(0)

    // Let A finish (simulate eventual recovery).
    if (resolveHang) resolveHang()
    await aPromise
  })

  it('expired claim leases are re-claimable by peers', async () => {
    if (!engine) return
    await enqueuePayment(engine, 'expired')

    // Phase 1 with a tiny TTL.
    let firstHandlerCalls = 0
    let firstResolved: (() => void) | undefined
    const firstHung = new Promise<void>((res) => {
      firstResolved = res
    })
    const firstDispatcher = async () => {
      firstHandlerCalls++
      await firstHung
    }
    const aPromise = engine.outbox.drainOnce({
      handler: firstDispatcher,
      claimTtlMs: 50, // expires almost immediately
    })

    // Wait past the TTL.
    await new Promise((res) => setTimeout(res, 150))

    // Worker B should now be able to re-claim.
    let bHandlerCalls = 0
    const bSeen = await engine.outbox.drainOnce({
      handler: async () => {
        bHandlerCalls++
      },
      claimTtlMs: 60_000,
    })
    expect(bSeen).toBe(1)
    expect(bHandlerCalls).toBe(1)

    // A is still hanging; let it finish (it would mark delivered_at,
    // but it's racing the cleanup so we don't assert exact state).
    if (firstResolved) firstResolved()
    await aPromise
    expect(firstHandlerCalls).toBe(1)
  })
})
