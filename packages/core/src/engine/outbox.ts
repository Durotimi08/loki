import { type PayloadCrypto, decryptPayload } from '../primitives/payload-crypto.js'
import type { Connection, SqlTransaction } from './connection.js'
import type { HookRegistry, OutboxFailureTerminalEvent } from './hooks.js'
import type { EngineInstruments } from './observability.js'
import { buildInstruments } from './observability.js'

/**
 * Outbox worker (§6.4). Claims a batch with `FOR UPDATE SKIP LOCKED`
 * inside the worker's tenant tx so multiple workers can drain
 * concurrently without coordinating. On success, marks delivered;
 * on failure, increments `attempts`, schedules a retry with
 * exponential-backoff-and-jitter, and on the final failure marks
 * `failed_at` and fires `onOutboxFailureTerminal`.
 *
 * The worker takes a `dispatch(event)` function and not a single
 * `handler` so the engine can intercept events whose `intent` matches
 * a registered adapter (the adapter calls `confirm`/`fail` which drive
 * a follow-up transition); only events with no matching adapter fall
 * through to the consumer-supplied handler.
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
  /**
   * Fallback handler — invoked for every event that doesn't get routed
   * to a registered adapter. If the engine has no adapters, every
   * event hits this handler.
   */
  readonly handler?: OutboxHandler
  readonly batchSize?: number
  readonly maxAttempts?: number
  /**
   * Delay (ms) before the next attempt, given the next attempt count
   * (1 = first retry). Default: capped exponential with jitter.
   */
  readonly backoff?: (nextAttempt: number) => number
  readonly intervalMs?: number
  readonly onError?: (e: unknown) => void
  /**
   * Lease TTL (ms) for an in-flight claim. Phase 1 atomically bumps
   * `next_attempt_at` forward by this much so peers skip in-flight
   * rows; if the dispatching worker crashes between commit and the
   * post-dispatch update, the row becomes re-claimable after the TTL
   * expires. Default 300_000 (5 minutes) — should comfortably exceed
   * worst-case PSP latency.
   */
  readonly claimTtlMs?: number
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

/**
 * `dispatch` is what the worker calls per claimed event. The engine
 * wires this to a function that consults its adapter list first; only
 * events whose `intent` no adapter handles fall through to the
 * consumer-supplied `handler`.
 */
export type OutboxDispatch = (event: OutboxEvent) => Promise<void>

export type OutboxOps = {
  /** Spawn a worker that drains the outbox on an interval. */
  startWorker(options?: OutboxWorkerOptions): OutboxWorkerHandle
  /**
   * Drain a single batch immediately. Returns the number of events
   * processed.
   */
  drainOnce(options?: OutboxWorkerOptions): Promise<number>
}

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_INTERVAL_MS = 1_000
const DEFAULT_CLAIM_TTL_MS = 300_000 // 5 minutes

/**
 * Default backoff: capped exponential with full jitter. attempt 1 → ~1s,
 * 2 → ~2s, 3 → ~4s, 4 → ~8s, 5 → ~16s, capped at 60s.
 */
const defaultBackoff = (nextAttempt: number): number => {
  const base = Math.min(60_000, 2 ** (nextAttempt - 1) * 1_000)
  return Math.floor(Math.random() * base)
}

export type BuildOutboxOptions = {
  readonly connection: Connection
  readonly hooks: HookRegistry
  /**
   * Constructs the dispatch function on every worker start so the
   * engine can capture the adapter list at startup time.
   */
  readonly buildDispatch: (handler: OutboxHandler | undefined) => OutboxDispatch
  /**
   * Optional payload-crypto hook (M6). When set, every outbox row's
   * `payload` envelope is decrypted before the consumer's
   * `dispatch(event)` sees it — handlers always receive plaintext.
   */
  readonly payloadCrypto?: PayloadCrypto
  /** Observability instruments (Batch H). Defaults to no-op shims. */
  readonly instruments?: EngineInstruments
}

export function buildOutboxOps(opts: BuildOutboxOptions): OutboxOps {
  const { connection, hooks, buildDispatch, payloadCrypto } = opts
  const instruments = opts.instruments ?? buildInstruments()
  return {
    startWorker(options = {}) {
      let stopped = false
      let inFlight: Promise<unknown> = Promise.resolve()
      const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS
      const dispatch = buildDispatch(options.handler)

      const tick = async (): Promise<void> => {
        if (stopped) return
        try {
          inFlight = drainBatch(connection, hooks, dispatch, options, payloadCrypto, instruments)
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
          return drainBatch(connection, hooks, dispatch, options, payloadCrypto, instruments)
        },
      }
    },

    async drainOnce(options = {}) {
      const dispatch = buildDispatch(options.handler)
      return drainBatch(connection, hooks, dispatch, options, payloadCrypto, instruments)
    },
  }
}

async function drainBatch(
  connection: Connection,
  hooks: HookRegistry,
  dispatch: OutboxDispatch,
  options: Pick<OutboxWorkerOptions, 'batchSize' | 'maxAttempts' | 'backoff' | 'claimTtlMs'>,
  payloadCrypto: PayloadCrypto | undefined,
  instruments: EngineInstruments,
): Promise<number> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const backoff = options.backoff ?? defaultBackoff
  const claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS

  // Phase 1: atomically claim AND lease. The CTE picks rows under
  // FOR UPDATE SKIP LOCKED; the outer UPDATE bumps `next_attempt_at`
  // forward by `claimTtlMs` and commits. After this commit:
  //   - Peer workers see `next_attempt_at > now()` and skip the row.
  //   - If THIS worker crashes before recording the result, the row
  //     becomes re-claimable after the TTL expires.
  // Without the lease bump, a crashed worker that already triggered
  // a PSP call would let a peer re-claim and double-deliver — see
  // §6.4 + project-md note about consumer-supplied generic handlers.
  const claimed = await connection.asAdmin(async (tx) => {
    const rows = await tx<Record<string, unknown>[]>`
      with claimed as (
        select id from "outbox"
        where delivered_at is null and failed_at is null
          and next_attempt_at <= now()
        order by id
        for update skip locked
        limit ${batchSize}
      )
      update "outbox"
      set next_attempt_at = now() + (interval '1 millisecond' * ${claimTtlMs})
      from claimed
      where "outbox".id = claimed.id
      returning "outbox".*
    `
    const mapped = rows.map(mapEvent)
    if (!payloadCrypto) return mapped
    const out: OutboxEvent[] = []
    for (const ev of mapped) {
      const decrypted = await decryptPayload(payloadCrypto, ev.payload)
      out.push({ ...ev, payload: (decrypted as Record<string, unknown>) ?? {} })
    }
    return out
  })

  // Phase 2: dispatch each event, then a third phase records success / failure.
  for (const ev of claimed) {
    try {
      await dispatch(ev)
      await connection.asAdmin(async (tx) => {
        await tx`
          update "outbox"
          set delivered_at = now(), last_error = null
          where id = ${ev.id}
        `
      })
      instruments.outboxSuccess.inc(1, { event: ev.event ?? 'unknown' })
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
      instruments.outboxFailure.inc(1, {
        event: ev.event ?? 'unknown',
        terminal: terminal ? 'true' : 'false',
      })
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
