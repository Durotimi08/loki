/**
 * Batch 11 — multi-currency / FX (M16) integration coverage:
 *   - Postings on a transition must balance per currency, not in aggregate
 *   - An FX transition with two currencies and a holding account is accepted
 *   - Reconciler's checkUnbalancedPostings groups by currency too
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  MIGRATIONS_TABLE,
  RECONCILER_STATE_TABLE,
  UnbalancedPostingsError,
  createEngine,
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '../../src/index.js'
import { stubPayload } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-batch11'
let engine: Engine | null = null
let dbUrl: string | null = null

const Org = defineTenant('Org')
const User = defineActor('User', {
  accounts: {
    usd_wallet: { currency: 'USD' },
    ngn_wallet: { currency: 'NGN' },
  },
})
// Bank's FX clearing accounts are explicitly liability-style — they
// accumulate cross-currency imbalance and can run negative as the
// engine debits one side and credits the other. `allowOverdraft: true`
// is the right semantic here (the new default `false` would refuse
// the FX transition).
const Bank = defineActor('Bank', {
  accounts: {
    fx_usd: { currency: 'USD', allowOverdraft: true },
    fx_ngn: { currency: 'NGN', allowOverdraft: true },
  },
})

const FxExchange = defineTransaction('FxExchange', {
  states: ['pending', 'completed'],
  initial: 'pending',
  terminal: ['completed'],
  participants: { user: User, bank: Bank },
  transitions: (t) => ({
    settle: t({
      from: 'pending',
      to: 'completed',
      by: [User],
      payload: stubPayload<{ usd: bigint; ngn: bigint }>(),
      // Two-leg FX: each currency balances within itself. The cross-
      // currency rate lives in the payload (data.usd / data.ngn).
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.user.usd_wallet, amount: data.usd },
        { direction: 'C', account: participants.bank.fx_usd, amount: data.usd },
        { direction: 'D', account: participants.bank.fx_ngn, amount: data.ngn },
        { direction: 'C', account: participants.user.ngn_wallet, amount: data.ngn },
      ],
    }),
  }),
})

// A degenerate schema that lets us test the per-currency balance
// guard: the `bad` transition produces postings that sum to zero in
// aggregate but never per-currency, and must be rejected.
const BadFx = defineTransaction('BadFx', {
  states: ['pending', 'completed'],
  initial: 'pending',
  terminal: ['completed'],
  participants: { user: User },
  transitions: (t) => ({
    bad: t({
      from: 'pending',
      to: 'completed',
      by: [User],
      payload: stubPayload<{ amount: bigint }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.user.usd_wallet, amount: data.amount },
        { direction: 'C', account: participants.user.ngn_wallet, amount: data.amount },
      ],
    }),
  }),
})

const schema = defineSchema({
  tenant: Org,
  actors: [User, Bank],
  transactions: [FxExchange, BadFx],
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
  await engine.admin.tenants.create({ id: TENANT, name: 'B11' })
})

const provisionUser = async (e: Engine, suffix: string) => {
  const c = e.forTenant(TENANT)
  const user = { type: 'User', id: `u-${suffix}` }
  const bank = { type: 'Bank', id: 'bk-1' }
  await c.accounts.create({ actor: user, name: 'usd_wallet' })
  await c.accounts.create({ actor: user, name: 'ngn_wallet' })
  await c.accounts.create({ actor: bank, name: 'fx_usd' })
  await c.accounts.create({ actor: bank, name: 'fx_ngn' })
  // Pre-fund the user's USD wallet via a balanced bootstrap. We bypass
  // the engine here because the focus is on the FX leg, not seed funds.
  await e.connection.sql.unsafe(
    `update "accounts" set balance = 100 where owner_actor_type = 'User' and owner_actor_id = '${user.id}' and currency = 'USD'`,
  )
  return { user, bank }
}

describe('engine — per-currency balance enforcement', () => {
  it('accepts an FX transition where each currency balances independently', async () => {
    if (!engine) return
    const { user, bank } = await provisionUser(engine, 'fx-ok')
    const c = engine.forTenant(TENANT)
    const txn = await c.transactions.create({
      type: 'FxExchange',
      by: user,
      participants: { user, bank },
      idempotencyKey: 'fx-ok:create',
    })
    // 100 USD ↔ 8500 NGN. Sum across all postings is 17_200 ≠ 0, but
    // per-currency D=C holds (USD: 100=100; NGN: 8500=8500).
    const r = await c.transactions.transition({
      id: txn.record.id,
      name: 'settle',
      by: user,
      data: { usd: 100n, ngn: 8500n },
      idempotencyKey: 'fx-ok:settle',
    })
    expect(r.record.state).toBe('completed')

    // Reconciler must not flag this as unbalanced.
    const recon = await engine.reconciler.runOnce({ tenantId: TENANT })
    expect(recon.anomalies.filter((a) => a.check === 'unbalanced_postings')).toHaveLength(0)
  })

  it('rejects a transition where currencies cancel only in aggregate', async () => {
    if (!engine) return
    const { user } = await provisionUser(engine, 'fx-bad')
    const c = engine.forTenant(TENANT)
    const txn = await c.transactions.create({
      type: 'BadFx',
      by: user,
      participants: { user },
      idempotencyKey: 'fx-bad:create',
    })
    await expect(
      c.transactions.transition({
        id: txn.record.id,
        name: 'bad',
        by: user,
        data: { amount: 100n },
        idempotencyKey: 'fx-bad:settle',
      }),
    ).rejects.toThrow(UnbalancedPostingsError)
  })

  it('UnbalancedPostingsError carries the offending currency', async () => {
    if (!engine) return
    const { user } = await provisionUser(engine, 'fx-err')
    const c = engine.forTenant(TENANT)
    const txn = await c.transactions.create({
      type: 'BadFx',
      by: user,
      participants: { user },
      idempotencyKey: 'fx-err:create',
    })
    try {
      await c.transactions.transition({
        id: txn.record.id,
        name: 'bad',
        by: user,
        data: { amount: 1n },
        idempotencyKey: 'fx-err:settle',
      })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(UnbalancedPostingsError)
      const err = e as UnbalancedPostingsError
      expect(err.currency).not.toBeNull()
      expect(['USD', 'NGN']).toContain(err.currency)
    }
  })
})

describe('reconciler — multi-currency unbalanced detection', () => {
  it('flags when a single currency leg is tampered with', async () => {
    if (!engine) return
    const { user, bank } = await provisionUser(engine, 'recon-fx')
    const c = engine.forTenant(TENANT)
    const txn = await c.transactions.create({
      type: 'FxExchange',
      by: user,
      participants: { user, bank },
      idempotencyKey: 'recon-fx:create',
    })
    await c.transactions.transition({
      id: txn.record.id,
      name: 'settle',
      by: user,
      data: { usd: 100n, ngn: 8500n },
      idempotencyKey: 'recon-fx:settle',
    })

    // Tamper with one NGN posting amount — the USD leg is still
    // balanced; only NGN drifts. The reconciler should report
    // unbalanced_postings for currency=NGN.
    await engine.connection.sql.unsafe(`
      update "postings"
      set amount = amount + 1
      where tenant_id = '${TENANT}'
        and account_id in (select id from "accounts" where currency = 'NGN' and tenant_id = '${TENANT}')
        and direction = 'C'
    `)

    const recon = await engine.reconciler.runOnce({ tenantId: TENANT, quarantine: false })
    const unbalanced = recon.anomalies.filter((a) => a.check === 'unbalanced_postings')
    expect(unbalanced).toHaveLength(1)
    const ctx = unbalanced[0]?.context as { currency?: string }
    expect(ctx?.currency).toBe('NGN')
  })
})
