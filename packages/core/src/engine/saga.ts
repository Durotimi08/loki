import type { TenantClient } from './client.js'
import { LokiError } from './errors.js'
import type { ActorRef, TransitionResult } from './types.js'

/**
 * Saga helper (§6.5). A saga is a sequence of transitions, possibly
 * across records, where each step's success unlocks the next; failure
 * triggers compensating reversals on the prior steps in reverse order.
 *
 * Loki doesn't invent a coordinator — it just gives you a small
 * sequencer that drives existing transitions and, on failure, fires
 * the registered compensation for each completed step. Every step is
 * still a normal, audited, hash-chained transition; the saga doesn't
 * weaken any invariant.
 */

export type SagaStep<TName extends string = string> = {
  /** Cosmetic — used in error messages. */
  readonly name: TName
  /**
   * Drive the forward transition. Receives any value the previous
   * step returned (so a step can pass a record id or an unlocked key
   * id forward) and the tenant client.
   */
  readonly forward: (ctx: SagaContext<unknown>) => Promise<TransitionResult>
  /**
   * Optional compensating transition, fired when a *later* step fails.
   * Receives the forward result + saga ctx. Compensations run in
   * reverse order; an error inside one fires `onCompensationFailure`
   * (if supplied) but doesn't stop the rest from running.
   */
  readonly compensate?: (
    forwardResult: TransitionResult,
    ctx: SagaContext<unknown>,
  ) => Promise<void>
}

export type SagaContext<TPrev = unknown> = {
  readonly client: TenantClient
  readonly tenantId: string
  readonly previous: TPrev
  /** Default actor for system-driven steps; override per-step in `forward`. */
  readonly by: ActorRef
}

export type SagaOptions = {
  readonly client: TenantClient
  /** Default actor for the saga. Steps are free to drive transitions with a different actor. */
  readonly by: ActorRef
  /**
   * Fired if a compensation step throws. Lets consumers escalate /
   * page; the runner keeps going through the remaining compensations.
   */
  readonly onCompensationFailure?: (e: {
    readonly stepName: string
    readonly error: unknown
  }) => void | Promise<void>
}

export type SagaResult =
  | {
      readonly ok: true
      readonly steps: readonly { readonly name: string; readonly result: TransitionResult }[]
    }
  | {
      readonly ok: false
      readonly failedStep: string
      readonly error: Error
      readonly completedSteps: readonly {
        readonly name: string
        readonly result: TransitionResult
      }[]
      readonly compensated: readonly string[]
    }

/**
 * Run a saga: drive each step's forward in order; on the first
 * failure, fire compensations for every completed step in reverse.
 *
 * @example
 *   const result = await runSaga({ client, by: { type: 'System', id: 'cron' } }, [
 *     {
 *       name: 'reserve',
 *       forward: () => client.transactions.transition({ ... }),
 *       compensate: () => client.transactions.transition({ ...releaseTransition }),
 *     },
 *     {
 *       name: 'capture',
 *       forward: ({ previous }) => client.transactions.transition({ ... }),
 *     },
 *   ])
 */
export async function runSaga(
  options: SagaOptions,
  steps: readonly SagaStep[],
): Promise<SagaResult> {
  if (steps.length === 0) return { ok: true, steps: [] }
  const completed: { name: string; step: SagaStep; result: TransitionResult }[] = []
  let previous: unknown = undefined

  for (const step of steps) {
    const ctx: SagaContext = {
      client: options.client,
      tenantId: options.client.tenantId,
      previous,
      by: options.by,
    }
    try {
      const result = await step.forward(ctx)
      completed.push({ name: step.name, step, result })
      previous = result
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      const compensated: string[] = []
      // Run compensations in reverse — last-completed step first.
      for (let i = completed.length - 1; i >= 0; i--) {
        const entry = completed[i]
        if (!entry || !entry.step.compensate) continue
        try {
          await entry.step.compensate(entry.result, {
            client: options.client,
            tenantId: options.client.tenantId,
            previous,
            by: options.by,
          })
          compensated.push(entry.name)
        } catch (compErr) {
          if (options.onCompensationFailure) {
            await options.onCompensationFailure({
              stepName: entry.name,
              error: compErr,
            })
          }
        }
      }
      return {
        ok: false,
        failedStep: step.name,
        error,
        completedSteps: completed.map((c) => ({ name: c.name, result: c.result })),
        compensated,
      }
    }
  }

  return {
    ok: true,
    steps: completed.map((c) => ({ name: c.name, result: c.result })),
  }
}

/** Type guard. */
export function isSagaSuccess(r: SagaResult): r is Extract<SagaResult, { ok: true }> {
  return r.ok
}

// Re-export so consumers don't have to dig.
export { LokiError }
