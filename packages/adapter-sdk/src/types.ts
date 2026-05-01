import type { ActorRef, Engine, OutboxEvent } from '@loki/core'

/**
 * Adapter contract — see §9 of `project.md`.
 *
 * An adapter bridges Loki to an external system (PSP, bank, queue).
 * It declares two flows:
 *
 *   - **Outbound:** when the engine emits an outbox row whose `intent`
 *     starts with `<adapter>.`, the adapter's matching handler runs,
 *     calls the external system with a deterministic idempotency key,
 *     and uses `confirm()` / `fail()` to drive a follow-up Loki
 *     transition. The transition is itself recorded, balanced, and
 *     hash-chained — the same audit guarantees as any other write.
 *
 *   - **Inbound:** the adapter exposes a function the consumer wires
 *     to its HTTP webhook endpoint. The adapter validates the payload
 *     (signature verification is the consumer's responsibility before
 *     calling) and maps the event to a Loki transition.
 *
 * The actual external call always happens *after* the engine commits
 * — the outbox is the dual-write firewall (§9.2).
 */

export type OutboundContext = {
  /**
   * Drive a follow-up transition recording the outcome of the external
   * call. Routes through `engine.forTenant(...).transactions.transition`
   * so it inherits idempotency, hash chain, and balance updates.
   */
  confirm(action: TransitionAction): Promise<void>
  /** Same as `confirm` but conventionally used for failure outcomes. */
  fail(action: TransitionAction): Promise<void>
  /** A stable id for the outer outbox row — useful as an idempotency key prefix. */
  readonly outboxId: string
  /** The tenant id the original transition fired in. */
  readonly tenantId: string
}

export type TransitionAction = {
  /** Schema-declared transition name on the same record. */
  readonly transition: string
  /** Optional payload, validated against the schema's payload type. */
  readonly data?: Record<string, unknown>
  /** Actor on whose behalf the follow-up is driven. Defaults to `{ type: 'System', id: '<adapter>' }`. */
  readonly by?: ActorRef
  /**
   * Optional override for the follow-up transition's idempotency key.
   * The default is `<outboxId>:confirm` / `<outboxId>:fail`, which
   * means a worker retry never re-drives a transition that already
   * landed.
   */
  readonly idempotencyKey?: string
  /** Capability key id for `needs:` transitions. */
  readonly withKey?: string
  /** Optional trace id; defaults to the outbox event's trace id. */
  readonly traceId?: string
}

export type OutboundHandler = (event: OutboxEvent, ctx: OutboundContext) => Promise<void> | void

export type InboundContext = {
  readonly engine: Engine
  readonly tenantId: string
}

export type InboundResult = {
  readonly transition: string
  readonly txnId: string
  readonly data?: Record<string, unknown>
  readonly by?: ActorRef
  readonly idempotencyKey: string
  readonly withKey?: string
  readonly traceId?: string
}

export type InboundMapper<TPayload = unknown> = (
  event: TPayload,
) => InboundResult | Promise<InboundResult>

export type AdapterDefinition = {
  /**
   * Stable name. Acts as the prefix for routable intents — declaring
   * `name: 'stripe'` matches outbox rows with `intent` starting
   * `stripe.`.
   */
  readonly name: string
  /** Outbound intent → handler map. Key matches the part *after* `<name>.`. */
  readonly outbound?: Readonly<Record<string, OutboundHandler>>
  /** Inbound webhook event → transition mapper. */
  readonly inbound?: Readonly<Record<string, InboundMapper>>
}

/**
 * The compiled adapter — what `defineAdapter` returns. Carries the
 * declaration plus runtime helpers used by the engine.
 */
export type Adapter = {
  readonly _kind: 'adapter'
  readonly name: string
  /** Set of full intent strings the adapter handles (`['stripe.capture', ...]`). */
  readonly intents: ReadonlySet<string>
  /** Set of inbound event names. */
  readonly inboundEvents: ReadonlySet<string>
  /** Test whether the adapter handles a given outbox row. */
  matches(event: OutboxEvent): boolean
  /** Run the outbound handler for an outbox row this adapter matches. */
  runOutbound(event: OutboxEvent, ctx: OutboundContext): Promise<void>
  /** Resolve and run an inbound webhook event. */
  runInbound(eventName: string, payload: unknown, ctx: InboundContext): Promise<InboundResult>
}
