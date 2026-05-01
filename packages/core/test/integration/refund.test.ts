import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  IllegalStateTransitionError,
  MIGRATIONS_TABLE,
  createEngine,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-refund'
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
    await engine.close()
  }
  engine = createEngine({ schema: chidoriSchema, connection: { url: dbUrl } })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'Refund' })
})

const drivePay = async (
  e: Engine,
  suffix: string,
): Promise<{
  recordId: string
  payTransitionId: string
  refundKeyId: string
  user: { type: string; id: string }
  driver: { type: string; id: string }
  company: { type: string; id: string }
}> => {
  const client = e.forTenant(TENANT)
  const user = { type: 'User', id: `u-${suffix}` }
  const driver = { type: 'Driver', id: `d-${suffix}` }
  const company = { type: 'Company', id: 'co-1' }
  await client.accounts.create({ actor: user, name: 'wallet' })
  await client.accounts.create({ actor: driver, name: 'balance' })
  await client.accounts.create({ actor: company, name: 'revenue' })
  const txn = await client.transactions.create({
    type: 'DeliveryPayment',
    by: user,
    participants: { user, driver, company },
    idempotencyKey: `${suffix}:create`,
  })
  const r = await client.transactions.transition({
    id: txn.record.id,
    name: 'pay',
    by: user,
    data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    idempotencyKey: `${suffix}:pay`,
  })
  return {
    recordId: txn.record.id,
    payTransitionId: r.transition.id,
    refundKeyId: r.unlocked['refund'] as string,
    user,
    driver,
    company,
  }
}

describe('refund — invert: postings resolution', () => {
  it('drives pay→refund and lands the record in `refunded`', async () => {
    if (!engine) return
    const { recordId, refundKeyId, company } = await drivePay(engine, 'flow')

    const client = engine.forTenant(TENANT)
    const r = await client.transactions.transition({
      id: recordId,
      name: 'refund',
      by: company,
      withKey: refundKeyId,
      data: { reason: 'driver no-show' },
      idempotencyKey: 'flow:refund',
    })

    expect(r.record.state).toBe('refunded')
    expect(r.transition.name).toBe('refund')
    expect(r.transition.reverses).not.toBeNull()
  })

  it('inverts every leg: balances net to zero across user, driver, company', async () => {
    if (!engine) return
    const { recordId, refundKeyId, user, driver, company } = await drivePay(engine, 'zero')

    const client = engine.forTenant(TENANT)

    // After `pay`: wallet -1500, balance +500, revenue +1000.
    expect(await client.accounts.balance({ actor: user, name: 'wallet', currency: 'NGN' })).toBe(
      -1500n,
    )
    expect(await client.accounts.balance({ actor: driver, name: 'balance', currency: 'NGN' })).toBe(
      500n,
    )
    expect(
      await client.accounts.balance({ actor: company, name: 'revenue', currency: 'NGN' }),
    ).toBe(1000n)

    await client.transactions.transition({
      id: recordId,
      name: 'refund',
      by: company,
      withKey: refundKeyId,
      data: { reason: 'driver no-show' },
      idempotencyKey: 'zero:refund',
    })

    // After refund: every leg flipped — net zero.
    expect(await client.accounts.balance({ actor: user, name: 'wallet', currency: 'NGN' })).toBe(0n)
    expect(await client.accounts.balance({ actor: driver, name: 'balance', currency: 'NGN' })).toBe(
      0n,
    )
    expect(
      await client.accounts.balance({ actor: company, name: 'revenue', currency: 'NGN' }),
    ).toBe(0n)
  })

  it('writes a reverses link from the refund row to the pay row', async () => {
    if (!engine) return
    const { recordId, payTransitionId, refundKeyId, company } = await drivePay(engine, 'link')

    const client = engine.forTenant(TENANT)
    const r = await client.transactions.transition({
      id: recordId,
      name: 'refund',
      by: company,
      withKey: refundKeyId,
      data: { reason: 'wrong driver' },
      idempotencyKey: 'link:refund',
    })

    expect(r.transition.reverses).toBe(payTransitionId)
  })

  it('refuses a second refund: the record is in `refunded` (terminal-from-pay)', async () => {
    if (!engine) return
    const { recordId, refundKeyId, company } = await drivePay(engine, 'twice')
    const client = engine.forTenant(TENANT)
    await client.transactions.transition({
      id: recordId,
      name: 'refund',
      by: company,
      withKey: refundKeyId,
      data: { reason: 'first' },
      idempotencyKey: 'twice:refund-1',
    })
    // The state guard catches the second attempt before the key guard
    // — refund only fires from `completed`, but the record is now in
    // `refunded`. This is the right layer: illegal state moves should
    // fail without consulting any capability key.
    await expect(
      client.transactions.transition({
        id: recordId,
        name: 'refund',
        by: company,
        withKey: refundKeyId,
        data: { reason: 'second' },
        idempotencyKey: 'twice:refund-2',
      }),
    ).rejects.toBeInstanceOf(IllegalStateTransitionError)
  })

  it('passes reconciliation: hash chain + balances + checksum all clean post-refund', async () => {
    if (!engine) return
    const { recordId, refundKeyId, company } = await drivePay(engine, 'recon')
    await engine.forTenant(TENANT).transactions.transition({
      id: recordId,
      name: 'refund',
      by: company,
      withKey: refundKeyId,
      data: { reason: 'qa' },
      idempotencyKey: 'recon:refund',
    })

    const result = await engine.reconciler.runOnce()
    if (result.anomalies.length > 0) {
      console.error('post-refund anomaly:', JSON.stringify(result.anomalies[0], null, 2))
    }
    expect(result.anomalies).toHaveLength(0)
    expect(result.quarantined).toHaveLength(0)
  })
})
