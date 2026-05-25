/**
 * `ActionExecutor` factory — DASHBOARD.md §9.5.
 *
 * The dashboard's read engine is read-only by every layer (lint,
 * `default_transaction_read_only`, role). For the two action paths we
 * open a separate writable engine on `actions.connectionUrl` — same
 * process, separate pool, separate role (typically `ledger_app`). The
 * lint skips the `actions/` subtree because this is the one place that
 * legitimately writes.
 *
 * Tests inject a fake executor; the real one is constructed lazily on
 * first action POST. Failures during construction bubble out as 503.
 */
import { createEngine } from '@loki/core'
import type { Engine, SchemaDef } from '@loki/core'
import type { ActionExecutor, ActionsConfig } from './types.js'

export type ActionExecutorFactory = () => Promise<ActionExecutor>

const ADVISORY_LOCK_KEY = 'loki.reconciler.dashboard'

export function createActionExecutorFactory(
  cfg: ActionsConfig,
  schema: SchemaDef,
): ActionExecutorFactory {
  let cached: { engine: Engine; executor: ActionExecutor } | null = null

  return async () => {
    if (cached !== null) return cached.executor
    const engine = createEngine({
      schema,
      connection: {
        url: withWriteParams(cfg.connectionUrl, cfg.statementTimeoutMs ?? 10_000),
        options: { max: 2, connect_timeout: 3 },
      },
    })
    const executor: ActionExecutor = {
      async resolveAnomaly(input) {
        // One row update under the engine's tx wrapper. The WHERE clause
        // enforces `resolved_at IS NULL` so a double-resolve becomes a
        // no-op at the DB layer (gate 12).
        return engine.connection.asAdmin(async (tx) => {
          const rows = await tx<{ resolved_at: Date; resolved_by: string }[]>`
            update "txn_anomalies"
            set resolved_at = now(),
                resolved_by = ${input.by},
                resolution = ${input.note}
            where id = ${input.anomalyId}
              and tenant_id = ${input.tenantId}
              and resolved_at is null
            returning resolved_at, resolved_by
          `
          if (rows.length === 0) {
            throw new ActionPreconditionError('anomaly-not-found-or-already-resolved')
          }
          const row = rows[0]!
          return { resolvedAt: row.resolved_at.toISOString(), resolvedBy: row.resolved_by }
        })
      },

      async runReconciler(input) {
        // Advisory lock so two simultaneous run-once requests from
        // different sessions can't pile up on top of each other.
        const sql = engine.connection.sql
        const lockRows = await sql<{ got: boolean }[]>`
          select pg_try_advisory_lock(hashtext(${ADVISORY_LOCK_KEY})) as got
        `
        if (lockRows[0]?.got !== true) {
          throw new ActionPreconditionError('reconciler-already-running')
        }
        const startedAt = Date.now()
        try {
          const result = await engine.reconciler.runOnce({
            tenantId: input.tenantId,
            fullSweep: input.fullSweep,
            // Repair is NEVER on from the dashboard. CLI / runbook only.
            repairBalanceDrift: false,
            repairStateMismatch: false,
            repairFabricatedKeys: false,
          })
          return {
            anomalies: result.anomalies.length,
            quarantined: result.quarantined.length,
            durationMs: Date.now() - startedAt,
          }
        } finally {
          await sql`select pg_advisory_unlock(hashtext(${ADVISORY_LOCK_KEY}))`
        }
      },

      async close() {
        if (cached !== null) {
          await cached.engine.close()
          cached = null
        }
      },
    }
    cached = { engine, executor }
    return executor
  }
}

/** Error class the gate inspects to map to a 409 (vs 500). */
export class ActionPreconditionError extends Error {
  constructor(public readonly slug: string) {
    super(slug)
    this.name = 'ActionPreconditionError'
  }
}

function withWriteParams(url: string, statementTimeoutMs: number): string {
  const u = new URL(url)
  u.searchParams.set('application_name', 'loki-dashboard-actions')
  u.searchParams.set('statement_timeout', String(statementTimeoutMs))
  return u.toString()
}
