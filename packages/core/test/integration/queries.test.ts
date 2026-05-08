import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type Engine, MIGRATIONS_TABLE, createEngine } from '../../src/index.js'
import { chidoriSchema, topUpWallet } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-queries'
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
  await engine.admin.tenants.create({ id: TENANT, name: 'Queries' })
})

const setupAndPay = async (
  e: Engine,
  driverId: string,
  count: number,
): Promise<{ user: { type: string; id: string } }> => {
  const client = e.forTenant(TENANT)
  const user = { type: 'User', id: `u-${driverId}` }
  const driver = { type: 'Driver', id: driverId }
  const company = { type: 'Company', id: 'co-1' }
  await client.accounts.create({ actor: user, name: 'wallet' })
  await client.accounts.create({ actor: driver, name: 'balance' })
  await client.accounts.create({ actor: company, name: 'revenue' })
  // Pre-fund — overdraft is now refused by default. Cover all `count` pays.
  await topUpWallet(e, TENANT, user.id, BigInt(count) * 1500n)
  for (let i = 0; i < count; i++) {
    const txn = await client.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: `${driverId}:create:${i}`,
    })
    await client.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
      idempotencyKey: `${driverId}:pay:${i}`,
    })
  }
  return { user }
}

describe('queries.actor(...).transactions — paginated per-actor records', () => {
  it('returns records the actor has driven a transition on', async () => {
    if (!engine) return
    await setupAndPay(engine, 'd-q1', 3)
    const driver = { type: 'Driver', id: 'd-q1' }
    const client = engine.forTenant(TENANT)
    const page = await client.queries.actor(driver).transactions({ limit: 100 })
    expect(page.items).toHaveLength(3)
    expect(page.nextCursor).toBeNull()
    for (const r of page.items) {
      expect(r.type).toBe('DeliveryPayment')
      expect(r.state).toBe('completed')
    }
  })

  it('respects type and state filters', async () => {
    if (!engine) return
    await setupAndPay(engine, 'd-q2', 2)
    const driver = { type: 'Driver', id: 'd-q2' }
    const client = engine.forTenant(TENANT)
    const noMatch = await client.queries
      .actor(driver)
      .transactions({ state: 'refunded', limit: 100 })
    expect(noMatch.items).toHaveLength(0)
    const match = await client.queries
      .actor(driver)
      .transactions({ state: ['completed'], limit: 100 })
    expect(match.items).toHaveLength(2)
  })

  it('paginates with a stable cursor — exact-page boundary', async () => {
    if (!engine) return
    await setupAndPay(engine, 'd-q3', 5)
    const driver = { type: 'Driver', id: 'd-q3' }
    const client = engine.forTenant(TENANT)

    const first = await client.queries.actor(driver).transactions({ limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    const second = await client.queries
      .actor(driver)
      .transactions({ limit: 2, cursor: first.nextCursor as string })
    expect(second.items).toHaveLength(2)
    expect(second.nextCursor).not.toBeNull()

    const third = await client.queries
      .actor(driver)
      .transactions({ limit: 2, cursor: second.nextCursor as string })
    expect(third.items).toHaveLength(1)
    expect(third.nextCursor).toBeNull()

    // No record appears twice across pages.
    const seen = new Set([...first.items, ...second.items, ...third.items].map((r) => r.id))
    expect(seen.size).toBe(5)
  })
})

describe('queries.actor(...).summary', () => {
  it('aggregates transition count, credits, debits, and per-state/type breakdowns', async () => {
    if (!engine) return
    await setupAndPay(engine, 'd-sum', 3)
    // Query by the user — they drove the `pay` transitions. The driver
    // is a participant but didn't drive transitions in this schema, so
    // a driver-summary would show zero (correct: summary is "what did
    // the actor *do*", not "what did they participate in").
    const user = { type: 'User', id: 'u-d-sum' }
    const client = engine.forTenant(TENANT)
    const summary = await client.queries.actor(user).summary({})
    // Plus the synthetic _init genesis (one per record).
    expect(summary.transitions).toBe(6)
    // Each pay posts D 1500, C 500, C 1000. Genesis posts nothing.
    expect(summary.totalDebited).toBe(3n * 1500n)
    expect(summary.totalCredited).toBe(3n * (500n + 1000n))
    // The user is a participant, not the driver of the latest transition,
    // but the records they're involved in are all completed.
    expect(summary.byState['completed']).toBe(3)
    expect(summary.byType['DeliveryPayment']).toBe(3)
  })
})

describe('queries.account.history', () => {
  it('returns postings on an account in DESC order by occurredAt', async () => {
    if (!engine) return
    await setupAndPay(engine, 'd-hist', 3)
    const client = engine.forTenant(TENANT)
    const driverBalance = {
      actor: { type: 'Driver', id: 'd-hist' },
      name: 'balance',
      currency: 'NGN',
    }
    const page = await client.queries.account.history(driverBalance, { limit: 100 })
    expect(page.items).toHaveLength(3)
    for (const p of page.items) {
      expect(p.direction).toBe('C')
      expect(p.amount).toBe(500n)
    }
  })

  it('filters by direction and amount', async () => {
    if (!engine) return
    await setupAndPay(engine, 'd-filter', 2)
    const client = engine.forTenant(TENANT)
    const driverBalance = {
      actor: { type: 'Driver', id: 'd-filter' },
      name: 'balance',
      currency: 'NGN',
    }
    const credits = await client.queries.account.history(driverBalance, {
      direction: 'C',
      amount: { gte: 500 },
    })
    expect(credits.items).toHaveLength(2)
    const debits = await client.queries.account.history(driverBalance, { direction: 'D' })
    expect(debits.items).toHaveLength(0)
  })
})

describe('queries.account.balanceAt', () => {
  it('replays postings up to a point in time', async () => {
    if (!engine) return
    await setupAndPay(engine, 'd-bat', 2)
    const client = engine.forTenant(TENANT)
    const driverBalance = {
      actor: { type: 'Driver', id: 'd-bat' },
      name: 'balance',
      currency: 'NGN',
    }
    // Now: 2 * 500 credited.
    const now = await client.queries.account.balanceAt(driverBalance, new Date())
    expect(now).toBe(1000n)
    // Far in the past: no postings yet.
    const ancient = await client.queries.account.balanceAt(driverBalance, new Date('2000-01-01'))
    expect(ancient).toBe(0n)
  })
})

describe('queries.transactions.findMany', () => {
  it('filters by state, type, and supports keyset pagination', async () => {
    if (!engine) return
    await setupAndPay(engine, 'd-fm', 4)
    const client = engine.forTenant(TENANT)
    const all = await client.queries.transactions.findMany({
      where: { type: 'DeliveryPayment', state: 'completed' },
      limit: 2,
    })
    expect(all.items).toHaveLength(2)
    expect(all.nextCursor).not.toBeNull()
    const next = await client.queries.transactions.findMany({
      where: { type: 'DeliveryPayment', state: 'completed' },
      limit: 2,
      cursor: all.nextCursor as string,
    })
    expect(next.items).toHaveLength(2)
  })
})

describe('queries.transitions.findMany', () => {
  it('filters by name and actor; orders by occurredAt DESC by default', async () => {
    if (!engine) return
    await setupAndPay(engine, 'd-tm', 3)
    const client = engine.forTenant(TENANT)
    const transitions = await client.queries.transitions.findMany({
      where: { name: 'pay', actor: { type: 'User', id: 'u-d-tm' } },
      limit: 100,
    })
    expect(transitions.items).toHaveLength(3)
    for (const t of transitions.items) expect(t.name).toBe('pay')
  })
})

describe('queries.postings.findMany', () => {
  it('filters by direction + amount range', async () => {
    if (!engine) return
    await setupAndPay(engine, 'd-pm', 2)
    const client = engine.forTenant(TENANT)
    const result = await client.queries.postings.findMany({
      where: { direction: 'D', amount: { gte: 1500, lte: 1500 } },
    })
    // Two pay transitions, each debit user.wallet 1500.
    expect(result.items).toHaveLength(2)
    for (const p of result.items) {
      expect(p.direction).toBe('D')
      expect(p.amount).toBe(1500n)
    }
  })
})

describe('queries.anomalies.findMany', () => {
  it('returns anomalies the reconciler wrote', async () => {
    if (!engine) return
    await setupAndPay(engine, 'd-anom', 1)
    // Tamper to provoke a balance_drift anomaly.
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = balance + 999 where owner_actor_type = 'User' and owner_actor_id = 'u-d-anom'`,
    )
    await engine.reconciler.runOnce({ quarantine: false })

    const client = engine.forTenant(TENANT)
    const found = await client.queries.anomalies.findMany({
      where: { check: 'balance_drift' },
      limit: 100,
    })
    expect(found.items.length).toBeGreaterThan(0)
    expect(found.items[0]?.check).toBe('balance_drift')
  })
})
