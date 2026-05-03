/**
 * Integration coverage for batch C (M10) — auto-emit reversal, honest scope.
 *
 *   - state_mismatch + repairStateMismatch: bumps cached `state` to
 *     latest transition's `to_state`, leaves quarantine alone.
 *   - fabricated_key + repairFabricatedKeys: flips orphan key
 *     active → expired, and skips quarantine for that anomaly.
 *   - Integrity-class anomalies (hash_chain_break, checksum_mismatch,
 *     unbalanced_postings) still quarantine — no auto-repair.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  MIGRATIONS_TABLE,
  RECONCILER_STATE_TABLE,
  createEngine,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-batch-c'
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
  await engine.admin.tenants.create({ id: TENANT, name: 'BatchC' })
})

const drivePayment = async (e: Engine, suffix: string): Promise<{ recordId: string }> => {
  const c = e.forTenant(TENANT)
  const user = { type: 'User', id: `u-${suffix}` }
  const driver = { type: 'Driver', id: `d-${suffix}` }
  const company = { type: 'Company', id: 'co-1' }
  await c.accounts.create({ actor: user, name: 'wallet' })
  await c.accounts.create({ actor: driver, name: 'balance' })
  await c.accounts.create({ actor: company, name: 'revenue' })
  await e.connection.sql.unsafe(
    `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = '${user.id}' and name = 'wallet'`,
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
    idempotencyKey: `${suffix}:pay`,
    data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
  })
  return { recordId: txn.record.id }
}

describe('batch C — repairStateMismatch', () => {
  it('detects state_mismatch and bumps cached state when option is set', async () => {
    if (!engine) return
    const { recordId } = await drivePayment(engine, 'sm-repair')
    // Tamper: rewind cached `state` to a stale value.
    await engine.connection.sql.unsafe(
      `update "txn_records" set state = 'pending' where id = '${recordId}'`,
    )

    const result = await engine.reconciler.runOnce({
      tenantId: TENANT,
      repairStateMismatch: true,
    })
    expect(result.anomalies.some((a) => a.check === 'state_mismatch')).toBe(true)
    expect(result.stateRepaired).toContain(recordId)

    const [row] = await engine.connection.sql<{ state: string }[]>`
      select state from txn_records where id = ${recordId}
    `
    expect(row?.state).toBe('completed')
  })

  it('detects state_mismatch but leaves the row alone when option is not set', async () => {
    if (!engine) return
    const { recordId } = await drivePayment(engine, 'sm-noop')
    await engine.connection.sql.unsafe(
      `update "txn_records" set state = 'pending' where id = '${recordId}'`,
    )
    const result = await engine.reconciler.runOnce({ tenantId: TENANT })
    expect(result.anomalies.some((a) => a.check === 'state_mismatch')).toBe(true)
    expect(result.stateRepaired).toEqual([])
    const [row] = await engine.connection.sql<{ state: string }[]>`
      select state from txn_records where id = ${recordId}
    `
    expect(row?.state).toBe('pending')
  })
})

describe('batch C — repairFabricatedKeys', () => {
  it('flips orphan key active → expired when option is set, skips quarantine', async () => {
    if (!engine) return
    const { recordId } = await drivePayment(engine, 'fk-repair')
    // Inject a fabricated key — granted_by_transition_id references a
    // ULID that doesn't exist in `txn_transitions`.
    // Production threat model: an admin role bypasses FK constraints
    // (e.g. ALTER TABLE ... DISABLE TRIGGER ALL) and writes a bogus row.
    // Simulate via ALTER + INSERT + ALTER.
    const fakeKeyId = randomUUID()
    const ghostTransitionId = '01HFAKEFAKEFAKEFAKEFAKEFAK'
    await engine.connection.sql.unsafe(`
      alter table "txn_keys" disable trigger all;
      insert into "txn_keys" (id, tenant_id, txn_id, name, granted_by_transition_id, status)
      values ('${fakeKeyId}', '${TENANT}', '${recordId}', 'refund', '${ghostTransitionId}', 'active');
      alter table "txn_keys" enable trigger all;
    `)

    const result = await engine.reconciler.runOnce({
      tenantId: TENANT,
      repairFabricatedKeys: true,
    })
    expect(result.anomalies.some((a) => a.check === 'fabricated_key')).toBe(true)
    expect(result.fabricatedKeysExpired).toContain(fakeKeyId)
    expect(result.quarantined).not.toContain(recordId)

    const [keyRow] = await engine.connection.sql<{ status: string }[]>`
      select status from txn_keys where id = ${fakeKeyId}
    `
    expect(keyRow?.status).toBe('expired')
    const [recordRow] = await engine.connection.sql<{ compromised: boolean }[]>`
      select compromised from txn_records where id = ${recordId}
    `
    expect(recordRow?.compromised).toBe(false)
  })

  it('without the option, fabricated_key still quarantines and key stays active', async () => {
    if (!engine) return
    const { recordId } = await drivePayment(engine, 'fk-noop')
    // Production threat model: an admin role bypasses FK constraints
    // (e.g. ALTER TABLE ... DISABLE TRIGGER ALL) and writes a bogus row.
    // Simulate via ALTER + INSERT + ALTER.
    const fakeKeyId = randomUUID()
    const ghostTransitionId = '01HFAKEFAKEFAKEFAKEFAKEFAK'
    await engine.connection.sql.unsafe(`
      alter table "txn_keys" disable trigger all;
      insert into "txn_keys" (id, tenant_id, txn_id, name, granted_by_transition_id, status)
      values ('${fakeKeyId}', '${TENANT}', '${recordId}', 'refund', '${ghostTransitionId}', 'active');
      alter table "txn_keys" enable trigger all;
    `)
    const result = await engine.reconciler.runOnce({ tenantId: TENANT })
    expect(result.anomalies.some((a) => a.check === 'fabricated_key')).toBe(true)
    expect(result.fabricatedKeysExpired).toEqual([])
    expect(result.quarantined).toContain(recordId)
    const [keyRow] = await engine.connection.sql<{ status: string }[]>`
      select status from txn_keys where id = ${fakeKeyId}
    `
    expect(keyRow?.status).toBe('active')
  })
})

describe('batch C — integrity violations remain quarantined', () => {
  it('hash_chain_break still quarantines even with both repair flags on', async () => {
    if (!engine) return
    const { recordId } = await drivePayment(engine, 'integrity')
    // Tamper: rewrite to_state on the latest transition. Hash recompute
    // catches it, but we cannot self-heal because we don't have the
    // original to_state to put back.
    await engine.connection.sql.unsafe(
      `update "txn_transitions" set to_state = 'failed' where name = 'pay'`,
    )

    const result = await engine.reconciler.runOnce({
      tenantId: TENANT,
      repairStateMismatch: true,
      repairFabricatedKeys: true,
    })
    expect(result.anomalies.some((a) => a.check === 'hash_chain_break')).toBe(true)
    expect(result.quarantined).toContain(recordId)
  })
})
