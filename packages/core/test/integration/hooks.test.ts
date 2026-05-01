import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type AfterTransitionEvent,
  type BeforeTransitionEvent,
  type Engine,
  MIGRATIONS_TABLE,
  RejectTransition,
  createEngine,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-hooks'
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
  await engine.admin.tenants.create({ id: TENANT, name: 'Hooks' })
})

const setupChidoriRecord = async (
  e: Engine,
  user: { type: string; id: string } = { type: 'User', id: 'u-1' },
  driver: { type: string; id: string } = { type: 'Driver', id: 'd-1' },
  company: { type: string; id: string } = { type: 'Company', id: 'co-1' },
): Promise<{ id: string }> => {
  const client = e.forTenant(TENANT)
  await client.accounts.create({ actor: user, name: 'wallet' })
  await client.accounts.create({ actor: driver, name: 'balance' })
  await client.accounts.create({ actor: company, name: 'revenue' })
  await e.connection.sql.unsafe(
    `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = '${user.id}' and name = 'wallet'`,
  )
  const r = await client.transactions.create({
    type: 'DeliveryPayment',
    by: user,
    participants: { user, driver, company },
    idempotencyKey: `${user.id}:create`,
  })
  return { id: r.record.id }
}

describe('beforeTransition', () => {
  it('aborts the transition if the handler throws RejectTransition', async () => {
    if (!engine) return
    engine.hooks.beforeTransition({ transitionName: 'pay' }, async () => {
      throw new RejectTransition('outside business hours')
    })
    const { id } = await setupChidoriRecord(engine)

    const client = engine.forTenant(TENANT)
    await expect(
      client.transactions.transition({
        id,
        name: 'pay',
        by: { type: 'User', id: 'u-1' },
        data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
        idempotencyKey: 'before:pay',
      }),
    ).rejects.toBeInstanceOf(RejectTransition)

    // Nothing should have been written: balance stays at 5000.
    const balance = await client.accounts.balance({
      actor: { type: 'User', id: 'u-1' },
      name: 'wallet',
      currency: 'NGN',
    })
    expect(balance).toBe(5000n)
    // No transition row beyond _init.
    const trail = await client.transactions.trace(id)
    expect(trail).toHaveLength(1)
    expect(trail[0]?.name).toBe('_init')
  })

  it('does not fire on a transition that does not match the filter', async () => {
    if (!engine) return
    let called = false
    engine.hooks.beforeTransition({ transitionName: 'cancel' }, async () => {
      called = true
    })
    const { id } = await setupChidoriRecord(engine)

    const client = engine.forTenant(TENANT)
    await client.transactions.transition({
      id,
      name: 'pay',
      by: { type: 'User', id: 'u-1' },
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
      idempotencyKey: 'before-no-match:pay',
    })
    expect(called).toBe(false)
  })
})

describe('afterTransition', () => {
  it('fires post-commit with the committed record + transition', async () => {
    if (!engine) return
    const seen: AfterTransitionEvent[] = []
    engine.hooks.afterTransition({ transitionName: 'pay' }, async (e) => {
      seen.push(e)
    })
    const { id } = await setupChidoriRecord(engine)
    const client = engine.forTenant(TENANT)
    const r = await client.transactions.transition({
      id,
      name: 'pay',
      by: { type: 'User', id: 'u-1' },
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
      idempotencyKey: 'after:pay',
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.transitionName).toBe('pay')
    expect(seen[0]?.transition.id).toBe(r.transition.id)
    expect(seen[0]?.unlocked).toHaveProperty('refund')
  })

  it('errors in afterTransition are isolated and routed to onHookFailure', async () => {
    if (!engine) return
    const failures: unknown[] = []
    engine.hooks.afterTransition(undefined, async () => {
      throw new Error('downstream blew up')
    })
    engine.hooks.onHookFailure(async (e) => {
      failures.push(e)
    })
    const { id } = await setupChidoriRecord(engine, { type: 'User', id: 'u-iso' })

    const client = engine.forTenant(TENANT)
    // Despite the throwing handler, the transition completes successfully.
    const r = await client.transactions.transition({
      id,
      name: 'pay',
      by: { type: 'User', id: 'u-iso' },
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
      idempotencyKey: 'iso:pay',
    })
    expect(r.replayed).toBe(false)
    expect(failures.length).toBeGreaterThanOrEqual(1)
  })

  it('also fires for the synthetic _init genesis on create()', async () => {
    if (!engine) return
    const seen: BeforeTransitionEvent[] = []
    const after: AfterTransitionEvent[] = []
    engine.hooks.beforeTransition({ transitionName: '_init' }, async (e) => {
      seen.push(e)
    })
    engine.hooks.afterTransition({ transitionName: '_init' }, async (e) => {
      after.push(e)
    })

    // beforeTransition for `_init` is informational (genesis isn't gated)
    // — but afterTransition still fires.
    const client = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-gen' }
    await client.accounts.create({ actor: user, name: 'wallet' })
    await client.accounts.create({ actor: { type: 'Driver', id: 'd-gen' }, name: 'balance' })
    await client.accounts.create({ actor: { type: 'Company', id: 'co-1' }, name: 'revenue' })
    await client.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: {
        user,
        driver: { type: 'Driver', id: 'd-gen' },
        company: { type: 'Company', id: 'co-1' },
      },
      idempotencyKey: 'genesis:create',
    })
    expect(after.length).toBeGreaterThanOrEqual(1)
  })
})
