import type { StandardSchemaV1 } from '@standard-schema/spec'
import { defineActor, defineSchema, defineTenant, defineTransaction } from '../src/index.js'

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
    revenue: { currency: 'NGN', shards: 16 },
    promo_pool: { currency: 'NGN' },
    escrow: { currency: 'NGN', shards: 8 },
    chargebacks: { currency: 'NGN' },
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
