import type {
  ActorDef,
  ActorRef,
  CreateRecordResult,
  SchemaDef,
  TransactionDef,
  TransitionDef,
  TransitionResult,
  TxnRecord,
  TxnTransition,
} from '@loki/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'

/**
 * Type-level helpers that derive the shape of the typed client from a
 * compiled `SchemaDef`. The runtime is a thin wrapper around
 * `engine.forTenant(...)`; all the inference lives here.
 */

/**
 * `'DeliveryPayment'` → `'deliveryPayment'`. Used to name per-transaction
 * properties on the typed client.
 */
export type Decapitalize<S extends string> = S extends `${infer F}${infer R}`
  ? `${Lowercase<F>}${R}`
  : S

/** Map declared-state set on a transaction → string union. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape on TransactionDef's narrow params
export type StatesOf<TX extends TransactionDef<any, any, any, any>> = TX['states'][number]

/** Map declared transitions → name union. Excludes the synthetic `_init`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export type TransitionNames<TX extends TransactionDef<any, any, any, any>> = Extract<
  keyof TX['transitions'],
  string
>

/**
 * Extract the inferred output of a transition's payload schema.
 *
 * Permissive constraint on the inner TransitionDef params: PostingsFn
 * and InvariantFn are contravariant in TParticipants/TPayload, so the
 * narrow types built by `defineTransaction` need to be assignable here
 * despite being structurally narrower than the broad defaults.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance escape — see comment
export type DataOf<T extends TransitionDef<any, any, any, any>> =
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  T extends TransitionDef<any, any, any, infer P>
    ? P extends StandardSchemaV1
      ? StandardSchemaV1.InferOutput<P>
      : Record<string, never>
    : Record<string, never>

/** Map declared participants → typed ActorRef inputs (`{ type: ActorName, id: string }`). */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export type ParticipantsInput<TX extends TransactionDef<any, any, any, any>> = {
  [K in keyof TX['participants']]: TX['participants'][K] extends ActorDef<infer N>
    ? { readonly type: N; readonly id: string }
    : never
}

// biome-ignore lint/suspicious/noExplicitAny: variance escape
export type CreateInput<TX extends TransactionDef<any, any, any, any>> = {
  readonly by: ActorRef
  readonly idempotencyKey: string
  readonly traceId?: string
} & (keyof TX['participants'] extends never
  ? { readonly participants?: Readonly<Record<string, never>> }
  : { readonly participants: ParticipantsInput<TX> })

export type TransitionInput<
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  TX extends TransactionDef<any, any, any, any>,
  N extends TransitionNames<TX>,
> = {
  readonly by: ActorRef
  readonly idempotencyKey: string
  readonly withKey?: string
  readonly traceId?: string
} & (DataOf<TX['transitions'][N]> extends Record<string, never>
  ? { readonly data?: Record<string, never> }
  : { readonly data: DataOf<TX['transitions'][N]> })

/**
 * Per-transaction surface on the typed client. Mirrors the §11 example:
 *
 *   client.deliveryPayment.create({...})
 *   client.deliveryPayment.transition(id, 'pay', {...})
 *   client.deliveryPayment.get(id)
 *   client.deliveryPayment.trace(id)
 */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export type TransactionClient<TX extends TransactionDef<any, any, any, any>> = {
  /** Provision a new record in the schema-declared initial state. */
  create(input: CreateInput<TX>): Promise<CreateRecordResult>
  /** Drive a typed transition. Payload `data` is narrowed to the transition's schema. */
  transition<N extends TransitionNames<TX>>(
    id: string,
    name: N,
    input: TransitionInput<TX, N>,
  ): Promise<TransitionResult>
  /** Fetch the current record. */
  get(id: string): Promise<TxnRecord | null>
  /** Read the full ordered transition trail for one record. */
  trace(id: string): Promise<readonly TxnTransition[]>
}

/**
 * The typed client itself: one decapitalized property per declared
 * transaction, plus a `tenantId` for diagnostics.
 */
export type TypedClient<S extends SchemaDef> = {
  readonly tenantId: string
} & {
  readonly [TX in S['transactions'][number] as Decapitalize<TX['name']>]: TransactionClient<TX>
}
