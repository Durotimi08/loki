import { describe, expectTypeOf, it } from 'vitest'
import {
  type AccountInstanceRef,
  type ActorDef,
  type ParticipantHandle,
  type ResolvedParticipants,
  type TransactionDef,
  type TransitionContext,
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '../src/index.js'

const Org = defineTenant('Org')
const User = defineActor('User', {
  accounts: {
    wallet: { currency: 'NGN' },
    savings: { currency: 'NGN' },
  },
})
const Driver = defineActor('Driver', {
  accounts: { balance: { currency: 'NGN' } },
})
const Company = defineActor('Company', {
  accounts: {
    revenue: { currency: 'NGN', shards: 16 },
    promo_pool: { currency: 'NGN' },
  },
})

describe('defineActor types', () => {
  it('preserves the literal actor name on the type', () => {
    expectTypeOf(User).toMatchTypeOf<ActorDef<'User'>>()
    expectTypeOf(Driver).toMatchTypeOf<ActorDef<'Driver'>>()
  })

  it('exposes account names in the static accounts map', () => {
    expectTypeOf(User.accounts).toHaveProperty('wallet')
    expectTypeOf(User.accounts).toHaveProperty('savings')
    expectTypeOf(Driver.accounts).toHaveProperty('balance')
    // @ts-expect-error - User has no `balance` account
    User.accounts.balance
  })
})

describe('ParticipantHandle types', () => {
  it('maps each participant to its account instance refs', () => {
    type Handle = ParticipantHandle<typeof Driver>
    expectTypeOf<Handle['id']>().toEqualTypeOf<string>()
    expectTypeOf<Handle['balance']>().toEqualTypeOf<AccountInstanceRef>()
  })

  it('rejects access to undeclared accounts', () => {
    type Handle = ParticipantHandle<typeof User>
    expectTypeOf<Handle>().toHaveProperty('wallet')
    expectTypeOf<Handle>().toHaveProperty('savings')
    // @ts-expect-error — `balance` is not on the User actor
    type _BadAccess = Handle['balance']
  })
})

describe('defineTransaction state inference', () => {
  it('narrows transition.from / transition.to to declared states', () => {
    defineTransaction('T', {
      states: ['a', 'b', 'c'],
      initial: 'a',
      participants: {},
      transitions: {
        go: {
          from: 'a',
          to: 'b',
          by: [],
        },
        back: {
          from: 'b',
          to: 'a',
          by: [],
        },
      },
    })
  })

  it('rejects transitions that reference an undeclared state', () => {
    defineTransaction('T', {
      states: ['a', 'b'],
      initial: 'a',
      participants: {},
      transitions: {
        // @ts-expect-error - 'c' is not in declared states
        bad: { from: 'a', to: 'c', by: [] },
      },
    })
  })

  it('rejects an initial state that is not in states', () => {
    defineTransaction('T', {
      states: ['a', 'b'],
      // @ts-expect-error - 'z' is not a declared state
      initial: 'z',
      participants: {},
      transitions: {},
    })
  })
})

describe('TransitionContext types — postings function', () => {
  it('infers data type from payload Standard Schema', () => {
    const txn = defineTransaction('T', {
      states: ['a', 'b'],
      initial: 'a',
      participants: { driver: Driver, company: Company },
      transitions: {
        go: {
          from: 'a',
          to: 'b',
          by: [],
          postings: ({ participants }) => {
            // participants is fully typed
            expectTypeOf(participants.driver.balance).toEqualTypeOf<AccountInstanceRef>()
            expectTypeOf(participants.company.revenue).toEqualTypeOf<AccountInstanceRef>()
            return [
              { direction: 'D', account: participants.driver.balance, amount: 100n },
              { direction: 'C', account: participants.company.revenue, amount: 100n },
            ]
          },
        },
      },
    })

    expectTypeOf(txn).toMatchTypeOf<TransactionDef>()
  })
})

describe('ResolvedParticipants', () => {
  it('reflects every declared participant', () => {
    type P = ResolvedParticipants<{ user: typeof User; driver: typeof Driver }>
    expectTypeOf<P['user']>().toMatchTypeOf<ParticipantHandle<typeof User>>()
    expectTypeOf<P['driver']>().toMatchTypeOf<ParticipantHandle<typeof Driver>>()
  })
})

describe('TransitionContext shape', () => {
  it('includes payload data plus tenant/trace plumbing', () => {
    type Ctx = TransitionContext<{ user: typeof User }, { amount: bigint }>
    expectTypeOf<Ctx['data']>().toEqualTypeOf<{ amount: bigint }>()
    expectTypeOf<Ctx['tenantId']>().toEqualTypeOf<string>()
    expectTypeOf<Ctx['traceId']>().toEqualTypeOf<string>()
    expectTypeOf<Ctx['transitionId']>().toEqualTypeOf<string>()
    expectTypeOf<Ctx['occurredAt']>().toEqualTypeOf<Date>()
  })
})

describe('defineSchema — composition', () => {
  it('returns a typed SchemaDef with literal names preserved', () => {
    const Order = defineTransaction('Order', {
      states: ['placed', 'shipped'],
      initial: 'placed',
      terminal: ['shipped'],
      participants: { user: User },
      transitions: {
        ship: { from: 'placed', to: 'shipped', by: [] },
      },
    })
    const schema = defineSchema({
      tenant: Org,
      actors: [User, Driver, Company],
      transactions: [Order],
    })
    expectTypeOf(schema.tenant.name).toEqualTypeOf<'Org'>()
  })
})
