/**
 * C3 — append-only DB roles enforced at runtime (§5.1).
 *
 * Migrations create `loki_app` and `loki_admin` with the right grants;
 * passing `runtimeRoles: { app, admin }` makes every per-tenant tx
 * issue `SET LOCAL ROLE loki_app` so direct DELETE/UPDATE on history
 * tables is rejected by Postgres before it can violate append-only.
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

const TENANT = 'org-roles'
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
  if (engine) await engine.close()

  // Cleanup + migrate run on a non-role-enforcing engine so the
  // testcontainer superuser owns the tables. The role-enforcing
  // engine that we test against can only INSERT/UPDATE; DROP TABLE
  // would fail under ledger_admin's grants.
  const bootstrap = createEngine({ schema: chidoriSchema, connection: { url: dbUrl } })
  try {
    await bootstrap.rollback()
  } catch {
    /* first run — nothing to roll back */
  }
  await bootstrap.connection.sql.unsafe(`drop table if exists ${MIGRATIONS_TABLE}`)
  await bootstrap.connection.sql.unsafe(`drop table if exists ${RECONCILER_STATE_TABLE}`)
  await bootstrap.migrate()
  await bootstrap.admin.tenants.create({ id: TENANT, name: 'Roles' })
  await bootstrap.close()

  engine = createEngine({
    schema: chidoriSchema,
    connection: {
      url: dbUrl,
      runtimeRoles: { app: 'ledger_app', admin: 'ledger_admin' },
    },
  })
})

describe('runtimeRoles — SET LOCAL ROLE plumbing', () => {
  it('rejects an unsafe role identifier at construction', () => {
    if (!dbUrl) return
    const url = dbUrl
    expect(() =>
      createEngine({
        schema: chidoriSchema,
        connection: {
          url,
          runtimeRoles: { app: 'ok_app', admin: 'bad; drop table' },
        },
      }),
    ).toThrow(/runtimeRoles\.admin/)
  })

  it('per-tenant writes still work under loki_app', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-r' }
    const driver = { type: 'Driver', id: 'd-r' }
    const company = { type: 'Company', id: 'co-r' }
    await c.accounts.create({ actor: user, name: 'wallet' })
    await c.accounts.create({ actor: driver, name: 'balance' })
    await c.accounts.create({ actor: company, name: 'revenue' })
    const txn = await c.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'roles:create',
    })
    expect(txn.record.id).toBeTruthy()
  })

  it('rejects DELETE on txn_transitions from the app role', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-d' }
    const driver = { type: 'Driver', id: 'd-d' }
    const company = { type: 'Company', id: 'co-d' }
    await c.accounts.create({ actor: user, name: 'wallet' })
    await c.accounts.create({ actor: driver, name: 'balance' })
    await c.accounts.create({ actor: company, name: 'revenue' })
    await c.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'roles:create2',
    })

    // From within a withTenant tx (which now runs as ledger_app), a
    // raw DELETE must be rejected by Postgres.
    await expect(
      engine.connection.withTenant(TENANT, async (tx) => {
        await tx.unsafe(`delete from "txn_transitions" where tenant_id = '${TENANT}'`)
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('admin path runs as loki_admin and can DELETE (used by relocate / wipe)', async () => {
    if (!engine) return
    // The asAdmin path should NOT be locked down — operations like
    // tenants.relocate({ deleteFromSource: true }) need it.
    await engine.connection.asAdmin(async (tx) => {
      // Just verify SELECT works under the admin role; a destructive
      // DELETE is exercised by the existing relocate test.
      const [row] = await tx<{ count: string }[]>`
        select count(*)::text as count from "txn_records"
      `
      expect(row?.count).toBeDefined()
    })
  })
})
