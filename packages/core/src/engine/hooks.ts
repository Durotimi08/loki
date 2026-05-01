import type { ActorRef, TxnRecord, TxnTransition } from './types.js'

/**
 * In-process hook framework. See §8 of `project.md`.
 *
 * Filters are either a predicate `(event) => boolean` or a partial
 * object that matches the event's fields literally. Multiple handlers
 * may register against the same hook; they all fire. Errors thrown by
 * `before*` handlers abort the transition. Errors in async hooks are
 * caught and routed to `onHookFailure` so a slow PagerDuty webhook can
 * never starve the engine.
 */

// =============================================================================
// Event payload shapes
// =============================================================================

export type AnomalyCheckName =
  | 'balance_drift'
  | 'unbalanced_postings'
  | 'hash_chain_break'
  | 'checksum_mismatch'
  | 'state_mismatch'
  | 'fabricated_key'

export type AnomalySeverity = 'warn' | 'error' | 'critical'

export type AnomalyEvent = {
  readonly id: string
  readonly tenantId: string
  readonly check: AnomalyCheckName
  readonly severity: AnomalySeverity
  readonly txnId?: string
  readonly txnType?: string
  readonly accountId?: string
  readonly expected: unknown
  readonly observed: unknown
  readonly detectedAt: Date
  readonly context?: Record<string, unknown>
}

export type BeforeTransitionEvent = {
  readonly tenantId: string
  readonly record: TxnRecord
  readonly txnType: string
  readonly transitionName: string
  readonly actor: ActorRef
  readonly data: Record<string, unknown>
  readonly idempotencyKey: string
  readonly traceId?: string
}

export type AfterTransitionEvent = {
  readonly tenantId: string
  readonly record: TxnRecord
  readonly transition: TxnTransition
  readonly txnType: string
  readonly transitionName: string
  readonly unlocked: Readonly<Record<string, string>>
}

export type QuarantineEvent = {
  readonly tenantId: string
  readonly recordId: string
  readonly txnType: string
  readonly reason: AnomalyEvent
}

export type OutboxFailureTerminalEvent = {
  readonly tenantId: string
  readonly outboxId: string
  readonly txnId: string
  readonly transitionId: string
  readonly event: string
  readonly intent: string | null
  readonly attempts: number
  readonly lastError: string | null
}

export type HookFailureEvent = {
  readonly hookName: string
  readonly originalEvent: unknown
  readonly error: unknown
}

// =============================================================================
// Filter primitives
// =============================================================================

/**
 * `Filter<E>` is either a predicate or a partial-object pattern. The
 * partial form matches each declared field literally (or against any of
 * a list, when the value is an array).
 */
export type Filter<E> =
  | ((event: E) => boolean | Promise<boolean>)
  | { readonly [K in keyof E]?: E[K] | readonly E[K][] }

export async function matches<E>(event: E, filter: Filter<E> | undefined): Promise<boolean> {
  if (filter === undefined) return true
  if (typeof filter === 'function') return Boolean(await filter(event))
  for (const key of Object.keys(filter) as (keyof E)[]) {
    const expected = filter[key]
    if (expected === undefined) continue
    const actual = event[key]
    if (Array.isArray(expected)) {
      if (!(expected as unknown[]).includes(actual)) return false
    } else if (actual !== expected) {
      return false
    }
  }
  return true
}

// =============================================================================
// Registry
// =============================================================================

export type Handler<E> = (event: E) => void | Promise<void>
export type Unsubscribe = () => void

type Registration<E> = {
  readonly id: number
  readonly filter: Filter<E> | undefined
  readonly handler: Handler<E>
}

export type HookRegistry = {
  /**
   * Pre-commit hook. Throwing aborts the transition; `RejectTransition`
   * is the canonical way to signal a clean rejection. All registered
   * `beforeTransition` handlers fire in order before the engine commits.
   */
  beforeTransition(
    filter: Filter<BeforeTransitionEvent> | undefined,
    handler: Handler<BeforeTransitionEvent>,
  ): Unsubscribe
  /**
   * Post-commit hook. Fires once the transition has been written.
   * Errors are isolated and routed to `onHookFailure`.
   */
  afterTransition(
    filter: Filter<AfterTransitionEvent> | undefined,
    handler: Handler<AfterTransitionEvent>,
  ): Unsubscribe
  /** Reconciler-emitted anomaly. Errors are isolated. */
  onAnomaly(filter: Filter<AnomalyEvent> | undefined, handler: Handler<AnomalyEvent>): Unsubscribe
  /** Record marked `compromised`. Fires once, after the quarantine UPDATE commits. */
  onQuarantine(
    filter: Filter<QuarantineEvent> | undefined,
    handler: Handler<QuarantineEvent>,
  ): Unsubscribe
  /** Outbox event exhausted its retry budget. */
  onOutboxFailureTerminal(
    filter: Filter<OutboxFailureTerminalEvent> | undefined,
    handler: Handler<OutboxFailureTerminalEvent>,
  ): Unsubscribe
  /** Catches errors thrown from any other hook handler. */
  onHookFailure(handler: Handler<HookFailureEvent>): Unsubscribe

  /** Internals — used by the engine to fire hooks. Not application API. */
  readonly internals: HookInternals
}

export type HookInternals = {
  fireBeforeTransition(event: BeforeTransitionEvent): Promise<void>
  fireAfterTransition(event: AfterTransitionEvent): Promise<void>
  fireAnomaly(event: AnomalyEvent): Promise<void>
  fireQuarantine(event: QuarantineEvent): Promise<void>
  fireOutboxFailureTerminal(event: OutboxFailureTerminalEvent): Promise<void>
  /** Number of registered handlers per hook (test inspection). */
  readonly counts: () => Readonly<Record<string, number>>
}

export function createHookRegistry(): HookRegistry {
  let nextId = 1

  const before: Registration<BeforeTransitionEvent>[] = []
  const after: Registration<AfterTransitionEvent>[] = []
  const anomaly: Registration<AnomalyEvent>[] = []
  const quarantine: Registration<QuarantineEvent>[] = []
  const outboxTerminal: Registration<OutboxFailureTerminalEvent>[] = []
  const failure: Handler<HookFailureEvent>[] = []

  function add<E>(
    list: Registration<E>[],
    filter: Filter<E> | undefined,
    handler: Handler<E>,
  ): Unsubscribe {
    const id = nextId++
    list.push({ id, filter, handler })
    return () => {
      const idx = list.findIndex((r) => r.id === id)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  async function reportFailure(
    hookName: string,
    originalEvent: unknown,
    error: unknown,
  ): Promise<void> {
    const ev: HookFailureEvent = { hookName, originalEvent, error }
    for (const h of failure) {
      try {
        await h(ev)
      } catch {
        // Swallow — onHookFailure handlers must be terminal. Re-firing
        // onHookFailure recursively would loop forever.
      }
    }
  }

  async function fireFireAndForget<E>(
    hookName: string,
    list: readonly Registration<E>[],
    event: E,
  ): Promise<void> {
    // Run handlers concurrently. Errors in any one are isolated and
    // reported through onHookFailure; they never bubble to the engine.
    await Promise.all(
      list.map(async (reg) => {
        try {
          if (await matches(event, reg.filter)) {
            await reg.handler(event)
          }
        } catch (e) {
          await reportFailure(hookName, event, e)
        }
      }),
    )
  }

  return {
    beforeTransition(filter, handler) {
      return add(before, filter, handler)
    },
    afterTransition(filter, handler) {
      return add(after, filter, handler)
    },
    onAnomaly(filter, handler) {
      return add(anomaly, filter, handler)
    },
    onQuarantine(filter, handler) {
      return add(quarantine, filter, handler)
    },
    onOutboxFailureTerminal(filter, handler) {
      return add(outboxTerminal, filter, handler)
    },
    onHookFailure(handler) {
      failure.push(handler)
      return () => {
        const idx = failure.indexOf(handler)
        if (idx >= 0) failure.splice(idx, 1)
      }
    },

    internals: {
      async fireBeforeTransition(event) {
        // Sequential — order matters and a throw aborts. Errors are
        // NOT routed to onHookFailure because they're load-bearing
        // (the abort signal).
        for (const reg of before) {
          if (await matches(event, reg.filter)) {
            await reg.handler(event)
          }
        }
      },
      async fireAfterTransition(event) {
        await fireFireAndForget('afterTransition', after, event)
      },
      async fireAnomaly(event) {
        await fireFireAndForget('onAnomaly', anomaly, event)
      },
      async fireQuarantine(event) {
        await fireFireAndForget('onQuarantine', quarantine, event)
      },
      async fireOutboxFailureTerminal(event) {
        await fireFireAndForget('onOutboxFailureTerminal', outboxTerminal, event)
      },
      counts() {
        return {
          beforeTransition: before.length,
          afterTransition: after.length,
          onAnomaly: anomaly.length,
          onQuarantine: quarantine.length,
          onOutboxFailureTerminal: outboxTerminal.length,
          onHookFailure: failure.length,
        }
      },
    },
  }
}
