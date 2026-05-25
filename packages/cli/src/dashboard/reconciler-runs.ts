/**
 * In-memory ring buffer of recent reconciler runs triggered through
 * the dashboard (DASHBOARD.md §6.7).
 *
 * The engine itself doesn't persist per-pass run logs — its continuous
 * reconciler emits `onReconciliationComplete` hooks but writes only
 * watermarks to `_loki_reconciler_state`. So we capture only the runs
 * that the dashboard initiated. That's the right operational view:
 * operators want to see "what did I trigger from the UI", and the
 * engine's automatic ticks already surface via the state endpoint.
 *
 * Lost on dashboard restart. Per-tenant, bounded to 100 entries each.
 */

export type ReconcilerRun = {
  readonly id: string
  readonly tenantId: string
  readonly subject: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly fullSweep: boolean
  readonly anomalies: number
  readonly quarantined: number
  readonly status: 'ok' | 'error'
  readonly errorMessage: string | null
}

export type ReconcilerRunInput = Omit<ReconcilerRun, 'id'>

export type ReconcilerRunsBuffer = {
  /** Append a run; oldest entries fall off when the cap is hit. */
  append(input: ReconcilerRunInput): ReconcilerRun
  /** Most-recent-first. Optional `since` filter (ISO 8601). */
  list(tenantId: string, args?: { since?: string; limit?: number }): readonly ReconcilerRun[]
}

const DEFAULT_MAX_PER_TENANT = 100

export function createReconcilerRunsBuffer(maxPerTenant = DEFAULT_MAX_PER_TENANT): ReconcilerRunsBuffer {
  const byTenant = new Map<string, ReconcilerRun[]>()
  let seq = 0
  return {
    append(input) {
      const run: ReconcilerRun = { id: `run_${++seq}`, ...input }
      const list = byTenant.get(input.tenantId) ?? []
      list.push(run)
      if (list.length > maxPerTenant) list.shift()
      byTenant.set(input.tenantId, list)
      return run
    },
    list(tenantId, args = {}) {
      const limit = Math.min(args.limit ?? 50, 500)
      const all = byTenant.get(tenantId) ?? []
      const since = args.since !== undefined ? new Date(args.since).getTime() : -Infinity
      const filtered = all
        .filter((r) => new Date(r.startedAt).getTime() >= since)
        .slice(-limit)
        .reverse()
      return filtered
    },
  }
}
