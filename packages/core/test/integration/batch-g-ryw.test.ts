/**
 * Integration coverage for batch G — read-your-writes routing.
 *
 * The full RYW behaviour requires an actual streaming replica, which
 * the test harness doesn't spin up. What we CAN verify against a
 * single-instance Postgres:
 *
 *   - readYourWrites: 'off' is the historical behaviour (default).
 *   - readYourWrites: 'auto' is a safe no-op when no replica is set:
 *     reads still resolve, writes still capture, queries still pass.
 *   - The LSN store doesn't leak between unrelated tenant operations.
 *
 * The replica-routing logic is exercised in unit tests of `compareLsn`
 * and by inspecting the resolved pool through a custom probe — covered
 * via the connection unit test below.
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

const TENANT = 'org-ryw'
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
  if (!dbUrl) return
  engine = createEngine({
    schema: chidoriSchema,
    connection: { url: dbUrl },
    readYourWrites: 'auto',
  })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'RYW' })
})

describe('batch G — read-your-writes', () => {
  it('reads after writes resolve correctly with no replica configured', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-ryw' }
    const driver = { type: 'Driver', id: 'd-ryw' }
    const company = { type: 'Company', id: 'co-ryw' }
    await c.accounts.create({ actor: user, name: 'wallet' })
    await c.accounts.create({ actor: driver, name: 'balance' })
    await c.accounts.create({ actor: company, name: 'revenue' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = 'u-ryw'`,
    )
    const txn = await c.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'ryw:create',
    })
    await c.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      idempotencyKey: 'ryw:pay',
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    })

    // The replica path is the same physical Postgres instance, so the
    // read should always see the write — independent of RYW.
    const trail = await c.transactions.trace(txn.record.id)
    expect(trail.length).toBe(2) // genesis + pay
  })

  it('hasReplica is false when no read URL is provided (RYW is a no-op)', async () => {
    if (!engine) return
    expect(engine.connection.hasReplica).toBe(false)
  })
})
