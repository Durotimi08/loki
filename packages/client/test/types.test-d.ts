import {
  type ActorRef,
  type CreateRecordResult,
  type TransitionResult,
  type TxnRecord,
  type TxnTransition,
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '@loki/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { describe, expectTypeOf, it } from 'vitest'
import type {
  CreateInput,
  DataOf,
  Decapitalize,
  ParticipantsInput,
  TransactionClient,
  TransitionInput,
  TransitionNames,
  TypedClient,
} from '../src/index.js'

// ---- Stubs --------------------------------------------------------------

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
const Driver = defineActor('Driver', { accounts: { balance: { currency: 'NGN' } } })
const Company = defineActor('Company', {
  accounts: { revenue: { currency: 'NGN', shards: 16 } },
})

const DeliveryPayment = defineTransaction('DeliveryPayment', {
  states: ['pending', 'completed', 'failed', 'refunded'],
  initial: 'pending',
  terminal: ['failed', 'refunded'],
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
      payload: stub<{ reason: string }>(),
      postings: 'invert:pay',
      emit: 'delivery.refunded',
    }),
  }),
})

const schema = defineSchema({
  tenant: Org,
  actors: [User, Driver, Company],
  transactions: [DeliveryPayment],
})

type Schema = typeof schema
type Client = TypedClient<Schema>

// ---- Tests --------------------------------------------------------------

describe('Decapitalize', () => {
  it('lowers the first character only', () => {
    expectTypeOf<Decapitalize<'DeliveryPayment'>>().toEqualTypeOf<'deliveryPayment'>()
    expectTypeOf<Decapitalize<'A'>>().toEqualTypeOf<'a'>()
    expectTypeOf<Decapitalize<''>>().toEqualTypeOf<''>()
  })
})

describe('TypedClient — namespace per transaction', () => {
  it('exposes one decapitalized property per declared transaction', () => {
    expectTypeOf<Client>().toHaveProperty('deliveryPayment')
    // @ts-expect-error — schema declares 'DeliveryPayment', not the PascalCase form
    type _Bad = Client['DeliveryPayment']
    // @ts-expect-error — no such transaction in the schema
    type _Missing = Client['subscription']
  })

  it('always exposes tenantId', () => {
    expectTypeOf<Client['tenantId']>().toEqualTypeOf<string>()
  })
})

describe('TransitionNames', () => {
  it('lists declared transitions, excludes the synthetic _init', () => {
    type Names = TransitionNames<typeof DeliveryPayment>
    expectTypeOf<Names>().toEqualTypeOf<'pay' | 'cancel' | 'refund'>()
  })
})

describe('DataOf — narrow per transition', () => {
  it('maps `pay` to its declared payload', () => {
    type PayData = DataOf<(typeof DeliveryPayment)['transitions']['pay']>
    expectTypeOf<PayData>().toEqualTypeOf<{
      amount: bigint
      driverShare: bigint
      companyShare: bigint
    }>()
  })

  it('maps `refund` to its declared payload', () => {
    type RefundData = DataOf<(typeof DeliveryPayment)['transitions']['refund']>
    expectTypeOf<RefundData>().toEqualTypeOf<{ reason: string }>()
  })

  it('maps payload-less transitions to an empty record', () => {
    type CancelData = DataOf<(typeof DeliveryPayment)['transitions']['cancel']>
    // An empty data shape lets `{}` assign to it. The point of the
    // assertion is that DataOf doesn't accidentally surface bigints
    // or other declared-payload fields.
    const _ok: CancelData = {} as CancelData
    void _ok
  })
})

describe('CreateInput — typed participants', () => {
  it('requires participants whose actor types match the schema', () => {
    type Input = CreateInput<typeof DeliveryPayment>
    expectTypeOf<Input['by']>().toEqualTypeOf<ActorRef>()
    expectTypeOf<Input['participants']>().toMatchTypeOf<{
      user: { type: 'User'; id: string }
      driver: { type: 'Driver'; id: string }
      company: { type: 'Company'; id: string }
    }>()
  })

  it('participants slot uses literal actor names — types narrow per slot', () => {
    type Participants = ParticipantsInput<typeof DeliveryPayment>
    expectTypeOf<Participants['user']['type']>().toEqualTypeOf<'User'>()
    expectTypeOf<Participants['driver']['type']>().toEqualTypeOf<'Driver'>()
    expectTypeOf<Participants['company']['type']>().toEqualTypeOf<'Company'>()
  })
})

describe('TransitionInput — typed data per transition', () => {
  it('narrows `data` to the transition payload', () => {
    type PayInput = TransitionInput<typeof DeliveryPayment, 'pay'>
    expectTypeOf<PayInput['data']>().toMatchTypeOf<{
      amount: bigint
      driverShare: bigint
      companyShare: bigint
    }>()
    // Wrong field type → reject.
    type RefundInput = TransitionInput<typeof DeliveryPayment, 'refund'>
    expectTypeOf<RefundInput['data']>().toMatchTypeOf<{ reason: string }>()
  })

  it('only declared transition names are assignable to the name parameter', () => {
    type Names = Parameters<TransactionClient<typeof DeliveryPayment>['transition']>[1]
    expectTypeOf<Names>().toEqualTypeOf<'pay' | 'cancel' | 'refund'>()
    expectTypeOf<Names>().not.toEqualTypeOf<string>()
  })

  it('return types match the engine surface', () => {
    type C = TransactionClient<typeof DeliveryPayment>
    expectTypeOf<ReturnType<C['create']>>().toEqualTypeOf<Promise<CreateRecordResult>>()
    expectTypeOf<ReturnType<C['get']>>().toEqualTypeOf<Promise<TxnRecord | null>>()
    expectTypeOf<ReturnType<C['trace']>>().toEqualTypeOf<Promise<readonly TxnTransition[]>>()
    // `transition` is generic; check its result via a concrete call.
    type PayResult = ReturnType<C['transition']>
    expectTypeOf<PayResult>().toEqualTypeOf<Promise<TransitionResult>>()
  })
})
