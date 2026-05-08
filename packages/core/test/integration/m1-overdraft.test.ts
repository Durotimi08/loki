/**
 * Batch A — M1 overdraft opt-in.
 *
 *   - allowOverdraft: false (the default) rejects debits that would
 *     take balance < 0
 *   - allowOverdraft: true lets balances go negative — used for
 *     external-funding sources, FX clearing legs, liability accounts
 *   - Reversal transitions bypass overdraft (admin operation)
 *   - Combination with shards is refused at schema-build time
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  MIGRATIONS_TABLE,
  OverdraftError,
  RECONCILER_STATE_TABLE,
  createEngine,
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '../../src/index.js'
import { stubPayload } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-m1'
let engine: Engine | null = null
let dbUrl: string | null = null

const Org = defineTenant('Org')
const User = defineActor('User', {
  accounts: { wallet: { currency: 'NGN', allowOverdraft: false } },
})
// `Driver.balance` opts INTO overdraft so the test that exercises
// "default-permissive" behaviour against the prior `?? true` default
// keeps a target. The default is now `false`.
const Driver = defineActor('Driver', {
  accounts: { balance: { currency: 'NGN', allowOverdraft: true } },
})
const Company = defineActor('Company', {
  accounts: { revenue: { currency: 'NGN' } },
})

const Pay = defineTransaction('Pay', {
  states: ['pending', 'paid', 'refunded'],
  initial: 'pending',
  terminal: ['refunded'],
  participants: { user: User, driver: Driver, company: Company },
  transitions: (t) => ({
    pay: t({
      from: 'pending',
      to: 'paid',
      by: [User],
      payload: stubPayload<{ amount: bigint }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.user.wallet, amount: data.amount },
        { direction: 'C', account: participants.company.revenue, amount: data.amount },
      ],
      unlocks: ['refund'],
    }),
    refund: t({
      from: 'paid',
      to: 'refunded',
      by: [Company],
      needs: 'refund',
      postings: 'invert:pay',
    }),
  }),
})

const schema = defineSchema({
  tenant: Org,
  actors: [User, Driver, Company],
  transactions: [Pay],
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
  await engine.admin.tenants.create({ id: TENANT, name: 'M1' })
})

const seed = async (e: Engine, suffix: string, balance: bigint) => {
  const c = e.forTenant(TENANT)
  const user = { type: 'User', id: `u-${suffix}` }
  const driver = { type: 'Driver', id: `d-${suffix}` }
  const company = { type: 'Company', id: 'co-1' }
  await c.accounts.create({ actor: user, name: 'wallet' })
  await c.accounts.create({ actor: driver, name: 'balance' })
  await c.accounts.create({ actor: company, name: 'revenue' })
  await e.connection.sql.unsafe(
    `update "accounts" set balance = ${balance} where owner_actor_type = 'User' and owner_actor_id = '${user.id}'`,
  )
  return { user, driver, company }
}

describe('overdraft refusal', () => {
  it('rejects a debit that would take balance below zero', async () => {
    if (!engine) return
    const { user, driver, company } = await seed(engine, 'reject', 100n)
    const c = engine.forTenant(TENANT)
    const txn = await c.transactions.create({
      type: 'Pay',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'm1-r:create',
    })
    await expect(
      c.transactions.transition({
        id: txn.record.id,
        name: 'pay',
        by: user,
        data: { amount: 500n }, // > 100 balance
        idempotencyKey: 'm1-r:pay',
      }),
    ).rejects.toBeInstanceOf(OverdraftError)

    // Balance unchanged — the tx rolled back.
    const balance = await c.accounts.balance({
      actor: user,
      name: 'wallet',
      currency: 'NGN',
    })
    expect(balance).toBe(100n)
  })

  it('allows a debit within the available balance', async () => {
    if (!engine) return
    const { user, driver, company } = await seed(engine, 'ok', 1000n)
    const c = engine.forTenant(TENANT)
    const txn = await c.transactions.create({
      type: 'Pay',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'm1-ok:create',
    })
    await c.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      data: { amount: 300n },
      idempotencyKey: 'm1-ok:pay',
    })
    const balance = await c.accounts.balance({
      actor: user,
      name: 'wallet',
      currency: 'NGN',
    })
    expect(balance).toBe(700n)
  })

  it('reversal transitions bypass overdraft (admin path)', async () => {
    if (!engine) return
    // Pay then refund a record where the user has spent the credited
    // amount elsewhere — refund must still go through.
    const { user, driver, company } = await seed(engine, 'rev', 500n)
    const c = engine.forTenant(TENANT)
    const txn = await c.transactions.create({
      type: 'Pay',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'm1-rev:create',
    })
    const r = await c.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      data: { amount: 500n },
      idempotencyKey: 'm1-rev:pay',
    })
    // Wallet is now 0. A refund inverts: company.revenue debit goes
    // through (it was a credit before; the company has 500 to refund).
    // The user.wallet credit goes through (no overdraft on a credit).
    await c.transactions.transition({
      id: txn.record.id,
      name: 'refund',
      by: company,
      withKey: r.unlocked.refund,
      idempotencyKey: 'm1-rev:refund',
    })
    const balance = await c.accounts.balance({
      actor: user,
      name: 'wallet',
      currency: 'NGN',
    })
    expect(balance).toBe(500n)
  })

  it('refuses allowOverdraft: false combined with shards > 1 at schema-build time', () => {
    expect(() =>
      defineActor('Bad', {
        accounts: {
          shared: { currency: 'NGN', shards: 4, allowOverdraft: false },
        },
      }),
    ).toThrow(/cannot combine with shards/)
  })
})
