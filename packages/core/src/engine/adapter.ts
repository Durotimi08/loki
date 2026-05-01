import type { OutboxEvent } from './outbox.js'
import type { ActorRef } from './types.js'

/**
 * Minimum contract an adapter implements so the engine can dispatch
 * to it. `@loki/adapter-sdk`'s `defineAdapter()` produces a value
 * matching this shape; first-party and third-party adapters depend on
 * the SDK, not on core.
 *
 * Keeping the contract here means `@loki/core` has no runtime
 * dependency on the SDK and the dependency direction is consumer →
 * SDK → core.
 */
export type AdapterContract = {
  readonly _kind: 'adapter'
  readonly name: string
  readonly intents: ReadonlySet<string>
  readonly inboundEvents: ReadonlySet<string>
  matches(event: OutboxEvent): boolean
  runOutbound(event: OutboxEvent, ctx: AdapterOutboundContext): Promise<void>
  runInbound(
    eventName: string,
    payload: unknown,
    ctx: AdapterInboundContext,
  ): Promise<AdapterInboundResult>
}

export type AdapterOutboundContext = {
  readonly outboxId: string
  readonly tenantId: string
  confirm(action: AdapterTransitionAction): Promise<void>
  fail(action: AdapterTransitionAction): Promise<void>
}

export type AdapterTransitionAction = {
  readonly transition: string
  readonly data?: Record<string, unknown>
  readonly by?: ActorRef
  readonly idempotencyKey?: string
  readonly withKey?: string
  readonly traceId?: string
}

export type AdapterInboundContext = {
  readonly tenantId: string
}

export type AdapterInboundResult = {
  readonly transition: string
  readonly txnId: string
  readonly data?: Record<string, unknown>
  readonly by?: ActorRef
  readonly idempotencyKey: string
  readonly withKey?: string
  readonly traceId?: string
}
