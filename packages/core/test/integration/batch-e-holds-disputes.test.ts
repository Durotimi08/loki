/**
 * Integration coverage for batch E (M17) — first-class holds + disputes.
 *
 *   - holds.place / release / expireDue / get / list
 *   - disputes.open / resolve / expireDue / get / list
 *   - Idempotent semantics on release & resolve.
 *
 * Honest scope: storage + helper APIs only. The schema-DSL primitives
 * (defineHold, defineDispute) that would type postings around these
 * are a follow-up — operators wire them with capability keys + the
 * scheduler today.
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

const TENANT = 'org-holds'
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
  await engine.admin.tenants.create({ id: TENANT, name: 'HoldsDisputes' })
})

const setupAccount = async (e: Engine, suffix: string): Promise<string> => {
  const c = e.forTenant(TENANT)
  const company = { type: 'Company', id: `co-${suffix}` }
  await c.accounts.create({ actor: company, name: 'escrow' })
  const [row] = await e.connection.sql<{ id: string }[]>`
    select id from accounts
    where owner_actor_type = 'Company' and owner_actor_id = ${`co-${suffix}`} and name = 'escrow'
    limit 1
  `
  if (!row) throw new Error('account missing')
  return row.id
}

describe('batch E — holds', () => {
  it('place + release flow', async () => {
    if (!engine) return
    const accountId = await setupAccount(engine, 'place')
    const hold = await engine.holds.place({
      tenantId: TENANT,
      holdAccountId: accountId,
      amount: 5000n,
    })
    expect(hold.status).toBe('placed')
    expect(hold.amount).toBe(5000n)

    const released = await engine.holds.release({ id: hold.id })
    expect(released.status).toBe('released')
    expect(released.releasedAt).toBeInstanceOf(Date)
  })

  it('release is idempotent — second call returns the row unchanged', async () => {
    if (!engine) return
    const accountId = await setupAccount(engine, 'idem')
    const hold = await engine.holds.place({
      tenantId: TENANT,
      holdAccountId: accountId,
      amount: 1000n,
    })
    const a = await engine.holds.release({ id: hold.id })
    const b = await engine.holds.release({ id: hold.id })
    expect(a.status).toBe('released')
    expect(b.status).toBe('released')
    expect(b.releasedAt?.getTime()).toBe(a.releasedAt?.getTime())
  })

  it('expireDue flips placed holds whose deadline has passed', async () => {
    if (!engine) return
    const accountId = await setupAccount(engine, 'expire')
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + 60_000)
    const expiring = await engine.holds.place({
      tenantId: TENANT,
      holdAccountId: accountId,
      amount: 100n,
      expiresAt: past,
    })
    const stillFresh = await engine.holds.place({
      tenantId: TENANT,
      holdAccountId: accountId,
      amount: 200n,
      expiresAt: future,
    })
    const result = await engine.holds.expireDue()
    expect(result.expired).toContain(expiring.id)
    expect(result.expired).not.toContain(stillFresh.id)

    const after = await engine.holds.get(expiring.id)
    expect(after?.status).toBe('expired')
  })

  it('list filters by status', async () => {
    if (!engine) return
    const accountId = await setupAccount(engine, 'list')
    const a = await engine.holds.place({
      tenantId: TENANT,
      holdAccountId: accountId,
      amount: 100n,
    })
    const b = await engine.holds.place({
      tenantId: TENANT,
      holdAccountId: accountId,
      amount: 200n,
    })
    await engine.holds.release({ id: a.id })
    const placed = await engine.holds.list({ tenantId: TENANT, status: 'placed' })
    expect(placed.map((h) => h.id)).toContain(b.id)
    expect(placed.map((h) => h.id)).not.toContain(a.id)
  })

  it('rejects non-positive amounts', async () => {
    if (!engine) return
    const accountId = await setupAccount(engine, 'reject')
    await expect(
      engine.holds.place({ tenantId: TENANT, holdAccountId: accountId, amount: 0n }),
    ).rejects.toThrow(/positive/)
  })
})

describe('batch E — disputes', () => {
  const driveTransition = async (suffix: string): Promise<string> => {
    if (!engine) throw new Error('no engine')
    const c = engine.forTenant(TENANT)
    const user = { type: 'User', id: `u-${suffix}` }
    const driver = { type: 'Driver', id: `d-${suffix}` }
    const company = { type: 'Company', id: `co-${suffix}` }
    await c.accounts.create({ actor: user, name: 'wallet' })
    await c.accounts.create({ actor: driver, name: 'balance' })
    await c.accounts.create({ actor: company, name: 'revenue' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = 'u-${suffix}'`,
    )
    const txn = await c.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: `${suffix}:create`,
    })
    const r = await c.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      idempotencyKey: `${suffix}:pay`,
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    })
    return r.transition.id
  }

  it('open + resolve customer-favourable flow', async () => {
    if (!engine) return
    const transitionId = await driveTransition('d1')
    const dispute = await engine.disputes.open({
      tenantId: TENANT,
      originalTransitionId: transitionId,
      reason: 'unauthorized charge',
    })
    expect(dispute.status).toBe('open')

    const resolved = await engine.disputes.resolve({
      id: dispute.id,
      outcome: 'customer',
      resolution: 'refund issued',
    })
    expect(resolved.status).toBe('resolved_customer')
    expect(resolved.resolution).toBe('refund issued')
    expect(resolved.resolvedAt).toBeInstanceOf(Date)
  })

  it('resolve is idempotent for closed disputes', async () => {
    if (!engine) return
    const transitionId = await driveTransition('d2')
    const dispute = await engine.disputes.open({
      tenantId: TENANT,
      originalTransitionId: transitionId,
    })
    const a = await engine.disputes.resolve({ id: dispute.id, outcome: 'merchant' })
    const b = await engine.disputes.resolve({ id: dispute.id, outcome: 'customer' })
    // Second call cannot flip the verdict — first wins.
    expect(a.status).toBe('resolved_merchant')
    expect(b.status).toBe('resolved_merchant')
  })

  it('expireDue moves open disputes past deadline to expired', async () => {
    if (!engine) return
    const transitionId = await driveTransition('d3')
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + 60_000)
    const expiring = await engine.disputes.open({
      tenantId: TENANT,
      originalTransitionId: transitionId,
      deadlineAt: past,
    })
    const stillFresh = await engine.disputes.open({
      tenantId: TENANT,
      originalTransitionId: transitionId,
      deadlineAt: future,
    })
    const result = await engine.disputes.expireDue()
    expect(result.expired).toContain(expiring.id)
    expect(result.expired).not.toContain(stillFresh.id)

    const after = await engine.disputes.get(expiring.id)
    expect(after?.status).toBe('expired')
  })

  it('list filters by status', async () => {
    if (!engine) return
    const transitionId = await driveTransition('d4')
    const a = await engine.disputes.open({
      tenantId: TENANT,
      originalTransitionId: transitionId,
    })
    const b = await engine.disputes.open({
      tenantId: TENANT,
      originalTransitionId: transitionId,
    })
    await engine.disputes.resolve({ id: a.id, outcome: 'customer' })
    const open = await engine.disputes.list({ tenantId: TENANT, status: 'open' })
    expect(open.map((d) => d.id)).toContain(b.id)
    expect(open.map((d) => d.id)).not.toContain(a.id)
  })
})
