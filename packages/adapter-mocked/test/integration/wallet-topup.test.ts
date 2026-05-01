import {
  type Engine,
  MIGRATIONS_TABLE,
  createEngine,
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '@loki/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMockedPsp } from '../../src/index.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

// =============================================================================
// §15.6 wallet top-up schema — exercises both the outbound (intent
// → adapter → confirm) and inbound (webhook → transition) paths.
// =============================================================================

const stub = <T>(): StandardSchemaV1<T, T> => ({
  '~standard': {
    version: 1,
    vendor: 'loki-test',
    validate: (v: unknown) => ({ value: v as T }),
    types: { input: undefined as unknown as T, output: undefined as unknown as T },
  },
})

const Org = defineTenant('Org')
const User = defineActor('User', { accounts: { wallet: { currency: 'NGN' } } })
const Company = defineActor('Company', {
  accounts: { psp_clearing: { currency: 'NGN' } },
})
const System = defineActor('System')

const WalletTopUp = defineTransaction('WalletTopUp', {
  states: ['initiated', 'awaiting_psp', 'funded', 'failed'],
  initial: 'initiated',
  terminal: ['funded', 'failed'],
  participants: { user: User, company: Company },
  transitions: (t) => ({
    request: t({
      from: 'initiated',
      to: 'awaiting_psp',
      by: [User],
      payload: stub<{ amount: bigint; paymentMethodId: string }>(),
      // Fires the outbox row whose `intent: 'mocked.charge'` routes
      // through the registered MockedPsp adapter.
      intent: 'mocked.charge',
    }),
    mark_funded: t({
      from: 'awaiting_psp',
      to: 'funded',
      by: [System],
      payload: stub<{ pspReference: string; amount: bigint }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.company.psp_clearing, amount: data.amount },
        { direction: 'C', account: participants.user.wallet, amount: data.amount },
      ],
      emit: 'wallet.topup_funded',
    }),
    mark_failed: t({
      from: 'awaiting_psp',
      to: 'failed',
      by: [System],
      payload: stub<{ reason: string }>(),
      emit: 'wallet.topup_failed',
    }),
  }),
})

const schema = defineSchema({
  tenant: Org,
  actors: [User, Company, System],
  transactions: [WalletTopUp],
})

// =============================================================================
// Setup
// =============================================================================

const TENANT = 'org-topup'
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
  engine = createEngine({ schema, connection: { url: dbUrl } })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'Topup' })
})

const buildPsp = () =>
  createMockedPsp({
    transitions: {
      charge: { success: 'mark_funded', failure: 'mark_failed' },
    },
    inbound: {
      'charge.succeeded': (event) => ({
        transition: 'mark_funded',
        txnId: event['txnId'] as string,
        idempotencyKey: `mocked:${event['eventId'] as string}`,
        data: {
          pspReference: event['reference'] as string,
          amount: BigInt(event['amount'] as string),
        },
      }),
    },
  })

const provisionAccounts = async (
  e: Engine,
  user: { type: 'User'; id: string },
  company: { type: 'Company'; id: string },
): Promise<void> => {
  const tenant = e.forTenant(TENANT)
  await tenant.accounts.create({ actor: user, name: 'wallet' })
  await tenant.accounts.create({ actor: company, name: 'psp_clearing' })
}

// =============================================================================
// Outbound — request → mocked.charge → confirm(mark_funded)
// =============================================================================

describe('outbound flow — engine drains outbox into the adapter', () => {
  it('routes mocked.charge to the adapter, which confirms mark_funded', async () => {
    if (!engine) return
    const psp = buildPsp()
    engine.adapters.register(psp.adapter)

    const user = { type: 'User', id: 'u-1' } as const
    const company = { type: 'Company', id: 'co-1' } as const
    await provisionAccounts(engine, user, company)

    const tenant = engine.forTenant(TENANT)
    const txn = await tenant.transactions.create({
      type: 'WalletTopUp',
      by: user,
      participants: { user, company },
      idempotencyKey: 'topup-1:create',
    })
    await tenant.transactions.transition({
      id: txn.record.id,
      name: 'request',
      by: user,
      data: { amount: 1500n, paymentMethodId: 'pm_x' },
      idempotencyKey: 'topup-1:request',
    })

    // Queue success and drain the outbox once.
    psp.queue('charge', {
      kind: 'success',
      data: { pspReference: 'pi_test_1', amount: 1500n },
    })

    const processed = await engine.outbox.drainOnce({})
    expect(processed).toBe(1)
    expect(psp.callCount('charge')).toBe(1)

    const record = await tenant.transactions.get(txn.record.id)
    expect(record?.state).toBe('funded')
    expect(await tenant.accounts.balance({ actor: user, name: 'wallet', currency: 'NGN' })).toBe(
      1500n,
    )
    expect(
      await tenant.accounts.balance({
        actor: company,
        name: 'psp_clearing',
        currency: 'NGN',
      }),
    ).toBe(-1500n)
  })

  it('routes a failure through fail() → mark_failed; balances stay zero', async () => {
    if (!engine) return
    const psp = buildPsp()
    engine.adapters.register(psp.adapter)

    const user = { type: 'User', id: 'u-fail' } as const
    const company = { type: 'Company', id: 'co-1' } as const
    await provisionAccounts(engine, user, company)

    const tenant = engine.forTenant(TENANT)
    const txn = await tenant.transactions.create({
      type: 'WalletTopUp',
      by: user,
      participants: { user, company },
      idempotencyKey: 'fail:create',
    })
    await tenant.transactions.transition({
      id: txn.record.id,
      name: 'request',
      by: user,
      data: { amount: 1500n, paymentMethodId: 'pm_x' },
      idempotencyKey: 'fail:request',
    })

    psp.queue('charge', { kind: 'failure', data: { reason: 'card_declined' } })
    await engine.outbox.drainOnce({})

    const record = await tenant.transactions.get(txn.record.id)
    expect(record?.state).toBe('failed')
    expect(await tenant.accounts.balance({ actor: user, name: 'wallet', currency: 'NGN' })).toBe(0n)
  })

  it('transient errors retry through outbox backoff — not a terminal failure', async () => {
    if (!engine) return
    const psp = buildPsp()
    engine.adapters.register(psp.adapter)

    const user = { type: 'User', id: 'u-trans' } as const
    const company = { type: 'Company', id: 'co-1' } as const
    await provisionAccounts(engine, user, company)

    const tenant = engine.forTenant(TENANT)
    const txn = await tenant.transactions.create({
      type: 'WalletTopUp',
      by: user,
      participants: { user, company },
      idempotencyKey: 'trans:create',
    })
    await tenant.transactions.transition({
      id: txn.record.id,
      name: 'request',
      by: user,
      data: { amount: 1500n, paymentMethodId: 'pm_x' },
      idempotencyKey: 'trans:request',
    })

    // First attempt: throw. Second attempt: succeed.
    psp.queue('charge', { kind: 'transient', error: new Error('timeout') })
    psp.queue('charge', {
      kind: 'success',
      data: { pspReference: 'pi_test_2', amount: 1500n },
    })

    // Drain twice with backoff=0 so the second drain happens immediately.
    await engine.outbox.drainOnce({ backoff: () => 0, maxAttempts: 5 })
    const stillPending = await engine.connection.sql<
      { attempts: number; failed_at: Date | null }[]
    >`
      select attempts, failed_at from "outbox"
    `
    expect(stillPending[0]?.attempts).toBe(1)
    expect(stillPending[0]?.failed_at).toBeNull()

    await engine.outbox.drainOnce({ backoff: () => 0, maxAttempts: 5 })

    const record = await tenant.transactions.get(txn.record.id)
    expect(record?.state).toBe('funded')
    expect(psp.callCount('charge')).toBe(2)
  })

  it('is idempotent on adapter retry — re-driving the outbox does not re-confirm', async () => {
    if (!engine) return
    const psp = buildPsp()
    engine.adapters.register(psp.adapter)

    const user = { type: 'User', id: 'u-idem' } as const
    const company = { type: 'Company', id: 'co-1' } as const
    await provisionAccounts(engine, user, company)

    const tenant = engine.forTenant(TENANT)
    const txn = await tenant.transactions.create({
      type: 'WalletTopUp',
      by: user,
      participants: { user, company },
      idempotencyKey: 'idem:create',
    })
    await tenant.transactions.transition({
      id: txn.record.id,
      name: 'request',
      by: user,
      data: { amount: 1500n, paymentMethodId: 'pm_x' },
      idempotencyKey: 'idem:request',
    })

    psp.queue('charge', {
      kind: 'success',
      data: { pspReference: 'pi_idem', amount: 1500n },
    })
    await engine.outbox.drainOnce({})

    // The mark_funded transition itself emits `wallet.topup_funded` —
    // an event without an intent. With no consumer handler the
    // dispatcher silently delivers it; what matters is that the
    // adapter is *not* called a second time and the wallet was
    // credited only once.
    await engine.outbox.drainOnce({})
    expect(psp.callCount('charge')).toBe(1)

    expect(await tenant.accounts.balance({ actor: user, name: 'wallet', currency: 'NGN' })).toBe(
      1500n,
    )
  })
})

// =============================================================================
// Inbound — webhook event drives a follow-up transition through the adapter
// =============================================================================

describe('inbound flow — webhook drives mark_funded via adapter mapping', () => {
  it('handleInbound resolves the mapping and runs the transition', async () => {
    if (!engine) return
    const psp = buildPsp()
    engine.adapters.register(psp.adapter)

    const user = { type: 'User', id: 'u-in' } as const
    const company = { type: 'Company', id: 'co-1' } as const
    await provisionAccounts(engine, user, company)

    const tenant = engine.forTenant(TENANT)
    const txn = await tenant.transactions.create({
      type: 'WalletTopUp',
      by: user,
      participants: { user, company },
      idempotencyKey: 'in:create',
    })
    await tenant.transactions.transition({
      id: txn.record.id,
      name: 'request',
      by: user,
      data: { amount: 1500n, paymentMethodId: 'pm_x' },
      idempotencyKey: 'in:request',
    })

    // Real flow: PSP fires a webhook → consumer's HTTP handler →
    // engine.adapters.handleInbound. We synthesize the payload here.
    await engine.adapters.handleInbound(
      'mocked',
      'charge.succeeded',
      {
        eventId: 'evt_in_1',
        txnId: txn.record.id,
        reference: 'pi_inbound',
        amount: '1500',
      },
      { tenantId: TENANT },
    )

    const record = await tenant.transactions.get(txn.record.id)
    expect(record?.state).toBe('funded')
    expect(await tenant.accounts.balance({ actor: user, name: 'wallet', currency: 'NGN' })).toBe(
      1500n,
    )
  })
})
