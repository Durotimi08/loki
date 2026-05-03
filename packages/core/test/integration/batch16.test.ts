/**
 * Batch 16 — materialized projections (§12.9) integration:
 *   - defineProjection registers a synchronously-maintained table
 *   - Migrations create proj_<name> with the declared columns + scope index
 *   - Every transition writes a projection row in the same DB tx (no lag)
 *   - The `when.actorType` filter skips transitions driven by other actors
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  MIGRATIONS_TABLE,
  RECONCILER_STATE_TABLE,
  createEngine,
  defineActor,
  defineProjection,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '../../src/index.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-batch16'
let engine: Engine | null = null
let dbUrl: string | null = null

const Org = defineTenant('Org')
const User = defineActor('User', { accounts: { wallet: { currency: 'NGN' } } })
const Driver = defineActor('Driver', { accounts: { balance: { currency: 'NGN' } } })

const RideTxn = defineTransaction('Ride', {
  states: ['pending', 'completed'],
  initial: 'pending',
  terminal: ['completed'],
  participants: { user: User, driver: Driver },
  transitions: (t) => ({
    finish: t({ from: 'pending', to: 'completed', by: [User, Driver] }),
  }),
})

const driverActivity = defineProjection('driver_activity', {
  source: 'txn_transitions',
  when: { actorType: 'Driver' },
  columns: ['txn_id', 'type', 'name', 'actor_id', 'occurred_at'],
})

const schema = defineSchema({
  tenant: Org,
  actors: [User, Driver],
  transactions: [RideTxn],
  projections: [driverActivity],
})

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
  engine = createEngine({ schema, connection: { url: dbUrl } })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'B16' })
})

describe('projections — DDL', () => {
  it('creates a proj_<name> table and a scope index', async () => {
    if (!engine) return
    const tableRows = await engine.connection.sql<{ relname: string }[]>`
      select relname from pg_class where relname = 'proj_driver_activity'
    `
    expect(tableRows).toHaveLength(1)

    const indexRows = await engine.connection.sql<{ relname: string }[]>`
      select relname from pg_class where relname = 'proj_driver_activity_scope_idx'
    `
    expect(indexRows).toHaveLength(1)

    const cols = await engine.connection.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'proj_driver_activity'
      order by ordinal_position
    `
    const names = cols.map((c) => c.column_name)
    // id + tenant_id are always added; the rest are user-declared.
    expect(names).toEqual(['id', 'tenant_id', 'txn_id', 'type', 'name', 'actor_id', 'occurred_at'])
  })
})

describe('projections — synchronous maintenance', () => {
  it('writes a projection row inside the same tx as the source transition', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    const driver = { type: 'Driver', id: 'drv-1' }
    const user = { type: 'User', id: 'usr-1' }
    const txn = await c.transactions.create({
      type: 'Ride',
      by: driver,
      participants: { user, driver },
      idempotencyKey: 'ride:1:create',
    })

    // Genesis transition has actor=Driver — should land in projection.
    const init = await engine.connection.sql<{ id: string; actor_id: string }[]>`
      select id, actor_id from "proj_driver_activity"
      where txn_id = ${txn.record.id}
    `
    expect(init).toHaveLength(1)
    expect(init[0]?.actor_id).toBe('drv-1')

    // Finish driven by Driver — should also land.
    await c.transactions.transition({
      id: txn.record.id,
      name: 'finish',
      by: driver,
      idempotencyKey: 'ride:1:finish',
    })
    const after = await engine.connection.sql<{ name: string }[]>`
      select name from "proj_driver_activity"
      where txn_id = ${txn.record.id}
      order by occurred_at, id
    `
    expect(after.map((r) => r.name)).toEqual(['_init', 'finish'])
  })

  it('skips transitions driven by an actor outside the when.actorType filter', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    const driver = { type: 'Driver', id: 'drv-2' }
    const user = { type: 'User', id: 'usr-2' }
    const txn = await c.transactions.create({
      type: 'Ride',
      by: user, // not a Driver — projection should ignore this
      participants: { user, driver },
      idempotencyKey: 'ride:2:create',
    })
    const rows = await engine.connection.sql<{ id: string }[]>`
      select id from "proj_driver_activity" where txn_id = ${txn.record.id}
    `
    expect(rows).toHaveLength(0)

    // A Driver-driven transition still lands.
    await c.transactions.transition({
      id: txn.record.id,
      name: 'finish',
      by: driver,
      idempotencyKey: 'ride:2:finish',
    })
    const afterRows = await engine.connection.sql<{ name: string }[]>`
      select name from "proj_driver_activity" where txn_id = ${txn.record.id}
    `
    expect(afterRows.map((r) => r.name)).toEqual(['finish'])
  })
})
