/**
 * Batch 17 — migrate --enforce (§14.2) integration coverage:
 *   - admin.schema.findViolations returns rows whose stored
 *     transitions violate a TS predicate.
 *   - Filters scope by tenant, transaction type, and transition name.
 *   - Limit caps the result set (for sampling on large tenants).
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

const TENANT = 'org-batch17'
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
  await engine.admin.tenants.create({ id: TENANT, name: 'B17' })
})

const seedPay = async (e: Engine, suffix: string, amount: bigint) => {
  const c = e.forTenant(TENANT)
  const user = { type: 'User', id: `u-${suffix}` }
  const driver = { type: 'Driver', id: `d-${suffix}` }
  const company = { type: 'Company', id: 'co-1' }
  await c.accounts.create({ actor: user, name: 'wallet' })
  await c.accounts.create({ actor: driver, name: 'balance' })
  await c.accounts.create({ actor: company, name: 'revenue' })
  await e.connection.sql.unsafe(
    `update "accounts" set balance = 10000 where owner_actor_type = 'User' and owner_actor_id = '${user.id}'`,
  )
  const txn = await c.transactions.create({
    type: 'DeliveryPayment',
    by: user,
    participants: { user, driver, company },
    idempotencyKey: `${suffix}:create`,
  })
  await c.transactions.transition({
    id: txn.record.id,
    name: 'pay',
    by: user,
    data: {
      amount,
      driverShare: amount / 3n,
      companyShare: amount - amount / 3n,
    },
    idempotencyKey: `${suffix}:pay`,
  })
  return txn.record.id
}

describe('admin.schema.findViolations', () => {
  it('returns records whose stored transition payload violates a new invariant', async () => {
    if (!engine) return
    // Seed three records: one below the new floor, two above.
    const small = await seedPay(engine, 'small', 50n)
    await seedPay(engine, 'big1', 5000n)
    await seedPay(engine, 'big2', 2000n)

    const hits = await engine.admin.schema.findViolations({
      tenantId: TENANT,
      txnType: 'DeliveryPayment',
      transitionName: 'pay',
      // Hypothetical "minimum 1000" invariant introduced after the fact.
      predicate: (t) => {
        const raw = (t.payload as { amount?: { $bigint?: string } }).amount
        if (!raw || typeof raw.$bigint !== 'string') return false
        return BigInt(raw.$bigint) < 1000n
      },
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.recordId).toBe(small)
  })

  it('honours the limit option', async () => {
    if (!engine) return
    await seedPay(engine, 'a', 10n)
    await seedPay(engine, 'b', 20n)
    await seedPay(engine, 'c', 30n)
    const hits = await engine.admin.schema.findViolations({
      tenantId: TENANT,
      txnType: 'DeliveryPayment',
      transitionName: 'pay',
      predicate: () => true,
      limit: 2,
    })
    expect(hits).toHaveLength(2)
  })

  it('skips transitions of other types and other names', async () => {
    if (!engine) return
    await seedPay(engine, 'only', 50n)
    // No `pay` transitions on the bogus type/name should match.
    const otherType = await engine.admin.schema.findViolations({
      tenantId: TENANT,
      txnType: 'Subscription',
      predicate: () => true,
    })
    expect(otherType).toHaveLength(0)

    const otherName = await engine.admin.schema.findViolations({
      tenantId: TENANT,
      txnType: 'DeliveryPayment',
      transitionName: 'cancel',
      predicate: () => true,
    })
    expect(otherName).toHaveLength(0)
  })
})
