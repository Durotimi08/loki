import { defineActor, defineSchema, defineTenant, defineTransaction } from '@loki/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const stubPayload = <T>(): StandardSchemaV1<T, T> => ({
  '~standard': {
    version: 1,
    vendor: 'loki-bench',
    validate: (value: unknown) => ({ value: value as T }),
    types: { input: undefined as unknown as T, output: undefined as unknown as T },
  },
})

/**
 * Minimum-viable schema mirrored from the integration-test fixture.
 * Kept inside `@loki/bench` so the package has no dev-time dep on
 * `@loki/core/test/...` (which isn't published).
 */
export const Org = defineTenant('Org')
export const User = defineActor('User', {
  accounts: { wallet: { currency: 'USD' } },
})
export const Driver = defineActor('Driver', {
  accounts: { balance: { currency: 'USD' } },
})
export const Company = defineActor('Company', {
  accounts: { revenue: { currency: 'USD' } },
})

export const Pay = defineTransaction('Pay', {
  states: ['pending', 'completed', 'refunded'],
  initial: 'pending',
  terminal: ['refunded'],
  participants: { user: User, driver: Driver, company: Company },
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
      emit: 'paid',
    }),
    refund: t({
      from: 'completed',
      to: 'refunded',
      by: [Company],
      needs: 'refund',
      payload: stubPayload<{ reason: string }>(),
      postings: 'invert:pay',
      emit: 'refunded',
    }),
  }),
})

export const benchSchema = defineSchema({
  tenant: Org,
  actors: [User, Driver, Company],
  transactions: [Pay],
})
