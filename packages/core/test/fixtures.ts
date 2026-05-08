import type { StandardSchemaV1 } from '@standard-schema/spec'
import {
  type Engine,
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '../src/index.js'

/**
 * Stand-in for a Standard Schema validator. Real consumers will plug in
 * Zod / Valibot / ArkType. The tests just need a typed stand-in so we
 * exercise the schema DSL without a hard dep on a particular validator.
 */
export const stubPayload = <T>(): StandardSchemaV1<T, T> => ({
  '~standard': {
    version: 1,
    vendor: 'loki-test',
    validate: (value: unknown) => ({ value: value as T }),
    types: {
      input: undefined as unknown as T,
      output: undefined as unknown as T,
    },
  },
})

// =============================================================================
// Reusable Chidori-style fixture (mirrors the §15.1 example).
// =============================================================================

export const Org = defineTenant('Org')

export const User = defineActor('User', {
  accounts: { wallet: { currency: 'NGN' } },
})

export const Driver = defineActor('Driver', {
  accounts: { balance: { currency: 'NGN' } },
})

export const Company = defineActor('Company', {
  accounts: {
    // Revenue + escrow are sharded for hot-path concurrency — sharded
    // accounts can't enforce overdraft (the guard would race), so we
    // explicitly opt them in. Both are credit-accumulating in
    // practice, so the lack of guard is fine.
    revenue: { currency: 'NGN', shards: 16, allowOverdraft: true },
    promo_pool: { currency: 'NGN', allowOverdraft: true },
    escrow: { currency: 'NGN', shards: 8, allowOverdraft: true },
    chargebacks: { currency: 'NGN', allowOverdraft: true },
  },
})

export const System = defineActor('System')

export const DeliveryPayment = defineTransaction('DeliveryPayment', {
  states: ['pending', 'completed', 'failed', 'refunded'],
  initial: 'pending',
  // `completed` is intentionally NOT terminal here — `refund` transitions
  // out of it. The spec's §10 example shows it as terminal but also
  // declares `refund: completed -> refunded`; that's a contradiction the
  // validator catches at schema build time.
  terminal: ['failed', 'refunded'],
  participants: {
    user: User,
    driver: Driver,
    company: Company,
  },
  transitions: (t) => ({
    pay: t({
      from: 'pending',
      to: 'completed',
      by: [User],
      payload: stubPayload<{ amount: bigint; driverShare: bigint; companyShare: bigint }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.user.wallet, amount: data.amount },
        { direction: 'C', account: participants.driver.balance, amount: data.driverShare },
        { direction: 'C', account: participants.company.revenue, amount: data.companyShare },
      ],
      invariant: ({ data }) => data.driverShare + data.companyShare === data.amount,
      unlocks: ['refund'],
      emit: 'delivery.paid',
    }),
    cancel: t({
      from: 'pending',
      to: 'failed',
      by: [User, Company],
      emit: 'delivery.cancelled',
    }),
    refund: t({
      from: 'completed',
      to: 'refunded',
      by: [Company],
      needs: 'refund',
      payload: stubPayload<{ reason: string }>(),
      postings: 'invert:pay',
      emit: 'delivery.refunded',
    }),
  }),
})

export const chidoriSchema = defineSchema({
  tenant: Org,
  actors: [User, Driver, Company, System],
  transactions: [DeliveryPayment],
})

/**
 * Test helper: pre-fund a User wallet via raw SQL.
 *
 * In production code the right pattern is a typed top-up transaction
 * (see `examples/escrow-with-stripe` for the WalletTopUp pattern that
 * keeps the reconciler happy). The chidori fixture deliberately does
 * NOT include a top-up transition because most tests don't care about
 * the funding mechanism — they care about the engine machinery.
 *
 * This helper writes directly to `accounts.balance`, which the
 * engine's overdraft check consults; tests that drive `pay` against
 * an unfunded wallet would otherwise hit `OverdraftError`. The
 * reconciler will report the resulting drift, so tests that *also*
 * exercise the reconciler should either repair the drift
 * (`runOnce({ repairBalanceDrift: true })`) or use a real top-up
 * transition.
 */
export async function topUpWallet(
  engine: Engine,
  tenantId: string,
  userId: string,
  amount: bigint,
): Promise<void> {
  await engine.connection.sql.unsafe(
    `update "accounts" set balance = ${amount.toString()}::numeric
     where tenant_id = '${tenantId}'
       and owner_actor_type = 'User'
       and owner_actor_id = '${userId}'
       and name = 'wallet'`,
  )
}
