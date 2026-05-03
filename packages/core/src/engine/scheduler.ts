import type { Connection } from './connection.js'
import { LokiError } from './errors.js'
import type { HookRegistry } from './hooks.js'
import { jsonifyForStorage } from './records.js'

/**
 * Scheduled-transition runner (§M17). A row in `txn_scheduled` says
 * "fire transition N on record R at time T as actor A". The scheduler
 * polls due rows in batches and drives each one through the engine's
 * normal transition path — same idempotency / RLS / outbox semantics
 * as if the application had called `transactions.transition` itself.
 *
 * Design notes:
 *
 *   - **Built on existing primitives**: the actual state machine still
 *     lives in `txn_transitions`. The scheduler is just a delayed
 *     trigger; it doesn't introduce a parallel state.
 *
 *   - **Idempotent by `idempotency_key`**: a duplicate fire (e.g.
 *     scheduler restart between work claim and commit) hits the
 *     transition's existing idempotency unique index and resolves to
 *     the same outcome.
 *
 *   - **Cancellation**: `cancel(id)` flips the row to `cancelled`. It
 *     refuses to operate on already-fired rows because that would
 *     suggest a misuse — the transition has already happened.
 *
 *   - **Worker safety**: each tick claims due rows with `FOR UPDATE
 *     SKIP LOCKED` so multiple workers can run without coordinating.
 */

export type ScheduledTransitionStatus = 'pending' | 'completed' | 'cancelled' | 'failed'

export type ScheduledTransition = {
  readonly id: string
  readonly tenantId: string
  readonly txnId: string
  readonly name: string
  readonly runAt: Date
  readonly actor: { readonly type: string; readonly id: string }
  readonly payload: Record<string, unknown>
  readonly withKey: string | null
  readonly idempotencyKey: string
  readonly status: ScheduledTransitionStatus
  readonly attempts: number
  readonly lastError: string | null
  readonly firedAt: Date | null
  readonly firedTransitionId: string | null
  readonly createdAt: Date
}

export type CreateScheduledTransitionInput = {
  readonly tenantId: string
  readonly txnId: string
  readonly name: string
  readonly runAt: Date
  readonly by: { readonly type: string; readonly id: string }
  readonly data?: Record<string, unknown>
  /**
   * Capability-key id to consume when the scheduled transition fires.
   * Required when the target transition declares `needs:`. Supplying
   * the id at schedule time pins the firing to a specific key —
   * later mutations to keys (rotation, revocation) will surface as a
   * normal `KeyAlreadyConsumedError` failure on tick.
   */
  readonly withKey?: string
  readonly idempotencyKey: string
}

export type ListScheduledFilter = {
  readonly tenantId?: string
  readonly status?: ScheduledTransitionStatus
  readonly dueBefore?: Date
}

export type RunDueOptions = {
  readonly tenantId?: string
  readonly batchSize?: number
  /**
   * Override the "now" comparison. Useful for tests that want to
   * fast-forward without touching real wall-clock time.
   */
  readonly now?: Date
}

export type RunDueResult = {
  readonly fired: readonly string[]
  readonly failed: readonly { id: string; error: string }[]
}

export type SchedulerWorkerOptions = RunDueOptions & {
  readonly intervalMs?: number
  readonly onError?: (e: unknown) => void
}

export type SchedulerWorkerHandle = {
  readonly stop: () => Promise<void>
  readonly tickOnce: () => Promise<RunDueResult>
}

export type Scheduler = {
  create(input: CreateScheduledTransitionInput): Promise<ScheduledTransition>
  cancel(id: string, opts?: { tenantId?: string }): Promise<boolean>
  list(filter?: ListScheduledFilter): Promise<readonly ScheduledTransition[]>
  runDue(options?: RunDueOptions): Promise<RunDueResult>
  startWorker(options?: SchedulerWorkerOptions): SchedulerWorkerHandle
}

const DEFAULT_BATCH = 50
const DEFAULT_INTERVAL_MS = 1_000

export type BuildSchedulerOptions = {
  readonly connection: Connection
  readonly hooks: HookRegistry
  /**
   * Resolves a transition fire by routing through the engine's typed
   * transition path. Keeps the scheduler decoupled from the engine's
   * concrete client builder.
   */
  readonly fire: (input: {
    tenantId: string
    txnId: string
    name: string
    by: { type: string; id: string }
    data?: Record<string, unknown>
    withKey?: string
    idempotencyKey: string
  }) => Promise<{ transitionId: string }>
}

export function buildScheduler(opts: BuildSchedulerOptions): Scheduler {
  const { connection, fire } = opts

  return {
    async create(input) {
      return await connection.withTenant(input.tenantId, async (tx) => {
        const storedPayload = jsonifyForStorage(input.data ?? {}) as never
        const [row] = await tx<RawScheduledRow[]>`
          insert into "txn_scheduled" (
            tenant_id, txn_id, name, run_at, actor_type, actor_id,
            payload, with_key, idempotency_key, status
          ) values (
            ${input.tenantId}, ${input.txnId}, ${input.name}, ${input.runAt},
            ${input.by.type}, ${input.by.id},
            ${tx.json(storedPayload)}, ${input.withKey ?? null}, ${input.idempotencyKey}, 'pending'
          )
          on conflict (tenant_id, txn_id, idempotency_key) do nothing
          returning *
        `
        if (!row) {
          // Conflict on (tenant, txn, idempotency_key): return the
          // existing row so callers see deterministic state.
          const [existing] = await tx<RawScheduledRow[]>`
            select * from "txn_scheduled"
            where tenant_id = ${input.tenantId}
              and txn_id = ${input.txnId}
              and idempotency_key = ${input.idempotencyKey}
          `
          if (!existing) {
            throw new LokiError(
              'Scheduled-transition insert was a no-op but no existing row matched the idempotency key.',
            )
          }
          return mapRow(existing)
        }
        return mapRow(row)
      })
    },

    async cancel(id, options = {}) {
      const cancelOnce = async (
        target: (typeof connection)['withTenant'],
        tenantId: string,
      ): Promise<boolean> => {
        return await target(tenantId, async (tx) => {
          const rows = await tx<RawScheduledRow[]>`
            update "txn_scheduled"
            set status = 'cancelled'
            where id = ${id} and status = 'pending'
            returning *
          `
          return rows.length > 0
        })
      }
      if (options.tenantId) {
        return cancelOnce(connection.withTenant.bind(connection), options.tenantId)
      }
      // Global cancellation under admin tx — used by ops tooling.
      return await connection.asAdmin(async (tx) => {
        const rows = await tx<RawScheduledRow[]>`
          update "txn_scheduled"
          set status = 'cancelled'
          where id = ${id} and status = 'pending'
          returning *
        `
        return rows.length > 0
      })
    },

    async list(filter = {}) {
      return await connection.asAdmin(async (tx) => {
        const tenantFrag = filter.tenantId ? tx`and tenant_id = ${filter.tenantId}` : tx``
        const statusFrag = filter.status ? tx`and status = ${filter.status}` : tx``
        const dueFrag = filter.dueBefore ? tx`and run_at <= ${filter.dueBefore}` : tx``
        const rows = await tx<RawScheduledRow[]>`
          select * from "txn_scheduled"
          where 1=1 ${tenantFrag} ${statusFrag} ${dueFrag}
          order by run_at asc, id asc
        `
        return rows.map(mapRow)
      })
    },

    async runDue(options = {}) {
      const batch = options.batchSize ?? DEFAULT_BATCH
      const now = options.now ?? new Date()

      // Claim rows in admin context; fire each transition outside the
      // claim tx so the inner transition tx is its own unit of work.
      const claimed = await connection.asAdmin(async (tx) => {
        const tenantFrag = options.tenantId ? tx`and tenant_id = ${options.tenantId}` : tx``
        return await tx<RawScheduledRow[]>`
          select * from "txn_scheduled"
          where status = 'pending'
            and run_at <= ${now}
            ${tenantFrag}
          order by run_at asc, id asc
          limit ${batch}
          for update skip locked
        `
      })

      const fired: string[] = []
      const failed: { id: string; error: string }[] = []
      for (const row of claimed) {
        try {
          const result = await fire({
            tenantId: row.tenant_id,
            txnId: row.txn_id,
            name: row.name,
            by: { type: row.actor_type, id: row.actor_id },
            data: rehydrate(row.payload) as Record<string, unknown>,
            ...(row.with_key ? { withKey: row.with_key } : {}),
            idempotencyKey: `_scheduled:${row.id}`,
          })
          await connection.withTenant(row.tenant_id, async (tx) => {
            await tx`
              update "txn_scheduled"
              set status = 'completed',
                  attempts = attempts + 1,
                  fired_at = now(),
                  fired_transition_id = ${result.transitionId}
              where id = ${row.id}
            `
          })
          fired.push(row.id)
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          await connection.asAdmin(async (tx) => {
            await tx`
              update "txn_scheduled"
              set status = 'failed',
                  attempts = attempts + 1,
                  last_error = ${message}
              where id = ${row.id}
            `
          })
          failed.push({ id: row.id, error: message })
        }
      }

      return { fired, failed }
    },

    startWorker(options = {}) {
      let stopped = false
      let inFlight: Promise<RunDueResult> = Promise.resolve({ fired: [], failed: [] })
      const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS

      const tick = async (): Promise<RunDueResult> => {
        if (stopped) return { fired: [], failed: [] }
        try {
          const result = await this.runDue(options)
          return result
        } catch (e) {
          if (options.onError) options.onError(e)
          return { fired: [], failed: [] }
        }
      }
      const loop = async (): Promise<void> => {
        while (!stopped) {
          inFlight = tick()
          await inFlight
          if (stopped) break
          await sleep(interval)
        }
      }
      loop().catch((e) => {
        if (options.onError) options.onError(e)
      })

      return {
        async stop() {
          stopped = true
          await inFlight
        },
        tickOnce() {
          return tick()
        },
      }
    },
  }
}

type RawScheduledRow = {
  id: string
  tenant_id: string
  txn_id: string
  name: string
  run_at: Date
  actor_type: string
  actor_id: string
  payload: Record<string, unknown>
  with_key: string | null
  idempotency_key: string
  status: ScheduledTransitionStatus
  attempts: number
  last_error: string | null
  fired_at: Date | null
  fired_transition_id: string | null
  created_at: Date
}

/**
 * Inverse of `jsonifyForStorage`: walks the stored payload and turns
 * `{ "$bigint": "<digits>" }` envelopes back into native bigints, so
 * downstream `transactions.transition` sees the same shape the
 * scheduler.create() caller passed in.
 */
function rehydrate(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(rehydrate)
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (Object.keys(v).length === 1 && typeof v.$bigint === 'string') {
      return BigInt(v.$bigint as string)
    }
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) out[k] = rehydrate(v[k])
    return out
  }
  return value
}

function mapRow(row: RawScheduledRow): ScheduledTransition {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    txnId: row.txn_id,
    name: row.name,
    runAt: row.run_at,
    actor: { type: row.actor_type, id: row.actor_id },
    payload: rehydrate(row.payload) as Record<string, unknown>,
    withKey: row.with_key,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    firedAt: row.fired_at,
    firedTransitionId: row.fired_transition_id,
    createdAt: row.created_at,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}
