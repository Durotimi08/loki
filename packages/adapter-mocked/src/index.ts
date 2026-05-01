import { type Adapter, defineAdapter } from '@loki/adapter-sdk'

/**
 * `@loki/adapter-mocked` — deterministic, in-memory simulation of a
 * PSP. Every test gets a fresh handle via `createMockedPsp()`; the
 * returned `adapter` plugs into `engine.adapters.register(adapter)`.
 *
 * Behaviour is driven by the harness, not by network state:
 *
 *   psp.queue('charge', 'success', { reference: 'pi_test', amount: 1500n })
 *   psp.queue('charge', 'failure', { reason: 'card_declined' })
 *   psp.queue('charge', 'transient', new Error('timeout'))   // retries via outbox backoff
 *
 * Each outbound `mocked.<action>` invocation pops the next queued
 * outcome and dispatches the matching follow-up transition. The harness
 * also exposes `simulateInbound(eventName, payload)` to drive an
 * inbound webhook through the same adapter.
 *
 * The adapter is intentionally minimal: enough to exercise the whole
 * outbound + inbound lifecycle in tests, with no actual HTTP.
 */

export type MockedOutcome =
  /** The next call to `<action>` will succeed. The data goes into the follow-up `mark_funded` transition. */
  | { readonly kind: 'success'; readonly data: Record<string, unknown> }
  /** The next call will fail with a permanent error → `mark_failed` follow-up. */
  | { readonly kind: 'failure'; readonly data: Record<string, unknown> }
  /** The next call will throw (transient — outbox retries via backoff). */
  | { readonly kind: 'transient'; readonly error: Error }

export type MockedPsp = {
  readonly adapter: Adapter
  /** Queue an outcome for the next call to `mocked.<action>`. */
  queue(action: string, outcome: MockedOutcome): void
  /** Number of `mocked.<action>` invocations the adapter has handled. */
  callCount(action: string): number
  /** Reset queues and call counters. */
  reset(): void
  /**
   * Simulate an inbound webhook payload. Returns the mapping the
   * adapter resolved — typically the test then calls
   * `engine.adapters.handleInbound(...)` to drive the transition.
   */
  buildInbound<P extends Record<string, unknown>>(
    eventName: string,
    payload: P,
  ): {
    eventName: string
    payload: P
  }
}

/**
 * Configurable transition names per action. Every harness can rename
 * the follow-up transitions to match its schema; the defaults below
 * line up with the §15.6 wallet top-up example.
 */
export type MockedTransitionMap = Readonly<
  Record<
    string,
    {
      readonly success: string
      readonly failure: string
    }
  >
>

export type CreateMockedPspOptions = {
  /** Action → { success: <transitionName>, failure: <transitionName> } map. */
  readonly transitions: MockedTransitionMap
  /**
   * Optional inbound mappers. Each entry maps a webhook event name to
   * a function returning `{ transition, txnId, data?, idempotencyKey }`.
   */
  readonly inbound?: Readonly<
    Record<
      string,
      (event: Record<string, unknown>) => {
        transition: string
        txnId: string
        data?: Record<string, unknown>
        idempotencyKey: string
      }
    >
  >
  /** Adapter name. Default `'mocked'`. */
  readonly name?: string
}

export function createMockedPsp(options: CreateMockedPspOptions): MockedPsp {
  const queues = new Map<string, MockedOutcome[]>()
  const counts = new Map<string, number>()
  const adapterName = options.name ?? 'mocked'

  const ensureQueue = (action: string): MockedOutcome[] => {
    const existing = queues.get(action)
    if (existing) return existing
    const fresh: MockedOutcome[] = []
    queues.set(action, fresh)
    return fresh
  }

  const outboundForAction = (action: string) => {
    const map = options.transitions[action]
    if (!map) {
      throw new Error(
        `[mocked-psp] No transition map declared for action "${action}". Add it to createMockedPsp({ transitions: { ${action}: { success, failure } } }).`,
      )
    }
    return async (
      _event: import('@loki/core').OutboxEvent,
      ctx: import('@loki/adapter-sdk').OutboundContext,
    ) => {
      counts.set(action, (counts.get(action) ?? 0) + 1)
      const queue = queues.get(action) ?? []
      const next = queue.shift()
      if (!next) {
        throw new Error(
          `[mocked-psp] No outcome queued for action "${action}". Did you forget to call psp.queue("${action}", ...)?`,
        )
      }
      switch (next.kind) {
        case 'success':
          await ctx.confirm({ transition: map.success, data: next.data })
          return
        case 'failure':
          await ctx.fail({ transition: map.failure, data: next.data })
          return
        case 'transient':
          throw next.error
      }
    }
  }

  const adapter = defineAdapter({
    name: adapterName,
    outbound: Object.fromEntries(
      Object.keys(options.transitions).map((action) => [action, outboundForAction(action)]),
    ),
    ...(options.inbound !== undefined
      ? {
          inbound: Object.fromEntries(
            Object.entries(options.inbound).map(([eventName, mapper]) => [
              eventName,
              (payload: unknown) => mapper(payload as Record<string, unknown>),
            ]),
          ),
        }
      : {}),
  })

  return {
    adapter,
    queue(action, outcome) {
      ensureQueue(action).push(outcome)
    },
    callCount(action) {
      return counts.get(action) ?? 0
    },
    reset() {
      queues.clear()
      counts.clear()
    },
    buildInbound(eventName, payload) {
      return { eventName, payload }
    },
  }
}

export const ADAPTER_MOCKED_PACKAGE = '@loki/adapter-mocked'
