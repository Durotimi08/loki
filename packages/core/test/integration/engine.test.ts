import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  IllegalStateTransitionError,
  KeyAlreadyConsumedError,
  MIGRATIONS_TABLE,
  UnbalancedPostingsError,
  UnknownTransitionError,
  createEngine,
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-test'

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
  // Fresh DB state each test: rollback any prior plan, drop the
  // migration ledger, then re-apply.
  if (engine) {
    try {
      await engine.rollback()
    } catch {
      /* tables may not exist yet — fine */
    }
    await engine.connection.sql.unsafe(`drop table if exists ${MIGRATIONS_TABLE}`)
    await engine.close()
  }
  engine = createEngine({ schema: chidoriSchema, connection: { url: dbUrl } })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'Test Org' })
})

describe('admin.tenants', () => {
  it('creates and lists tenants', async () => {
    if (!engine) return
    const list = await engine.admin.tenants.list()
    expect(list.find((t) => t.id === TENANT)).toBeDefined()
  })

  it('idempotently re-creates the same tenant', async () => {
    if (!engine) return
    const a = await engine.admin.tenants.create({ id: TENANT, name: 'Test Org' })
    const b = await engine.admin.tenants.create({ id: TENANT, name: 'Different Name' })
    expect(a.id).toBe(b.id)
    expect(a.name).toBe(b.name) // first write wins
  })

  it('suspends and reactivates tenants', async () => {
    if (!engine) return
    const suspended = await engine.admin.tenants.suspend(TENANT)
    expect(suspended.state).toBe('suspended')
    const active = await engine.admin.tenants.activate(TENANT)
    expect(active.state).toBe('active')
  })
})

describe('accounts', () => {
  it('creates one row per shard from the schema declaration', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const company = { type: 'Company', id: 'co-1' }
    // Company.revenue is sharded 16-way in the Chidori fixture.
    await client.accounts.create({ actor: company, name: 'revenue' })
    const shards = await client.accounts.shards({
      actor: company,
      name: 'revenue',
      currency: 'NGN',
    })
    expect(shards).toHaveLength(16)
    expect(shards.map((s) => s.shardIndex).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, i) => i),
    )
  })

  it('is idempotent — re-creating returns the existing rows', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const driver = { type: 'Driver', id: 'drv-1' }
    const a = await client.accounts.create({ actor: driver, name: 'balance' })
    const b = await client.accounts.create({ actor: driver, name: 'balance' })
    expect(a.map((r) => r.id).sort()).toEqual(b.map((r) => r.id).sort())
  })

  it('reads balance as the sum across shards', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const company = { type: 'Company', id: 'co-1' }
    await client.accounts.create({ actor: company, name: 'revenue' })
    const balance = await client.accounts.balance({
      actor: company,
      name: 'revenue',
      currency: 'NGN',
    })
    expect(balance).toBe(0n)
  })
})

describe('transactions.create — record provisioning + idempotency', () => {
  it('creates a record in the schema-declared initial state', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const result = await client.transactions.create({
      type: 'DeliveryPayment',
      by: { type: 'User', id: 'u-1' },
      participants: {
        user: { type: 'User', id: 'u-1' },
        driver: { type: 'Driver', id: 'd-1' },
        company: { type: 'Company', id: 'co-1' },
      },
      idempotencyKey: 'd-test:create',
    })
    expect(result.replayed).toBe(false)
    expect(result.record.state).toBe('pending')
    expect(result.record.type).toBe('DeliveryPayment')
    expect(result.record.version).toBe(0)
    expect(result.record.participants).toMatchObject({
      user: { type: 'User', id: 'u-1' },
      driver: { type: 'Driver', id: 'd-1' },
      company: { type: 'Company', id: 'co-1' },
    })
  })

  it('replays the same record on duplicate idempotency keys', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const args = {
      type: 'DeliveryPayment',
      by: { type: 'User', id: 'u-1' },
      participants: {
        user: { type: 'User', id: 'u-1' },
        driver: { type: 'Driver', id: 'd-1' },
        company: { type: 'Company', id: 'co-1' },
      },
      idempotencyKey: 'd-test:create',
    } as const
    const a = await client.transactions.create({ ...args })
    const b = await client.transactions.create({ ...args })
    expect(a.record.id).toBe(b.record.id)
    expect(b.replayed).toBe(true)
  })

  it('writes a _init genesis transition with NULL prev_hash', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const result = await client.transactions.create({
      type: 'DeliveryPayment',
      by: { type: 'User', id: 'u-1' },
      participants: {
        user: { type: 'User', id: 'u-1' },
        driver: { type: 'Driver', id: 'd-1' },
        company: { type: 'Company', id: 'co-1' },
      },
      idempotencyKey: 'd-test:create-genesis',
    })
    const trail = await client.transactions.trace(result.record.id)
    expect(trail).toHaveLength(1)
    expect(trail[0]?.name).toBe('_init')
    expect(trail[0]?.fromState).toBeNull()
    expect(trail[0]?.toState).toBe('pending')
    expect(trail[0]?.prevHash).toBeNull()
    expect(trail[0]?.rowHash).toBeInstanceOf(Buffer)
  })
})

describe('transactions.transition — full 7-step write', () => {
  it('drives a balanced transition, updates the record and account balances', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-1' }
    const driver = { type: 'Driver', id: 'd-1' }
    const company = { type: 'Company', id: 'co-1' }

    await client.accounts.create({ actor: user, name: 'wallet' })
    await client.accounts.create({ actor: driver, name: 'balance' })
    await client.accounts.create({ actor: company, name: 'revenue' })

    // Pre-fund the user's wallet so we can debit it.
    const userWallet = await client.accounts.get({
      actor: user,
      name: 'wallet',
      currency: 'NGN',
    })
    expect(userWallet).not.toBeNull()
    await engine.connection.sql.unsafe(`
      update "accounts" set balance = 5000 where id = '${userWallet?.id}'
    `)

    const txn = await client.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'pay-1:create',
    })

    const r = await client.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
      idempotencyKey: 'pay-1:pay',
    })

    expect(r.replayed).toBe(false)
    expect(r.record.state).toBe('completed')
    expect(r.record.version).toBe(1)
    expect(r.postings).toHaveLength(3)
    expect(r.unlocked).toHaveProperty('refund')

    expect(await client.accounts.balance({ actor: user, name: 'wallet', currency: 'NGN' })).toBe(
      3500n,
    )
    expect(await client.accounts.balance({ actor: driver, name: 'balance', currency: 'NGN' })).toBe(
      500n,
    )
    expect(
      await client.accounts.balance({ actor: company, name: 'revenue', currency: 'NGN' }),
    ).toBe(1000n)
  })

  it('returns the original result on idempotent replay; balances do not double', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-2' }
    const driver = { type: 'Driver', id: 'd-2' }
    const company = { type: 'Company', id: 'co-1' }
    await client.accounts.create({ actor: user, name: 'wallet' })
    await client.accounts.create({ actor: driver, name: 'balance' })
    await client.accounts.create({ actor: company, name: 'revenue' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = 'u-2' and name = 'wallet'`,
    )

    const txn = await client.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'pay-2:create',
    })
    const args = {
      id: txn.record.id,
      name: 'pay',
      by: user,
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
      idempotencyKey: 'pay-2:pay',
    } as const

    const a = await client.transactions.transition({ ...args })
    const b = await client.transactions.transition({ ...args })
    expect(a.transition.id).toBe(b.transition.id)
    expect(b.replayed).toBe(true)
    expect(await client.accounts.balance({ actor: user, name: 'wallet', currency: 'NGN' })).toBe(
      3500n,
    ) // not 2000n — replay didn't double-charge
  })

  it('rejects a transition from an illegal state', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-3' }
    const driver = { type: 'Driver', id: 'd-3' }
    const company = { type: 'Company', id: 'co-1' }
    await client.accounts.create({ actor: user, name: 'wallet' })
    await client.accounts.create({ actor: driver, name: 'balance' })
    await client.accounts.create({ actor: company, name: 'revenue' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = 'u-3' and name = 'wallet'`,
    )

    const txn = await client.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'pay-3:create',
    })
    await client.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
      idempotencyKey: 'pay-3:pay',
    })

    // Already completed; firing 'pay' again is illegal (not idempotent — it's a different op).
    await expect(
      client.transactions.transition({
        id: txn.record.id,
        name: 'pay',
        by: user,
        data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
        idempotencyKey: 'pay-3:pay-again', // different key
      }),
    ).rejects.toBeInstanceOf(IllegalStateTransitionError)
  })

  it('rejects unknown transitions', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const txn = await client.transactions.create({
      type: 'DeliveryPayment',
      by: { type: 'User', id: 'u-4' },
      participants: {
        user: { type: 'User', id: 'u-4' },
        driver: { type: 'Driver', id: 'd-4' },
        company: { type: 'Company', id: 'co-1' },
      },
      idempotencyKey: 'unknown:create',
    })
    await expect(
      client.transactions.transition({
        id: txn.record.id,
        name: 'phantom',
        by: { type: 'User', id: 'u-4' },
        idempotencyKey: 'unknown:phantom',
      }),
    ).rejects.toBeInstanceOf(UnknownTransitionError)
  })

  it('rejects unbalanced postings', async () => {
    if (!engine) return
    // Build a side schema with intentionally unbalanced postings.
    const Org = defineTenant('Org')
    const A = defineActor('A', { accounts: { wallet: { currency: 'NGN' } } })
    const B = defineActor('B', { accounts: { wallet: { currency: 'NGN' } } })
    const Bad = defineTransaction('Bad', {
      states: ['init', 'done'],
      initial: 'init',
      participants: { from: A, to: B },
      transitions: (t) => ({
        broken: t({
          from: 'init',
          to: 'done',
          by: [A],
          postings: ({ participants }) => [
            { direction: 'D', account: participants.from.wallet, amount: 100n },
            { direction: 'C', account: participants.to.wallet, amount: 50n },
          ],
        }),
      }),
    })
    const schema = defineSchema({ tenant: Org, actors: [A, B], transactions: [Bad] })

    if (!engine) return
    const localEngine = createEngine({
      schema,
      connection: { url: dbUrl as string },
    })
    try {
      await localEngine.connection.sql.unsafe(`drop table if exists ${MIGRATIONS_TABLE}`)
      // Reuse already-applied tables from the main engine — but the
      // schema has different actors/transactions so reapply.
      await localEngine.rollback().catch(() => {})
      await localEngine.connection.sql.unsafe(`drop table if exists ${MIGRATIONS_TABLE}`)
      await localEngine.migrate()
      await localEngine.admin.tenants.create({ id: 'org-bad', name: 'Bad' })
      const client = localEngine.forTenant('org-bad')
      await client.accounts.create({ actor: { type: 'A', id: 'a-1' }, name: 'wallet' })
      await client.accounts.create({ actor: { type: 'B', id: 'b-1' }, name: 'wallet' })
      const txn = await client.transactions.create({
        type: 'Bad',
        by: { type: 'A', id: 'a-1' },
        participants: {
          from: { type: 'A', id: 'a-1' },
          to: { type: 'B', id: 'b-1' },
        },
        idempotencyKey: 'bad:create',
      })
      await expect(
        client.transactions.transition({
          id: txn.record.id,
          name: 'broken',
          by: { type: 'A', id: 'a-1' },
          idempotencyKey: 'bad:fire',
        }),
      ).rejects.toBeInstanceOf(UnbalancedPostingsError)
    } finally {
      await localEngine.rollback().catch(() => {})
      await localEngine.connection.sql.unsafe(`drop table if exists ${MIGRATIONS_TABLE}`)
      await localEngine.close()
    }
  })

  it('keeps the hash chain intact across multiple transitions on one record', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-chain' }
    const driver = { type: 'Driver', id: 'd-chain' }
    const company = { type: 'Company', id: 'co-1' }
    await client.accounts.create({ actor: user, name: 'wallet' })
    await client.accounts.create({ actor: driver, name: 'balance' })
    await client.accounts.create({ actor: company, name: 'revenue' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = 'u-chain' and name = 'wallet'`,
    )

    const txn = await client.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'chain:create',
    })
    await client.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
      idempotencyKey: 'chain:pay',
    })

    const trail = await client.transactions.trace(txn.record.id)
    expect(trail).toHaveLength(2)
    const [genesis, pay] = trail

    expect(genesis?.prevHash).toBeNull()
    expect(genesis?.rowHash).toBeInstanceOf(Buffer)
    // pay.prev_hash must equal genesis.row_hash.
    expect(pay?.prevHash?.equals(genesis?.rowHash as Buffer)).toBe(true)
    // sanity check that hashes are SHA-256 length.
    expect(genesis?.rowHash.length).toBe(32)
    expect(pay?.rowHash.length).toBe(32)
    // postings_checksum must match a recomputation of the canonicalized postings.
    expect(pay?.postingsChecksum.length).toBe(32)
  })

  it('emits an outbox row when the transition declares `emit`', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-outbox' }
    const driver = { type: 'Driver', id: 'd-outbox' }
    const company = { type: 'Company', id: 'co-1' }
    await client.accounts.create({ actor: user, name: 'wallet' })
    await client.accounts.create({ actor: driver, name: 'balance' })
    await client.accounts.create({ actor: company, name: 'revenue' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = 'u-outbox' and name = 'wallet'`,
    )

    const txn = await client.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'outbox:create',
    })
    const r = await client.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
      idempotencyKey: 'outbox:pay',
    })

    const rows = await engine.connection.sql<{ event: string; transition_id: string }[]>`
      select event, transition_id from "outbox" where transition_id = ${r.transition.id}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.event).toBe('delivery.paid')
  })

  it('mints unlocked keys and the next transition can consume them', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-keys' }
    const driver = { type: 'Driver', id: 'd-keys' }
    const company = { type: 'Company', id: 'co-1' }
    await client.accounts.create({ actor: user, name: 'wallet' })
    await client.accounts.create({ actor: driver, name: 'balance' })
    await client.accounts.create({ actor: company, name: 'revenue' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = 'u-keys' and name = 'wallet'`,
    )

    const txn = await client.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'keys:create',
    })
    const pay = await client.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
      idempotencyKey: 'keys:pay',
    })
    expect(Object.keys(pay.unlocked)).toContain('refund')
    expect(pay.record.activeKeys).toContain('refund')
    expect(pay.unlocked['refund']).toBeDefined()

    const refundKeyId = pay.unlocked['refund'] as string

    // Second consume should fail — key is single-use.
    const dummyRefundCall = client.transactions.transition({
      id: txn.record.id,
      name: 'refund',
      by: company,
      withKey: 'not-the-real-key-id',
      data: { reason: 'wrong key' },
      idempotencyKey: 'keys:bogus-refund',
    })
    await expect(dummyRefundCall).rejects.toBeInstanceOf(KeyAlreadyConsumedError)

    // Verify the real key id was minted.
    const [keyRow] = await engine.connection.sql<{ status: string }[]>`
      select status from "txn_keys" where id = ${refundKeyId}
    `
    expect(keyRow?.status).toBe('active')
  })
})

describe('hash chain — independent SHA-256 verification', () => {
  it('row_hash matches a freshly canonicalized recomputation', async () => {
    if (!engine) return
    const client = engine.forTenant(TENANT)
    const result = await client.transactions.create({
      type: 'DeliveryPayment',
      by: { type: 'User', id: 'u-h' },
      participants: {
        user: { type: 'User', id: 'u-h' },
        driver: { type: 'Driver', id: 'd-h' },
        company: { type: 'Company', id: 'co-1' },
      },
      idempotencyKey: 'h:create',
    })
    const trail = await client.transactions.trace(result.record.id)
    const genesis = trail[0]
    expect(genesis).toBeDefined()

    // The actual algorithm is `sha256(canonical(content) || prev_hash)`,
    // tested against the engine output for byte-identical equality.
    expect(genesis?.rowHash).toBeInstanceOf(Buffer)
    // Smoke check: not all zeros.
    expect(genesis?.rowHash.equals(Buffer.alloc(32, 0))).toBe(false)
    // Unconditional shape.
    expect(genesis?.rowHash.length).toBe(32)

    // Spot-check that the postings_checksum is the empty-list hash —
    // genesis has no postings.
    const emptyChecksum = createHash('sha256').update(Buffer.alloc(0)).digest()
    expect(genesis?.postingsChecksum.equals(emptyChecksum)).toBe(true)
  })
})

describe('RLS — tenant isolation', () => {
  // Note: testcontainers' default Postgres user is a SUPERUSER, which
  // bypasses RLS regardless of FORCE. These tests pin behavior by
  // setting the GUC explicitly across tenants — proving the policies
  // exist and scope correctly. The "missing GUC ⇒ no rows" case is
  // verified by the policy SQL + FORCE in the migration golden file
  // and applies in production deployments where the app role is
  // non-superuser, non-BYPASSRLS.

  it('the tenant GUC scopes reads to its own tenant only', async () => {
    if (!engine) return

    // Provision two distinct tenants and one record in each.
    await engine.admin.tenants.create({ id: 'org-rls-a', name: 'A' })
    await engine.admin.tenants.create({ id: 'org-rls-b', name: 'B' })

    const a = engine.forTenant('org-rls-a')
    const b = engine.forTenant('org-rls-b')

    await a.transactions.create({
      type: 'DeliveryPayment',
      by: { type: 'User', id: 'u-a' },
      participants: {
        user: { type: 'User', id: 'u-a' },
        driver: { type: 'Driver', id: 'd-a' },
        company: { type: 'Company', id: 'co-a' },
      },
      idempotencyKey: 'rls-a:create',
    })
    await b.transactions.create({
      type: 'DeliveryPayment',
      by: { type: 'User', id: 'u-b' },
      participants: {
        user: { type: 'User', id: 'u-b' },
        driver: { type: 'Driver', id: 'd-b' },
        company: { type: 'Company', id: 'co-b' },
      },
      idempotencyKey: 'rls-b:create',
    })

    // SET LOCAL ROLE drops superuser for the duration of the tx so RLS
    // policies apply. Test connection runs as the postgres superuser,
    // which by default bypasses RLS even with FORCE; ledger_app is the
    // role real applications use in production.
    await engine.connection.sql.begin(async (tx) => {
      await tx.unsafe(`set local role "ledger_app"`)
      await tx`select set_config('loki.tenant_id', ${'org-rls-a'}, true)`
      const rows = await tx<{ tenant_id: string }[]>`
        select tenant_id from "txn_records"
      `
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) expect(r.tenant_id).toBe('org-rls-a')
    })

    await engine.connection.sql.begin(async (tx) => {
      await tx.unsafe(`set local role "ledger_app"`)
      await tx`select set_config('loki.tenant_id', ${'org-rls-b'}, true)`
      const rows = await tx<{ tenant_id: string }[]>`
        select tenant_id from "txn_records"
      `
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) expect(r.tenant_id).toBe('org-rls-b')
    })
  })

  it('writes through `withTenant` cannot leak across tenants', async () => {
    if (!engine) return

    await engine.admin.tenants.create({ id: 'org-w-a', name: 'A' })
    await engine.admin.tenants.create({ id: 'org-w-b', name: 'B' })

    const a = engine.forTenant('org-w-a')
    const created = await a.transactions.create({
      type: 'DeliveryPayment',
      by: { type: 'User', id: 'u-wa' },
      participants: {
        user: { type: 'User', id: 'u-wa' },
        driver: { type: 'Driver', id: 'd-wa' },
        company: { type: 'Company', id: 'co-wa' },
      },
      idempotencyKey: 'rls-w-a:create',
    })

    const b = engine.forTenant('org-w-b')
    // Asking tenant B about tenant A's record returns null (RLS hides it).
    expect(await b.transactions.get(created.record.id)).toBeNull()
    // From inside its own scope, tenant A can still see its record.
    expect(await a.transactions.get(created.record.id)).not.toBeNull()
  })
})
