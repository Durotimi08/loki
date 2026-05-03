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
  /** M16, Batch D — pinned rate on a transition no longer matches the FX table within tolerance. */
  | 'fx_rate_drift'

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
  /**
   * Aborted when the configured `beforeTransitionTimeoutMs` expires.
   * Cooperative handlers (`fetch(..., { signal })`, `AbortSignal`-aware
   * libs) get true cancellation. Synchronous CPU-bound code obviously
   * keeps running until it yields — the engine's race on the same
   * timer ensures the transition tx aborts regardless. M4.
   */
  readonly signal?: AbortSignal
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

/**
 * Subset of `AnomalyEvent` whose `severity === 'critical'`. Fires on
 * the same event as `onAnomaly` for the integrity-class checks
 * (hash_chain_break, checksum_mismatch, fabricated_key) so consumers
 * can route paging without writing a `severity === 'critical'` filter.
 */
export type IntegrityViolationEvent = AnomalyEvent

/**
 * Fires when the engine emits a reversal transition — either a
 * user-driven `invert:` transition or an automated `revert_<original>`
 * issued by the self-correction layer.
 */
export type ReversalEvent = {
  readonly tenantId: string
  readonly recordId: string
  readonly txnType: string
  readonly reverseTransitionId: string
  readonly reversedTransitionId: string
  readonly transitionName: string
  /** True when emitted by the reconciler's auto-correction path; false for explicit user reversals. */
  readonly automated: boolean
}

/** Fires after every `reconciler.runOnce()` pass, regardless of result. */
export type ReconciliationCompleteEvent = {
  readonly startedAt: Date
  readonly finishedAt: Date
  readonly anomaliesFound: number
  readonly quarantined: number
  readonly tenantId?: string
  readonly fullSweep: boolean
}

/** Fires after every successful migration apply / rollback. */
export type SchemaMigrationEvent = {
  readonly id: string
  readonly direction: 'up' | 'down'
  readonly checksum: string
  readonly appliedAt: Date
}

/** Fires after every tenant lifecycle change. */
export type TenantLifecycleEvent = {
  readonly tenantId: string
  readonly action: 'created' | 'suspended' | 'activated' | 'deleted' | 'relocated'
  readonly mode?: 'db' | 'schema' | 'row'
  readonly at: Date
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
  /** Critical-severity subset of `onAnomaly`. */
  onIntegrityViolation(
    filter: Filter<IntegrityViolationEvent> | undefined,
    handler: Handler<IntegrityViolationEvent>,
  ): Unsubscribe
  /** Fires when the engine emits a reversal transition. */
  onReversal(
    filter: Filter<ReversalEvent> | undefined,
    handler: Handler<ReversalEvent>,
  ): Unsubscribe
  /** Fires after every `reconciler.runOnce()` pass. */
  onReconciliationComplete(
    filter: Filter<ReconciliationCompleteEvent> | undefined,
    handler: Handler<ReconciliationCompleteEvent>,
  ): Unsubscribe
  /** Fires after every successful migration. */
  onSchemaMigration(
    filter: Filter<SchemaMigrationEvent> | undefined,
    handler: Handler<SchemaMigrationEvent>,
  ): Unsubscribe
  /** Fires after tenant create / suspend / activate / delete / relocate. */
  onTenantLifecycle(
    filter: Filter<TenantLifecycleEvent> | undefined,
    handler: Handler<TenantLifecycleEvent>,
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
  fireIntegrityViolation(event: IntegrityViolationEvent): Promise<void>
  fireReversal(event: ReversalEvent): Promise<void>
  fireReconciliationComplete(event: ReconciliationCompleteEvent): Promise<void>
  fireSchemaMigration(event: SchemaMigrationEvent): Promise<void>
  fireTenantLifecycle(event: TenantLifecycleEvent): Promise<void>
  /** Number of registered handlers per hook (test inspection). */
  readonly counts: () => Readonly<Record<string, number>>
}

export type HookRegistryOptions = {
  /**
   * Timeout in ms for `beforeTransition` handlers. The handler runs
   * inside the transition's DB tx; a runaway handler would hold row
   * locks and starve other writers. When exceeded, the engine throws
   * `BeforeTransitionTimeoutError` which aborts the tx normally.
   *
   * Default: `1000` (one second). Pass `null` to disable.
   */
  readonly beforeTransitionTimeoutMs?: number | null
}

/**
 * Thrown when a `beforeTransition` handler exceeds
 * `HookRegistryOptions.beforeTransitionTimeoutMs`. Aborts the in-flight
 * transition tx — the same path as a hook that throws explicitly.
 */
export class BeforeTransitionTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(
      `beforeTransition hook exceeded ${timeoutMs}ms timeout. The handler runs inside the transition tx; move long work to afterTransition or an outbox handler.`,
    )
    this.name = 'BeforeTransitionTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export function createHookRegistry(options: HookRegistryOptions = {}): HookRegistry {
  const beforeTimeoutMs =
    options.beforeTransitionTimeoutMs === undefined ? 1_000 : options.beforeTransitionTimeoutMs
  let nextId = 1

  const before: Registration<BeforeTransitionEvent>[] = []
  const after: Registration<AfterTransitionEvent>[] = []
  const anomaly: Registration<AnomalyEvent>[] = []
  const quarantine: Registration<QuarantineEvent>[] = []
  const outboxTerminal: Registration<OutboxFailureTerminalEvent>[] = []
  const integrityViolation: Registration<IntegrityViolationEvent>[] = []
  const reversal: Registration<ReversalEvent>[] = []
  const reconciliationComplete: Registration<ReconciliationCompleteEvent>[] = []
  const schemaMigration: Registration<SchemaMigrationEvent>[] = []
  const tenantLifecycle: Registration<TenantLifecycleEvent>[] = []
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
    onIntegrityViolation(filter, handler) {
      return add(integrityViolation, filter, handler)
    },
    onReversal(filter, handler) {
      return add(reversal, filter, handler)
    },
    onReconciliationComplete(filter, handler) {
      return add(reconciliationComplete, filter, handler)
    },
    onSchemaMigration(filter, handler) {
      return add(schemaMigration, filter, handler)
    },
    onTenantLifecycle(filter, handler) {
      return add(tenantLifecycle, filter, handler)
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
        //
        // Each handler races against `beforeTransitionTimeoutMs`. The
        // handler runs inside the transition's DB tx, so a runaway
        // would hold row locks; throwing aborts the tx normally. M4:
        // we also pass an `AbortSignal` so cooperative handlers (fetch,
        // AbortSignal-aware libs) cancel real work, not just the await.
        for (const reg of before) {
          if (!(await matches(event, reg.filter))) continue
          if (beforeTimeoutMs === null || beforeTimeoutMs <= 0) {
            await reg.handler(event)
            continue
          }
          const ac = new AbortController()
          let timer: ReturnType<typeof setTimeout> | null = null
          const timeout = new Promise<never>((_, rej) => {
            timer = setTimeout(() => {
              ac.abort()
              rej(new BeforeTransitionTimeoutError(beforeTimeoutMs))
            }, beforeTimeoutMs)
          })
          try {
            const eventWithSignal: BeforeTransitionEvent = {
              ...event,
              signal: ac.signal,
            }
            await Promise.race([Promise.resolve(reg.handler(eventWithSignal)), timeout])
          } finally {
            if (timer) clearTimeout(timer)
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
      async fireIntegrityViolation(event) {
        await fireFireAndForget('onIntegrityViolation', integrityViolation, event)
      },
      async fireReversal(event) {
        await fireFireAndForget('onReversal', reversal, event)
      },
      async fireReconciliationComplete(event) {
        await fireFireAndForget('onReconciliationComplete', reconciliationComplete, event)
      },
      async fireSchemaMigration(event) {
        await fireFireAndForget('onSchemaMigration', schemaMigration, event)
      },
      async fireTenantLifecycle(event) {
        await fireFireAndForget('onTenantLifecycle', tenantLifecycle, event)
      },
      counts() {
        return {
          beforeTransition: before.length,
          afterTransition: after.length,
          onAnomaly: anomaly.length,
          onQuarantine: quarantine.length,
          onOutboxFailureTerminal: outboxTerminal.length,
          onIntegrityViolation: integrityViolation.length,
          onReversal: reversal.length,
          onReconciliationComplete: reconciliationComplete.length,
          onSchemaMigration: schemaMigration.length,
          onTenantLifecycle: tenantLifecycle.length,
          onHookFailure: failure.length,
        }
      },
    },
  }
}
