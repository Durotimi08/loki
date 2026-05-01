import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { CurrencyCode } from '../primitives/currency.js'
import type { AccountInstanceRef, Direction, Posting } from '../primitives/posting.js'

export type SchemaKind = 'tenant' | 'actor' | 'account' | 'transaction' | 'transition' | 'schema'

// =============================================================================
// Tenant
// =============================================================================

export type TenantDef<TName extends string = string> = {
  readonly _kind: 'tenant'
  readonly name: TName
  readonly fields?: StandardSchemaV1
}

// =============================================================================
// Account (schema-level: an account *type* attached to an actor type)
// =============================================================================

export type AccountOptions = {
  readonly currency: CurrencyCode
  /** Number of internal shards for hot-account scaling. Default 1. */
  readonly shards?: number
  /**
   * Path to a parent account on the same actor (`'wallet'` ⇒ child of `wallet`).
   * Used for sub-accounts.
   */
  readonly parent?: string
}

export type AccountDef<TActorName extends string = string, TAccountName extends string = string> = {
  readonly _kind: 'account'
  readonly actorName: TActorName
  readonly name: TAccountName
  readonly currency: CurrencyCode
  readonly shards: number
  readonly parent?: string
}

// =============================================================================
// Actor
// =============================================================================

/**
 * Map of account-name → options as supplied to `defineActor`. Used as
 * the input shape; `defineActor` expands it into a full `AccountDef` map.
 */
export type AccountSpecMap = Readonly<Record<string, AccountOptions>>

export type ActorDef<
  TName extends string = string,
  TAccounts extends Readonly<Record<string, AccountDef<TName>>> = Readonly<
    Record<string, AccountDef<TName>>
  >,
> = {
  readonly _kind: 'actor'
  readonly name: TName
  readonly fields?: StandardSchemaV1
  readonly accounts: TAccounts
}

// =============================================================================
// Transition
// =============================================================================

/**
 * Resolved participant handle passed into `postings`/`invariant`.
 * Carries the actor's id and a typed map of account *instances*
 * — `participants.driver.balance` is a real `AccountInstanceRef` the
 * engine can post against.
 */
export type ParticipantHandle<TActor extends ActorDef> = {
  readonly id: string
} & {
  readonly [K in keyof TActor['accounts']]: AccountInstanceRef
}

export type ResolvedParticipants<TParticipants extends Readonly<Record<string, ActorDef>>> = {
  readonly [K in keyof TParticipants]: ParticipantHandle<TParticipants[K]>
}

export type TransitionContext<
  TParticipants extends Readonly<Record<string, ActorDef>>,
  TPayload,
> = {
  readonly data: TPayload
  readonly participants: ResolvedParticipants<TParticipants>
  readonly tenantId: string
  readonly traceId: string
  /** ULID of the transition row itself. */
  readonly transitionId: string
  /** Wall-clock at the moment the engine acquired the row lock. */
  readonly occurredAt: Date
}

export type PostingDraft = {
  readonly direction: Direction
  readonly account: AccountInstanceRef
  readonly amount: bigint
}

export type PostingsFn<TParticipants extends Readonly<Record<string, ActorDef>>, TPayload> = (
  ctx: TransitionContext<TParticipants, TPayload>,
) => readonly PostingDraft[]

/**
 * Reference to another transition's postings, applied inverted.
 * `'invert:pay'` reuses `pay`'s postings with directions swapped.
 * Multiple targets allowed — `'invert:pay|pay_with_promo'` selects
 * whichever the original record was driven through.
 */
export type PostingsInvertRef = `invert:${string}`

export type PostingsSpec<TParticipants extends Readonly<Record<string, ActorDef>>, TPayload> =
  | PostingsFn<TParticipants, TPayload>
  | PostingsInvertRef

export type InvariantFn<TParticipants extends Readonly<Record<string, ActorDef>>, TPayload> = (
  ctx: TransitionContext<TParticipants, TPayload>,
) => boolean | Promise<boolean>

/**
 * Helper: infer the parsed/validated payload type from a Standard Schema.
 * Falls back to `Record<string, never>` when no payload is declared.
 */
export type InferPayload<S extends StandardSchemaV1 | undefined> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<S>
  : Record<string, never>

/**
 * Sentinel meaning "no current state" — used by the very first
 * transition that creates a record (e.g. `hold: <none> -> held`).
 */
export const NONE_STATE = '__none__' as const
export type NoneState = typeof NONE_STATE

export type TransitionInput<
  TStates extends string,
  TParticipants extends Readonly<Record<string, ActorDef>>,
  TPayloadSchema extends StandardSchemaV1 | undefined,
> = {
  readonly from: TStates | NoneState | readonly (TStates | NoneState)[]
  readonly to: TStates
  readonly by: readonly ActorDef[]
  readonly payload?: TPayloadSchema
  readonly postings?: PostingsSpec<TParticipants, InferPayload<TPayloadSchema>>
  readonly invariant?: InvariantFn<TParticipants, InferPayload<TPayloadSchema>>
  readonly needs?: string
  /**
   * Capability keys minted on success. Strings mint a non-expiring
   * key; the object form sets `ttlMs` so the engine refuses the key
   * after that deadline.
   */
  readonly unlocks?: readonly (string | { readonly name: string; readonly ttlMs: number })[]
  /**
   * Outbox event name — past tense (`delivery.paid`). Drained by
   * webhook / queue fan-out workers.
   */
  readonly emit?: string
  /**
   * Outbox intent — imperative (`stripe.capture`, `mocked.charge`).
   * Format is `<adapter>.<action>`. The outbox worker routes events
   * with an `intent` to the adapter registered for that prefix; the
   * generic `handler` only sees events without intents.
   */
  readonly intent?: string
}

export type TransitionDef<
  TName extends string = string,
  TStates extends string = string,
  TParticipants extends Readonly<Record<string, ActorDef>> = Readonly<Record<string, ActorDef>>,
  TPayloadSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  readonly _kind: 'transition'
  readonly name: TName
  readonly from: readonly (TStates | NoneState)[]
  readonly to: TStates
  readonly by: readonly ActorDef[]
  readonly payload?: TPayloadSchema
  readonly postings?: PostingsSpec<TParticipants, InferPayload<TPayloadSchema>>
  readonly invariant?: InvariantFn<TParticipants, InferPayload<TPayloadSchema>>
  readonly needs?: string
  readonly unlocks: readonly (string | { readonly name: string; readonly ttlMs: number })[]
  readonly emit?: string
  readonly intent?: string
}

// =============================================================================
// Transaction
// =============================================================================

export type TransactionInput<
  TStates extends readonly string[],
  TParticipants extends Readonly<Record<string, ActorDef>>,
> = {
  readonly states: TStates
  readonly initial: TStates[number]
  readonly terminal: readonly TStates[number][]
  readonly participants: TParticipants
  readonly transitions: Readonly<
    Record<string, TransitionInput<TStates[number], TParticipants, StandardSchemaV1 | undefined>>
  >
}

export type TransactionDef<
  TName extends string = string,
  TStates extends readonly string[] = readonly string[],
  TParticipants extends Readonly<Record<string, ActorDef>> = Readonly<Record<string, ActorDef>>,
  // Use permissive bounds on the inner TransitionDef params: PostingsFn is
  // contravariant in TParticipants and InvariantFn is contravariant in
  // TPayload, so the narrow types built by defineTransaction need to be
  // assignable here despite being structurally narrower.
  // biome-ignore lint/suspicious/noExplicitAny: variance escape hatch
  TTransitions extends Readonly<Record<string, TransitionDef<any, any, any, any>>> = Readonly<
    // biome-ignore lint/suspicious/noExplicitAny: variance escape hatch
    Record<string, TransitionDef<any, any, any, any>>
  >,
> = {
  readonly _kind: 'transaction'
  readonly name: TName
  readonly states: TStates
  readonly initial: TStates[number]
  readonly terminal: readonly TStates[number][]
  readonly participants: TParticipants
  readonly transitions: TTransitions
}

// =============================================================================
// Schema
// =============================================================================

export type SchemaInput = {
  readonly tenant: TenantDef
  readonly actors: readonly ActorDef[]
  readonly transactions: readonly TransactionDef[]
}

export type SchemaDef<
  TTenant extends TenantDef = TenantDef,
  TActors extends readonly ActorDef[] = readonly ActorDef[],
  TTransactions extends readonly TransactionDef[] = readonly TransactionDef[],
> = {
  readonly _kind: 'schema'
  readonly tenant: TTenant
  readonly actors: TActors
  readonly transactions: TTransactions
  readonly meta: {
    /** Map of actor name → ActorDef. Built once at `defineSchema`. */
    readonly actorsByName: ReadonlyMap<string, ActorDef>
    /** Map of transaction name → TransactionDef. */
    readonly transactionsByName: ReadonlyMap<string, TransactionDef>
  }
}

// Re-export posting types for convenience
export type { Direction, Posting, AccountInstanceRef }
