/**
 * Batch 19 — per-check watermarks for balance_drift, state_mismatch,
 * and fabricated_key. Previously only the three transition-scoped
 * checks were O(Δ); now all six are.
 *
 * The test pattern: tamper a row that sits BELOW the relevant
 * watermark. A watermarked sweep should skip it; a fullSweep must
 * still catch it.
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

const TENANT = 'org-batch19'
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
  await engine.admin.tenants.create({ id: TENANT, name: 'B19' })
})

const drivePay = async (e: Engine, suffix: string) => {
  const c = e.forTenant(TENANT)
  const user = { type: 'User', id: `u-${suffix}` }
  const driver = { type: 'Driver', id: `d-${suffix}` }
  const company = { type: 'Company', id: 'co-1' }
  await c.accounts.create({ actor: user, name: 'wallet' })
  await c.accounts.create({ actor: driver, name: 'balance' })
  await c.accounts.create({ actor: company, name: 'revenue' })
  await e.connection.sql.unsafe(
    `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = '${user.id}'`,
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
    data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    idempotencyKey: `${suffix}:pay`,
  })
  return { recordId: txn.record.id, user }
}

describe('balance_drift watermark', () => {
  it('skips below-watermark accounts on incremental passes', async () => {
    if (!engine) return
    await drivePay(engine, 'd1')
    // Seed the drift watermark.
    await engine.reconciler.runOnce({ tenantId: TENANT })
    // Tamper a balance AFTER the watermark covered it. Per-check
    // watermark says "no new postings since" → drift skips.
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 999 where owner_actor_type = 'User' and owner_actor_id = 'u-d1'`,
    )
    const r = await engine.reconciler.runOnce({ tenantId: TENANT, quarantine: false })
    expect(r.anomalies.filter((a) => a.check === 'balance_drift')).toHaveLength(0)
    // Full sweep must still catch it.
    const full = await engine.reconciler.runOnce({
      tenantId: TENANT,
      quarantine: false,
      fullSweep: true,
    })
    expect(full.anomalies.some((a) => a.check === 'balance_drift')).toBe(true)
  })

  it('catches drift on accounts touched by NEW postings since the watermark', async () => {
    if (!engine) return
    await drivePay(engine, 'd2')
    await engine.reconciler.runOnce({ tenantId: TENANT })
    // Drive a second payment that posts to the user's wallet again.
    await drivePay(engine, 'd2b')
    // Tamper the new user's balance.
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 0 where owner_actor_type = 'User' and owner_actor_id = 'u-d2b'`,
    )
    const r = await engine.reconciler.runOnce({ tenantId: TENANT, quarantine: false })
    expect(r.anomalies.some((a) => a.check === 'balance_drift')).toBe(true)
  })
})

describe('state_mismatch watermark', () => {
  it('skips records whose latest transition is below the watermark', async () => {
    if (!engine) return
    const { recordId } = await drivePay(engine, 's1')
    await engine.reconciler.runOnce({ tenantId: TENANT })
    // Tamper the cached state directly.
    await engine.connection.sql.unsafe(
      `update "txn_records" set state = 'pending' where id = '${recordId}'`,
    )
    const r = await engine.reconciler.runOnce({ tenantId: TENANT, quarantine: false })
    expect(r.anomalies.filter((a) => a.check === 'state_mismatch')).toHaveLength(0)
    // Full sweep catches it.
    const full = await engine.reconciler.runOnce({
      tenantId: TENANT,
      quarantine: false,
      fullSweep: true,
    })
    expect(full.anomalies.some((a) => a.check === 'state_mismatch')).toBe(true)
  })
})

describe('fabricated_key watermark', () => {
  it('skips fabricated keys whose granted_by_transition_id is below the watermark', async () => {
    if (!engine) return
    const { recordId } = await drivePay(engine, 'k1')
    // Capture a transition id that exists, then advance the watermark
    // beyond it via a fresh record. Inject a fabricated key referencing
    // a ULID below the watermark.
    await engine.reconciler.runOnce({ tenantId: TENANT })
    await drivePay(engine, 'k2') // bumps watermark via new transitions
    await engine.reconciler.runOnce({ tenantId: TENANT })

    // Fake granting transition id (sortable text) — must be < current
    // watermark (any new ULID starts with '01J…' or higher in 2026).
    const lowFakeId = '00000000000000000000000000'
    await engine.connection.sql.unsafe(`
      alter table "txn_keys" disable trigger all;
      insert into "txn_keys" (tenant_id, txn_id, name, granted_by_transition_id, status)
      values ('${TENANT}', '${recordId}', 'refund', '${lowFakeId}', 'active');
      alter table "txn_keys" enable trigger all;
    `)

    const r = await engine.reconciler.runOnce({ tenantId: TENANT, quarantine: false })
    expect(r.anomalies.filter((a) => a.check === 'fabricated_key')).toHaveLength(0)
    // Full sweep finds it.
    const full = await engine.reconciler.runOnce({
      tenantId: TENANT,
      quarantine: false,
      fullSweep: true,
    })
    expect(full.anomalies.some((a) => a.check === 'fabricated_key')).toBe(true)
  })
})
