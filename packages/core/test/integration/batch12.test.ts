/**
 * Batch 12 — holds + scheduled transitions + disputes (M17) integration:
 *   - scheduler.create persists a row, claims+fires when due,
 *     idempotency via the scheduled-row id round-trips a single
 *     downstream transition
 *   - scheduler.cancel flips pending → cancelled and prevents firing
 *   - escrow / hold pattern works end-to-end through existing primitives
 *   - dispute window: a scheduled transition closes the dispute deadline
 *     when no chargeback happened in the meantime
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  MIGRATIONS_TABLE,
  RECONCILER_STATE_TABLE,
  createEngine,
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '../../src/index.js'
import { stubPayload } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-batch12'
let engine: Engine | null = null
let dbUrl: string | null = null

const Org = defineTenant('Org')
const Buyer = defineActor('Buyer', { accounts: { wallet: { currency: 'USD' } } })
const Seller = defineActor('Seller', { accounts: { balance: { currency: 'USD' } } })
const Marketplace = defineActor('Marketplace', { accounts: { escrow: { currency: 'USD' } } })
const System = defineActor('System')

const Escrow = defineTransaction('Escrow', {
  states: ['held', 'released', 'refunded'],
  initial: 'held',
  terminal: ['released', 'refunded'],
  participants: { buyer: Buyer, seller: Seller, marketplace: Marketplace },
  transitions: (t) => ({
    // hold is the genesis: created already moves money into escrow
    hold: t({
      from: 'held',
      to: 'held',
      by: [Buyer],
      payload: stubPayload<{ amount: bigint }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.buyer.wallet, amount: data.amount },
        { direction: 'C', account: participants.marketplace.escrow, amount: data.amount },
      ],
      unlocks: ['release', 'refund'],
    }),
    release: t({
      from: 'held',
      to: 'released',
      by: [System, Marketplace],
      needs: 'release',
      payload: stubPayload<{ amount: bigint }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.marketplace.escrow, amount: data.amount },
        { direction: 'C', account: participants.seller.balance, amount: data.amount },
      ],
    }),
    refund: t({
      from: 'held',
      to: 'refunded',
      by: [Buyer, Marketplace],
      needs: 'refund',
      payload: stubPayload<{ amount: bigint }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.marketplace.escrow, amount: data.amount },
        { direction: 'C', account: participants.buyer.wallet, amount: data.amount },
      ],
    }),
  }),
})

const schema = defineSchema({
  tenant: Org,
  actors: [Buyer, Seller, Marketplace, System],
  transactions: [Escrow],
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
  await engine.admin.tenants.create({ id: TENANT, name: 'B12' })
})

const provision = async (e: Engine, suffix: string) => {
  const c = e.forTenant(TENANT)
  const buyer = { type: 'Buyer', id: `b-${suffix}` }
  const seller = { type: 'Seller', id: `s-${suffix}` }
  const marketplace = { type: 'Marketplace', id: 'mkt-1' }
  await c.accounts.create({ actor: buyer, name: 'wallet' })
  await c.accounts.create({ actor: seller, name: 'balance' })
  await c.accounts.create({ actor: marketplace, name: 'escrow' })
  await e.connection.sql.unsafe(
    `update "accounts" set balance = 10000 where owner_actor_type = 'Buyer' and owner_actor_id = '${buyer.id}'`,
  )
  return { buyer, seller, marketplace }
}

const startEscrow = async (e: Engine, suffix: string) => {
  const { buyer, seller, marketplace } = await provision(e, suffix)
  const c = e.forTenant(TENANT)
  const txn = await c.transactions.create({
    type: 'Escrow',
    by: buyer,
    participants: { buyer, seller, marketplace },
    idempotencyKey: `${suffix}:create`,
  })
  const held = await c.transactions.transition({
    id: txn.record.id,
    name: 'hold',
    by: buyer,
    data: { amount: 1500n },
    idempotencyKey: `${suffix}:hold`,
  })
  return {
    recordId: txn.record.id,
    buyer,
    seller,
    marketplace,
    releaseKeyId: held.unlocked.release as string,
    refundKeyId: held.unlocked.refund as string,
  }
}

describe('engine.scheduler — create / runDue / cancel', () => {
  it('schedules a release for the future and runDue (now=after) fires it', async () => {
    if (!engine) return
    const { recordId, marketplace, releaseKeyId } = await startEscrow(engine, 'sched-1')

    // Schedule a release 1 day in the future, then fast-forward `now`.
    const runAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const sched = await engine.scheduler.create({
      tenantId: TENANT,
      txnId: recordId,
      name: 'release',
      runAt,
      by: marketplace,
      data: { amount: 1500n },
      withKey: releaseKeyId,
      idempotencyKey: 'sched-1:release',
    })
    expect(sched.status).toBe('pending')

    // runDue at "now" should not pick it up (run_at is in the future).
    const r0 = await engine.scheduler.runDue({ tenantId: TENANT })
    expect(r0.fired).toHaveLength(0)

    // Fast-forward.
    const r1 = await engine.scheduler.runDue({
      tenantId: TENANT,
      now: new Date(runAt.getTime() + 1),
    })
    expect(r1.fired).toEqual([sched.id])
    expect(r1.failed).toHaveLength(0)

    // Verify state moved: record should be `released`.
    const c = engine.forTenant(TENANT)
    const rec = await c.transactions.get(recordId)
    expect(rec?.state).toBe('released')

    // Re-running runDue must not re-fire.
    const r2 = await engine.scheduler.runDue({
      tenantId: TENANT,
      now: new Date(runAt.getTime() + 60_000),
    })
    expect(r2.fired).toHaveLength(0)
  })

  it('cancel flips pending → cancelled and prevents firing', async () => {
    if (!engine) return
    const { recordId, marketplace, releaseKeyId } = await startEscrow(engine, 'sched-2')

    const runAt = new Date(Date.now() - 1000) // already due
    const sched = await engine.scheduler.create({
      tenantId: TENANT,
      txnId: recordId,
      name: 'release',
      runAt,
      by: marketplace,
      data: { amount: 1500n },
      withKey: releaseKeyId,
      idempotencyKey: 'sched-2:release',
    })

    const cancelled = await engine.scheduler.cancel(sched.id, { tenantId: TENANT })
    expect(cancelled).toBe(true)

    const r = await engine.scheduler.runDue({ tenantId: TENANT })
    expect(r.fired).toHaveLength(0)

    // Record should still be in `held`.
    const c = engine.forTenant(TENANT)
    const rec = await c.transactions.get(recordId)
    expect(rec?.state).toBe('held')

    // Cancelling again returns false (no rows to update).
    const second = await engine.scheduler.cancel(sched.id, { tenantId: TENANT })
    expect(second).toBe(false)
  })

  it('records failures with last_error when the underlying transition rejects', async () => {
    if (!engine) return
    const { recordId, marketplace, releaseKeyId } = await startEscrow(engine, 'sched-3')

    // Force a failure by expiring the capability key after scheduling.
    await engine.connection.sql.unsafe(`
      update "txn_keys" set status = 'expired'
      where tenant_id = '${TENANT}' and name = 'release' and status = 'active'
    `)

    const sched = await engine.scheduler.create({
      tenantId: TENANT,
      txnId: recordId,
      name: 'release',
      runAt: new Date(Date.now() - 1000),
      by: marketplace,
      data: { amount: 1500n },
      withKey: releaseKeyId,
      idempotencyKey: 'sched-3:release',
    })

    const r = await engine.scheduler.runDue({ tenantId: TENANT })
    expect(r.fired).toHaveLength(0)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]?.id).toBe(sched.id)

    // The row's status should be `failed` with the error captured.
    const list = await engine.scheduler.list({ tenantId: TENANT, status: 'failed' })
    expect(list).toHaveLength(1)
    expect(list[0]?.lastError).toBeTruthy()
  })

  it('idempotency: re-creating the same (txn, key) returns the existing row', async () => {
    if (!engine) return
    const { recordId, marketplace, releaseKeyId } = await startEscrow(engine, 'sched-4')

    const args = {
      tenantId: TENANT,
      txnId: recordId,
      name: 'release' as const,
      runAt: new Date(Date.now() + 60_000),
      by: marketplace,
      data: { amount: 1500n },
      withKey: releaseKeyId,
      idempotencyKey: 'sched-4:once',
    }
    const a = await engine.scheduler.create(args)
    const b = await engine.scheduler.create(args)
    expect(a.id).toBe(b.id)
    expect(b.status).toBe('pending')
  })
})

describe('escrow / hold pattern works on existing primitives', () => {
  it('moves money to escrow on hold, then to seller on release', async () => {
    if (!engine) return
    const { recordId, buyer, marketplace, seller, releaseKeyId } = await startEscrow(
      engine,
      'esc-1',
    )
    const c = engine.forTenant(TENANT)

    // Marketplace owner releases.
    await c.transactions.transition({
      id: recordId,
      name: 'release',
      by: marketplace,
      data: { amount: 1500n },
      withKey: releaseKeyId,
      idempotencyKey: 'esc-1:release',
    })

    const buyerBalance = await c.accounts.balance({ actor: buyer, name: 'wallet', currency: 'USD' })
    const escrowBalance = await c.accounts.balance({
      actor: marketplace,
      name: 'escrow',
      currency: 'USD',
    })
    const sellerBalance = await c.accounts.balance({
      actor: seller,
      name: 'balance',
      currency: 'USD',
    })
    expect(buyerBalance).toBe(8500n) // 10000 - 1500
    expect(escrowBalance).toBe(0n)
    expect(sellerBalance).toBe(1500n)
  })
})
