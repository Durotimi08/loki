import type { Connection, SqlTransaction } from './connection.js'
import type { HookRegistry, OutboxFailureTerminalEvent } from './hooks.js'

/**
 * Outbox worker (§6.4). Claims a batch with `FOR UPDATE SKIP LOCKED`
 * inside the worker's tenant tx so multiple workers can drain
 * concurrently without coordinating. On success, marks delivered;
 * on failure, increments `attempts`, schedules a retry with
 * exponential-backoff-and-jitter, and on the final failure marks
 * `failed_at` and fires `onOutboxFailureTerminal`.
 *
 * Tenancy: workers run as admin so they can drain all tenants. RLS on
 * `outbox` would otherwise stand in the way of a multi-tenant worker.
 */

export type OutboxEvent = {
  readonly id: string
  readonly tenantId: string
  readonly txnId: string
  readonly transitionId: string
  readonly event: string
  readonly intent: string | null
  readonly payload: Record<string, unknown>
  readonly attempts: number
  readonly nextAttemptAt: Date
}

export type OutboxHandler = (event: OutboxEvent) => Promise<void> | void

export type OutboxWorkerOptions = {
  readonly handler: OutboxHandler
  readonly batchSize?: number
  readonly maxAttempts?: number
  /**
   * Delay (ms) before the next attempt, given the next attempt count
   * (1 = first retry). Default: capped exponential with jitter.
   */
  readonly backoff?: (nextAttempt: number) => number
  readonly intervalMs?: number
  readonly onError?: (e: unknown) => void
}

export type OutboxWorkerHandle = {
  /** Stop the worker. Resolves once any in-flight batch finishes. */
  readonly stop: () => Promise<void>
  /**
   * Process one batch synchronously. Returns the number of events
   * processed. Useful for tests that want deterministic timing.
   */
  readonly drainOnce: () => Promise<number>
}

export type OutboxOps = {
  /** Spawn a worker that drains the outbox on an interval. */
  startWorker(options: OutboxWorkerOptions): OutboxWorkerHandle
  /**
   * Drain a single batch immediately and return the number of events
   * processed. Used by tests and one-shot operators.
   */
  drainOnce(options: Omit<OutboxWorkerOptions, 'intervalMs' | 'onError'>): Promise<number>
}

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_INTERVAL_MS = 1_000

/**
 * Default backoff: capped exponential with full jitter. attempt 1 → ~1s,
 * 2 → ~2s, 3 → ~4s, 4 → ~8s, 5 → ~16s, capped at 60s.
 */
const defaultBackoff = (nextAttempt: number): number => {
  const base = Math.min(60_000, 2 ** (nextAttempt - 1) * 1_000)
  return Math.floor(Math.random() * base)
}

export function buildOutboxOps(connection: Connection, hooks: HookRegistry): OutboxOps {
  return {
    startWorker(options) {
      let stopped = false
      let inFlight: Promise<unknown> = Promise.resolve()
      const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS

      const tick = async (): Promise<void> => {
        if (stopped) return
        try {
          inFlight = drainBatch(connection, hooks, options)
          await inFlight
        } catch (e) {
          if (options.onError) options.onError(e)
        } finally {
          if (!stopped) {
            timer = setTimeout(tick, interval)
          }
        }
      }

      let timer: ReturnType<typeof setTimeout> = setTimeout(tick, interval)

      return {
        async stop() {
          stopped = true
          clearTimeout(timer)
          await inFlight
        },
        async drainOnce() {
          return drainBatch(connection, hooks, options)
        },
      }
    },

    async drainOnce(options) {
      return drainBatch(connection, hooks, options)
    },
  }
}

async function drainBatch(
  connection: Connection,
  hooks: HookRegistry,
  options: Pick<OutboxWorkerOptions, 'handler' | 'batchSize' | 'maxAttempts' | 'backoff'>,
): Promise<number> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const backoff = options.backoff ?? defaultBackoff

  // Phase 1: claim a batch under FOR UPDATE SKIP LOCKED. We only hold
  // the row lock while reading; the handler runs *outside* the lock so
  // a slow handler doesn't block other workers from making progress
  // on the next batch.
  const claimed = await connection.asAdmin(async (tx) => {
    const rows = await tx<Record<string, unknown>[]>`
      select * from "outbox"
      where delivered_at is null and failed_at is null
        and next_attempt_at <= now()
      order by id
      for update skip locked
      limit ${batchSize}
    `
    return rows.map(mapEvent)
  })

  // Phase 2: invoke the handler per event, then a third phase records
  // success / failure.
  for (const ev of claimed) {
    try {
      await Promise.resolve(options.handler(ev))
      await connection.asAdmin(async (tx) => {
        await tx`
          update "outbox"
          set delivered_at = now(), last_error = null
          where id = ${ev.id}
        `
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const nextAttempt = ev.attempts + 1
      const terminal = nextAttempt >= maxAttempts

      const updated = await connection.asAdmin(async (tx) => {
        if (terminal) {
          await tx`
            update "outbox"
            set attempts = ${nextAttempt},
                failed_at = now(),
                last_error = ${message}
            where id = ${ev.id}
          `
          return await loadEventById(tx, ev.id)
        }
        const delayMs = Math.max(0, backoff(nextAttempt))
        await tx`
          update "outbox"
          set attempts = ${nextAttempt},
              next_attempt_at = now() + (interval '1 millisecond' * ${delayMs}),
              last_error = ${message}
          where id = ${ev.id}
        `
        return null
      })

      if (terminal && updated) {
        const evt: OutboxFailureTerminalEvent = {
          tenantId: updated.tenantId,
          outboxId: updated.id,
          txnId: updated.txnId,
          transitionId: updated.transitionId,
          event: updated.event,
          intent: updated.intent,
          attempts: updated.attempts,
          lastError: message,
        }
        await hooks.internals.fireOutboxFailureTerminal(evt)
      }
    }
  }

  return claimed.length
}

async function loadEventById(
  tx: SqlTransaction,
  id: string,
): Promise<(OutboxEvent & { attempts: number }) | null> {
  const [row] = await tx<Record<string, unknown>[]>`
    select * from "outbox" where id = ${id}
  `
  return row ? mapEvent(row) : null
}

function mapEvent(row: Record<string, unknown>): OutboxEvent {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    txnId: row['txn_id'] as string,
    transitionId: row['transition_id'] as string,
    event: row['event'] as string,
    intent: (row['intent'] as string | null) ?? null,
    payload: (row['payload'] as Record<string, unknown>) ?? {},
    attempts: row['attempts'] as number,
    nextAttemptAt: row['next_attempt_at'] as Date,
  }
}
