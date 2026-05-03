/**
 * C1 — idempotency-under-races (§6.2). Two concurrent processes hit
 * the same `(tenant_id, idempotency_key)`; one INSERT wins the unique
 * index, the other catches the 23505 and replays the winner. The
 * caller sees the same result either way — no raw Postgres error.
 *
 * Sequential idempotency was already covered; this file is the
 * concurrent path that previously bubbled 23505 to the caller.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  MIGRATIONS_TABLE,
  RECONCILER_STATE_TABLE,
  createEngine,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-race'
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
    await engine.connection.sql.unsafe(`drop table if exists ${RECONCILER_STATE_TABLE}`)
    await engine.close()
  }
  engine = createEngine({ schema: chidoriSchema, connection: { url: dbUrl } })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'Race' })
})

describe('idempotency under concurrent writers', () => {
  it('two concurrent create() calls with the same idempotency key both succeed; both see the same record id', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-race' }
    const driver = { type: 'Driver', id: 'd-race' }
    const company = { type: 'Company', id: 'co-race' }

    const args = {
      type: 'DeliveryPayment' as const,
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'race-1',
    }

    // Fire concurrently. Vitest runs tests serially but Promise.all
    // dispatches both transitions on the same event loop tick — Postgres
    // sees them as concurrent because each runs in its own tx via
    // postgres.js's pool.
    const [a, b] = await Promise.all([c.transactions.create(args), c.transactions.create(args)])
    expect(a.record.id).toBe(b.record.id)
    // Exactly one is the original write; the other is a replay.
    expect([a.replayed, b.replayed].sort()).toEqual([false, true])
  })

  it('two concurrent transition() calls on the same record + key converge to one transition', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-race2' }
    const driver = { type: 'Driver', id: 'd-race2' }
    const company = { type: 'Company', id: 'co-race2' }
    await c.accounts.create({ actor: user, name: 'wallet' })
    await c.accounts.create({ actor: driver, name: 'balance' })
    await c.accounts.create({ actor: company, name: 'revenue' })
    if (!engine) return
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = 'u-race2'`,
    )
    const txn = await c.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'race2:create',
    })

    const args = {
      id: txn.record.id,
      name: 'pay',
      by: user,
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
      idempotencyKey: 'race2:pay',
    }
    const [a, b] = await Promise.all([
      c.transactions.transition(args),
      c.transactions.transition(args),
    ])
    expect(a.transition.id).toBe(b.transition.id)
    expect([a.replayed, b.replayed].sort()).toEqual([false, true])

    // Postings only landed once — the loser's path replayed without
    // doubling debits/credits.
    const [posting] = await engine.connection.sql<{ count: string }[]>`
      select count(*)::text as count from "postings"
      where transition_id = ${a.transition.id}
    `
    expect(Number(posting?.count ?? 0)).toBe(3)

    // Balance reflects exactly one debit, not two.
    const userBalance = await c.accounts.balance({
      actor: user,
      name: 'wallet',
      currency: 'NGN',
    })
    expect(userBalance).toBe(3500n) // 5000 - 1500
  })

  it('rejects re-use of an idempotency key on a different record', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-race3' }
    const driver = { type: 'Driver', id: 'd-race3' }
    const company = { type: 'Company', id: 'co-race3' }
    await c.accounts.create({ actor: user, name: 'wallet' })
    await c.accounts.create({ actor: driver, name: 'balance' })
    await c.accounts.create({ actor: company, name: 'revenue' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 10000 where owner_actor_type = 'User' and owner_actor_id = 'u-race3'`,
    )
    const txnA = await c.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'race3:txnA-create',
    })
    const txnB = await c.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'race3:txnB-create',
    })

    await c.transactions.transition({
      id: txnA.record.id,
      name: 'pay',
      by: user,
      data: { amount: 100n, driverShare: 30n, companyShare: 70n },
      idempotencyKey: 'race3:shared-key',
    })
    await expect(
      c.transactions.transition({
        id: txnB.record.id,
        name: 'pay',
        by: user,
        data: { amount: 100n, driverShare: 30n, companyShare: 70n },
        idempotencyKey: 'race3:shared-key', // same key, different record
      }),
    ).rejects.toThrow(/already used on a different record/)
  })
})
