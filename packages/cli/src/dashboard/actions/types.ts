/**
 * Shared types for the actions subtree — DASHBOARD.md §9.
 *
 * Two action IDs, ever. Anything beyond `anomalies.resolve` and
 * `reconciler.run-once` is a CLI workflow, not a dashboard action.
 */

export type ActionId = 'anomalies.resolve' | 'reconciler.run-once'

export const ALL_ACTIONS: readonly ActionId[] = [
  'anomalies.resolve',
  'reconciler.run-once',
]

export type ActionGrants = {
  readonly 'anomalies.resolve'?: readonly string[]
  readonly 'reconciler.run-once'?: readonly string[]
}

export type ActionExecutor = {
  /** Mark one anomaly resolved. Throws when the row doesn't exist or already resolved. */
  resolveAnomaly(input: {
    tenantId: string
    anomalyId: string
    by: string
    note: string
  }): Promise<{ resolvedAt: string; resolvedBy: string }>
  /**
   * Run one reconciler pass for a tenant. Repair flags are unconditionally
   * `false` — dashboards never repair (DASHBOARD.md §9.1).
   */
  runReconciler(input: {
    tenantId: string
    fullSweep: boolean
  }): Promise<{ anomalies: number; quarantined: number; durationMs: number }>
  /** Release any underlying writable pool. */
  close(): Promise<void>
}

export type ActionRateLimit = {
  readonly perMinute?: number
  readonly burst?: number
  readonly cooldownMs?: number
}

export type ActionsConfig = {
  /** Operator-provided URL for the writable pool. Without it, every action 503s. */
  readonly connectionUrl: string
  /** Per-action subject allowlist. Empty list = no one can run that action. */
  readonly grants: ActionGrants
  /** Per-(subject, action) rate limit. Defaults: 10/min, burst 3, cooldown 2_000ms. */
  readonly rateLimit?: ActionRateLimit
  /** Global cap on actions in flight. Default 4. */
  readonly maxInFlight?: number
  /** Per-statement timeout on the actions pool. Default 10_000ms. */
  readonly statementTimeoutMs?: number
}
