/**
 * Batch 18 — schema-per-tenant + db-per-tenant (§7.2):
 *   - tenants.provision({ mode: 'schema' }) creates a Postgres schema
 *     and migrates the engine tables into it.
 *   - connectionFor + withSearchPath route per-tenant queries to that
 *     schema. Two schema-mode tenants on the same DB stay isolated.
 *   - tenants.provision({ mode: 'db', target }) migrates a target
 *     connection (db-per-tenant) — same DB url here, separate pool.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Connection,
  type Engine,
  MIGRATIONS_TABLE,
  RECONCILER_STATE_TABLE,
  createEngine,
  openConnection,
  withSearchPath,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

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
    // Drop bookkeeping + any tenant schemas left from prior runs.
    await engine.connection.sql.unsafe(`drop table if exists ${MIGRATIONS_TABLE}`)
    await engine.connection.sql.unsafe(`drop table if exists ${RECONCILER_STATE_TABLE}`)
    await engine.connection.sql.unsafe('drop schema if exists loki_t_org_a cascade')
    await engine.connection.sql.unsafe('drop schema if exists loki_t_org_b cascade')
    await engine.close()
  }
  // We need a connectionFor closure so the engine can route per-tenant.
  // Build it lazily so the tests can declare which tenants are in
  // schema mode after the engine is constructed.
  const schemaModeTenants = new Map<string, Connection>()
  engine = createEngine({
    schema: chidoriSchema,
    connection: { url: dbUrl },
    connectionFor: (id) => schemaModeTenants.get(id) ?? null,
  })
  // Stash the routing map on the engine for tests to populate.
  ;(engine as unknown as { __routes: Map<string, Connection> }).__routes = schemaModeTenants
  await engine.migrate()
})

describe('schema-per-tenant', () => {
  it('provisions a new Postgres schema and migrates engine tables into it', async () => {
    if (!engine || !dbUrl) return
    await engine.admin.tenants.create({ id: 'org-a', name: 'A', mode: 'schema' })
    const result = await engine.admin.tenants.provision({ id: 'org-a', mode: 'schema' })
    expect(result.schemaName).toBe('loki_t_org_a')
    expect(result.applied).toBe(1)

    // The schema exists and contains the engine tables.
    const tables = await engine.connection.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'loki_t_org_a'
        and table_name in ('tenants', 'accounts', 'txn_records', 'txn_transitions')
      order by table_name
    `
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      'accounts',
      'tenants',
      'txn_records',
      'txn_transitions',
    ])
  })

  it('isolates writes between two schema-mode tenants on the same DB', async () => {
    if (!engine || !dbUrl) return
    const routes = (engine as unknown as { __routes: Map<string, Connection> }).__routes

    // Provision A and B in schema mode and register their routes.
    await engine.admin.tenants.create({ id: 'org-a', name: 'A', mode: 'schema' })
    await engine.admin.tenants.create({ id: 'org-b', name: 'B', mode: 'schema' })
    await engine.admin.tenants.provision({ id: 'org-a', mode: 'schema' })
    await engine.admin.tenants.provision({ id: 'org-b', mode: 'schema' })
    routes.set('org-a', withSearchPath(engine.connection, 'loki_t_org_a'))
    routes.set('org-b', withSearchPath(engine.connection, 'loki_t_org_b'))

    // Each tenant has its own `tenants` row inside its own schema —
    // create those, since RLS isn't in play here.
    await engine.connection.sql.unsafe(
      `insert into "loki_t_org_a"."tenants" (id, name, mode, state) values ('org-a', 'A', 'schema', 'active')`,
    )
    await engine.connection.sql.unsafe(
      `insert into "loki_t_org_b"."tenants" (id, name, mode, state) values ('org-b', 'B', 'schema', 'active')`,
    )

    // Write a record into org-a; org-b's schema must not see it.
    const cA = engine.forTenant('org-a')
    const user = { type: 'User', id: 'u-a' }
    const driver = { type: 'Driver', id: 'd-a' }
    const company = { type: 'Company', id: 'co-a' }
    await cA.accounts.create({ actor: user, name: 'wallet' })
    await cA.accounts.create({ actor: driver, name: 'balance' })
    await cA.accounts.create({ actor: company, name: 'revenue' })
    await cA.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'a:create',
    })

    // Count records in each schema.
    const aRows = await engine.connection.sql<{ count: string }[]>`
      select count(*)::text as count from "loki_t_org_a"."txn_records"
    `
    const bRows = await engine.connection.sql<{ count: string }[]>`
      select count(*)::text as count from "loki_t_org_b"."txn_records"
    `
    expect(aRows[0]?.count).toBe('1')
    expect(bRows[0]?.count).toBe('0')
  })
})

describe('db-per-tenant', () => {
  it('provisions an arbitrary target connection by running the migration plan against it', async () => {
    if (!engine || !dbUrl) return
    // Same Postgres URL, separate pool — stands in for "another DB".
    // To not collide with the row-level tables on the default
    // connection we use a search_path wrap pointing at a fresh schema.
    const targetConn = openConnection({ url: dbUrl })
    try {
      await engine.connection.sql.unsafe('drop schema if exists tenant_db_org_c cascade')
      await engine.connection.sql.unsafe('create schema tenant_db_org_c')
      const target = withSearchPath(targetConn, 'tenant_db_org_c')

      await engine.admin.tenants.create({ id: 'org-c', name: 'C', mode: 'db' })
      const result = await engine.admin.tenants.provision({
        id: 'org-c',
        mode: 'db',
        target,
      })
      expect(result.applied).toBe(1)
      expect(result.schemaName).toBeUndefined()

      const tables = await engine.connection.sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'tenant_db_org_c'
          and table_name in ('txn_records', 'txn_transitions')
        order by table_name
      `
      expect(tables.map((t) => t.table_name)).toEqual(['txn_records', 'txn_transitions'])
    } finally {
      await targetConn.close()
      await engine.connection.sql.unsafe('drop schema if exists tenant_db_org_c cascade')
    }
  })

  it('row-mode tenants pass through the default connection', async () => {
    if (!engine) return
    await engine.admin.tenants.create({ id: 'org-row', name: 'R', mode: 'row' })
    // No connectionFor entry → falls back to the default RLS connection.
    const c = engine.forTenant('org-row')
    expect(c.tenantId).toBe('org-row')
    // Smoke: write+read round-trip on the default RLS schema.
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
      idempotencyKey: 'r:create',
    })
    const round = await c.transactions.get(txn.record.id)
    expect(round?.id).toBe(txn.record.id)
  })
})

describe('provision({ mode: "row" })', () => {
  it('is a no-op (RLS tables are shared)', async () => {
    if (!engine) return
    await engine.admin.tenants.create({ id: 'org-noop', name: 'N', mode: 'row' })
    const result = await engine.admin.tenants.provision({ id: 'org-noop', mode: 'row' })
    expect(result.applied).toBe(0)
    expect(result.schemaName).toBeUndefined()
  })
})
