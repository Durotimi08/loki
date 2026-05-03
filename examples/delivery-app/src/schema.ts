import { defineActor, defineSchema, defineTenant, defineTransaction } from '@loki/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'

/**
 * Stand-in for a Standard Schema validator (zod / valibot / arktype).
 * Real apps plug in the real thing — this keeps the example zero-dep.
 */
const stub = <T>(): StandardSchemaV1<T, T> => ({
  '~standard': {
    version: 1,
    vendor: 'loki-example',
    validate: (value: unknown) => ({ value: value as T }),
    types: { input: undefined as unknown as T, output: undefined as unknown as T },
  },
})

export const Org = defineTenant('Org')

export const User = defineActor('User', {
  accounts: { wallet: { currency: 'NGN' } },
})

export const Driver = defineActor('Driver', {
  accounts: { balance: { currency: 'NGN' } },
})

export const Company = defineActor('Company', {
  accounts: {
    revenue: { currency: 'NGN', shards: 16 }, // hot-account sharding
  },
})

/**
 * One transaction type — `DeliveryPayment`. Two transitions:
 *
 *   - `pay`    — debits the user's wallet, credits the driver and the
 *                company. Mints a `refund` capability key.
 *   - `refund` — consumes the `refund` key and reverses the postings.
 */
export const DeliveryPayment = defineTransaction('DeliveryPayment', {
  states: ['pending', 'completed', 'refunded'],
  initial: 'pending',
  terminal: ['refunded'],
  participants: { user: User, driver: Driver, company: Company },
  transitions: (t) => ({
    pay: t({
      from: 'pending',
      to: 'completed',
      by: [User],
      payload: stub<{ amount: bigint; driverShare: bigint; companyShare: bigint }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.user.wallet, amount: data.amount },
        { direction: 'C', account: participants.driver.balance, amount: data.driverShare },
        { direction: 'C', account: participants.company.revenue, amount: data.companyShare },
      ],
      invariant: ({ data }) => data.driverShare + data.companyShare === data.amount,
      unlocks: ['refund'],
      emit: 'delivery.paid',
    }),
    refund: t({
      from: 'completed',
      to: 'refunded',
      by: [Company],
      needs: 'refund',
      payload: stub<{ reason: string }>(),
      postings: 'invert:pay',
      emit: 'delivery.refunded',
    }),
  }),
})

export const schema = defineSchema({
  tenant: Org,
  actors: [User, Driver, Company],
  transactions: [DeliveryPayment],
})
