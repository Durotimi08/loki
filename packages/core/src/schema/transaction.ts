import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
  ActorDef,
  NoneState,
  TransactionDef,
  TransitionDef,
  TransitionInput,
} from './types.js'
import { NONE_STATE } from './types.js'

/**
 * Per-transition factory passed to the `transitions(t)` callback. Each
 * call infers its own `TPayloadSchema` so the `postings` and `invariant`
 * functions see a precisely typed `data` parameter.
 *
 * The factory is purely a typing aid — at runtime it returns its input
 * unchanged.
 */
export type TransitionFactory<
  TStates extends string,
  TParticipants extends Readonly<Record<string, ActorDef>>,
> = <const P extends StandardSchemaV1 | undefined>(
  input: TransitionInput<TStates, TParticipants, P>,
) => TransitionInput<TStates, TParticipants, P>

type TransitionsCallback<
  TStates extends readonly string[],
  TParticipants extends Readonly<Record<string, ActorDef>>,
  TTransitions extends Readonly<
    // biome-ignore lint/suspicious/noExplicitAny: per-transition variance
    Record<string, TransitionInput<TStates[number], TParticipants, any>>
  >,
> = (t: TransitionFactory<TStates[number], TParticipants>) => TTransitions

export type TransactionInputArgs<
  TStates extends readonly string[],
  TParticipants extends Readonly<Record<string, ActorDef>>,
  TTransitions extends Readonly<
    // biome-ignore lint/suspicious/noExplicitAny: per-transition variance
    Record<string, TransitionInput<TStates[number], TParticipants, any>>
  >,
> = {
  readonly states: TStates
  readonly initial: TStates[number]
  readonly terminal?: readonly TStates[number][]
  readonly participants: TParticipants
  readonly transitions: TTransitions | TransitionsCallback<TStates, TParticipants, TTransitions>
}

type BuiltTransitions<
  // biome-ignore lint/suspicious/noExplicitAny: per-transition variance
  TInput extends Readonly<Record<string, TransitionInput<any, any, any>>>,
  TStates extends string,
  TParticipants extends Readonly<Record<string, ActorDef>>,
> = {
  readonly [K in keyof TInput & string]: TInput[K] extends TransitionInput<
    // biome-ignore lint/suspicious/noExplicitAny: position
    any,
    // biome-ignore lint/suspicious/noExplicitAny: position
    any,
    infer P
  >
    ? TransitionDef<K, TStates, TParticipants, P>
    : never
}

/**
 * Identity function used as the runtime body of `TransitionFactory`. The
 * narrowing is purely at the type level.
 */
const transitionFactory: TransitionFactory<string, Readonly<Record<string, ActorDef>>> = (input) =>
  input

/**
 * Declares a transaction type — its lifecycle states, participating
 * actors, and the transitions that move it between states.
 *
 * Pass `transitions` as a callback receiving a typed factory `t`. Each
 * `t({ ... })` call infers its own payload type, so `postings` and
 * `invariant` see a fully-typed `data` parameter:
 *
 * @example
 *   defineTransaction('DeliveryPayment', {
 *     states:   ['pending', 'completed', 'failed', 'refunded'],
 *     initial:  'pending',
 *     terminal: ['completed', 'failed', 'refunded'],
 *     participants: { user: User, driver: Driver, company: Company },
 *     transitions: (t) => ({
 *       pay: t({
 *         from: 'pending',
 *         to:   'completed',
 *         by:   [User],
 *         payload: z.object({ amount: z.bigint(), ... }),
 *         postings: ({ data, participants }) => [
 *           { direction: 'D', account: participants.user.wallet, amount: data.amount },
 *           // ...
 *         ],
 *         unlocks: ['refund'],
 *         emit:    'delivery.paid',
 *       }),
 *     }),
 *   })
 */
export function defineTransaction<
  const TName extends string,
  const TStates extends readonly string[],
  const TParticipants extends Readonly<Record<string, ActorDef>>,
  const TTransitions extends Readonly<
    // biome-ignore lint/suspicious/noExplicitAny: per-transition variance
    Record<string, TransitionInput<TStates[number], TParticipants, any>>
  >,
>(
  name: TName,
  input: TransactionInputArgs<TStates, TParticipants, TTransitions>,
): TransactionDef<
  TName,
  TStates,
  TParticipants,
  BuiltTransitions<TTransitions, TStates[number], TParticipants>
> {
  const rawTransitions =
    typeof input.transitions === 'function'
      ? input.transitions(transitionFactory as TransitionFactory<TStates[number], TParticipants>)
      : input.transitions

  const transitions = {} as Record<string, TransitionDef>
  for (const [transitionName, raw] of Object.entries(rawTransitions)) {
    transitions[transitionName] = buildTransition(
      transitionName,
      // biome-ignore lint/suspicious/noExplicitAny: variance escape on the loop boundary
      raw as TransitionInput<string, Readonly<Record<string, ActorDef>>, any>,
    )
  }

  return {
    _kind: 'transaction',
    name,
    states: input.states,
    initial: input.initial,
    terminal: (input.terminal ?? []) as readonly TStates[number][],
    participants: input.participants,
    transitions: transitions as BuiltTransitions<TTransitions, TStates[number], TParticipants>,
  }
}

function buildTransition(
  name: string,
  raw: TransitionInput<string, Readonly<Record<string, ActorDef>>, StandardSchemaV1 | undefined>,
): TransitionDef {
  const fromArr: readonly (string | NoneState)[] = Array.isArray(raw.from)
    ? (raw.from as readonly (string | NoneState)[])
    : [raw.from as string | NoneState]

  const def: TransitionDef = {
    _kind: 'transition',
    name,
    from: fromArr,
    to: raw.to,
    by: raw.by,
    unlocks: raw.unlocks ?? [],
    ...(raw.payload !== undefined ? { payload: raw.payload } : {}),
    ...(raw.postings !== undefined ? { postings: raw.postings } : {}),
    ...(raw.invariant !== undefined ? { invariant: raw.invariant } : {}),
    ...(raw.needs !== undefined ? { needs: raw.needs } : {}),
    ...(raw.emit !== undefined ? { emit: raw.emit } : {}),
    ...(raw.intent !== undefined ? { intent: raw.intent } : {}),
  }
  return def
}

export { NONE_STATE }
