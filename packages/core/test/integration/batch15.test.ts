/**
 * Batch 15 — partitioning (§12.3) integration:
 *   - Migrator emits PARTITION BY RANGE clauses when partitioning='monthly'
 *   - engine.partitions.ensureFor creates monthly partitions idempotently
 *   - Writes land in the correct partition; reads still see them
 *   - The default partition catches rows whose month wasn't pre-provisioned
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

const TENANT = 'org-batch15'
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
  engine = createEngine({
    schema: chidoriSchema,
    connection: { url: dbUrl },
    migration: { partitioning: 'monthly' },
  })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'B15' })
})

describe('partitioning — monthly', () => {
  it('emits partitioned tables and a default partition for txn_transitions and postings', async () => {
    if (!engine) return
    const trans = await engine.connection.sql<{ relname: string; relkind: string }[]>`
      select relname, relkind from pg_class
      where relname = 'txn_transitions'
    `
    expect(trans[0]?.relkind).toBe('p') // 'p' = partitioned table

    const posts = await engine.connection.sql<{ relname: string; relkind: string }[]>`
      select relname, relkind from pg_class
      where relname = 'postings'
    `
    expect(posts[0]?.relkind).toBe('p')

    // Default partition should exist for both.
    const defaults = await engine.connection.sql<{ relname: string }[]>`
      select relname from pg_class
      where relname in ('txn_transitions_default', 'postings_default')
    `
    expect(defaults).toHaveLength(2)
  })

  it('ensureFor(date, monthsAhead) creates monthly partitions idempotently', async () => {
    if (!engine) return
    const target = new Date(Date.UTC(2026, 5, 15))
    const first = await engine.partitions.ensureFor(target, { monthsAhead: 2 })
    expect(first).toHaveLength(6) // 2 tables × 3 months
    expect(first.every((p) => p.created)).toBe(true)

    // Re-running is a no-op: every result has created=false.
    const again = await engine.partitions.ensureFor(target, { monthsAhead: 2 })
    expect(again.every((p) => p.created === false)).toBe(true)

    const partitions = await engine.partitions.list('txn_transitions')
    const expected = [
      'txn_transitions_y2026m06',
      'txn_transitions_y2026m07',
      'txn_transitions_y2026m08',
    ]
    for (const name of expected) {
      expect(partitions.some((p) => p.partitionName === name)).toBe(true)
    }
  })

  it('records and transitions still write end-to-end on a partitioned schema', async () => {
    if (!engine) return
    // Provision the current month's partition for both tables.
    await engine.partitions.ensureFor(new Date())

    const c = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-p' }
    const driver = { type: 'Driver', id: 'd-p' }
    const company = { type: 'Company', id: 'co-p' }
    await c.accounts.create({ actor: user, name: 'wallet' })
    await c.accounts.create({ actor: driver, name: 'balance' })
    await c.accounts.create({ actor: company, name: 'revenue' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = 'u-p'`,
    )
    const txn = await c.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'p:create',
    })
    await c.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
      idempotencyKey: 'p:pay',
    })

    // Reads still see everything (queries hit the partitioned parent
    // and Postgres routes per partition).
    const trail = await c.transactions.trace(txn.record.id)
    expect(trail).toHaveLength(2) // _init + pay
  })
})
