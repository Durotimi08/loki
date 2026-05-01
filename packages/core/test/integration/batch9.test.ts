/**
 * Batch 9 — schema evolution (M11) integration coverage:
 *   - schema_version stamped from `schema.version` (not hardcoded 1)
 *   - admin.schema.versions reports per-version row counts
 *   - diffSchemas classifies additive / rename / restrictive / destructive
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  MIGRATIONS_TABLE,
  createEngine,
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
  diffSchemas,
} from '../../src/index.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-batch9'
let engine: Engine | null = null
let dbUrl: string | null = null

const Org = defineTenant('Org')
const User = defineActor('User', { accounts: { wallet: { currency: 'NGN' } } })
const Driver = defineActor('Driver', { accounts: { balance: { currency: 'NGN' } } })

const TxnV2 = defineTransaction('Txn', {
  states: ['pending', 'completed'],
  initial: 'pending',
  terminal: ['completed'],
  participants: { user: User, driver: Driver },
  transitions: (t) => ({
    finish: t({ from: 'pending', to: 'completed', by: [User] }),
  }),
})

const schemaV2 = defineSchema({
  tenant: Org,
  actors: [User, Driver],
  transactions: [TxnV2],
  version: 2,
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
    await engine.close()
  }
  engine = createEngine({ schema: schemaV2, connection: { url: dbUrl } })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'B9' })
})

describe('schema_version stamping', () => {
  it('writes schema.version onto records and transitions', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    const txn = await c.transactions.create({
      type: 'Txn',
      by: { type: 'User', id: 'u-1' },
      participants: { user: { type: 'User', id: 'u-1' }, driver: { type: 'Driver', id: 'd-1' } },
      idempotencyKey: 'v2:create',
    })
    await c.transactions.transition({
      id: txn.record.id,
      name: 'finish',
      by: { type: 'User', id: 'u-1' },
      idempotencyKey: 'v2:finish',
    })

    const [recordRow] = await engine.connection.sql<{ schema_version: number }[]>`
      select schema_version from "txn_records" where id = ${txn.record.id}
    `
    expect(recordRow?.schema_version).toBe(2)

    const versions = await engine.connection.sql<{ schema_version: number }[]>`
      select schema_version from "txn_transitions" where txn_id = ${txn.record.id}
    `
    for (const v of versions) expect(v.schema_version).toBe(2)
  })
})

describe('admin.schema.versions', () => {
  it('counts records and transitions per stored version', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    await c.transactions.create({
      type: 'Txn',
      by: { type: 'User', id: 'u-v' },
      participants: { user: { type: 'User', id: 'u-v' }, driver: { type: 'Driver', id: 'd-v' } },
      idempotencyKey: 'versions:create',
    })
    const counts = await engine.admin.schema.versions(TENANT)
    expect(counts).toHaveLength(1)
    expect(counts[0]?.version).toBe(2)
    expect(counts[0]?.records).toBe(1)
    expect(counts[0]?.transitions).toBe(1) // _init
  })
})

describe('diffSchemas', () => {
  it('classifies additive changes', () => {
    const Order = defineTransaction('Order', {
      states: ['placed'],
      initial: 'placed',
      participants: { user: User },
      transitions: () => ({}),
    })
    const v3 = defineSchema({
      tenant: Org,
      actors: [User, Driver],
      transactions: [TxnV2, Order],
      version: 3,
    })
    const diff = diffSchemas(schemaV2, v3)
    expect(diff.counts.additive).toBeGreaterThan(0)
    expect(diff.counts.destructive).toBe(0)
    expect(
      diff.changes.some((c) => c.kind === 'additive' && /transaction "Order"/.test(c.description)),
    ).toBe(true)
  })

  it('classifies a removed actor as destructive', () => {
    const v3 = defineSchema({
      tenant: Org,
      actors: [User], // Driver removed
      transactions: [
        defineTransaction('Txn', {
          states: ['pending', 'completed'],
          initial: 'pending',
          terminal: ['completed'],
          participants: { user: User },
          transitions: (t) => ({
            finish: t({ from: 'pending', to: 'completed', by: [User] }),
          }),
        }),
      ],
      version: 3,
    })
    const diff = diffSchemas(schemaV2, v3)
    expect(diff.counts.destructive).toBeGreaterThan(0)
    expect(diff.changes.some((c) => c.kind === 'destructive' && /Driver/.test(c.description))).toBe(
      true,
    )
  })

  it('detects renames via the alias map', () => {
    const Renamed = defineActor('User2', { accounts: { wallet: { currency: 'NGN' } } })
    const v3 = defineSchema({
      tenant: Org,
      actors: [Renamed, Driver],
      transactions: [
        defineTransaction('Txn', {
          states: ['pending', 'completed'],
          initial: 'pending',
          terminal: ['completed'],
          participants: { user: Renamed, driver: Driver },
          transitions: (t) => ({
            finish: t({ from: 'pending', to: 'completed', by: [Renamed] }),
          }),
        }),
      ],
      version: 3,
      aliases: { 2: { actors: { User: 'User2' } } },
    })
    const diff = diffSchemas(schemaV2, v3)
    expect(diff.counts.rename).toBeGreaterThan(0)
    expect(diff.counts.destructive).toBe(0)
    expect(
      diff.changes.some(
        (c) =>
          c.kind === 'rename' && c.subject === 'actor' && c.from === 'User' && c.to === 'User2',
      ),
    ).toBe(true)
  })

  it('classifies a tightened actor union as restrictive', () => {
    const v3 = defineSchema({
      tenant: Org,
      actors: [User, Driver],
      transactions: [
        defineTransaction('Txn', {
          states: ['pending', 'completed'],
          initial: 'pending',
          terminal: ['completed'],
          participants: { user: User, driver: Driver },
          transitions: (t) => ({
            finish: t({ from: 'pending', to: 'completed', by: [Driver] }), // was [User]
          }),
        }),
      ],
      version: 3,
    })
    const diff = diffSchemas(schemaV2, v3)
    expect(diff.counts.restrictive).toBeGreaterThan(0)
  })
})
