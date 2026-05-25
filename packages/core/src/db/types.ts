/**
 * Public option types for migration / DDL generation. Kept separate
 * from the implementation files so consumers can import shapes without
 * pulling in DDL builders.
 */

export type TenancyMode =
  /** All tenants share one schema; isolation enforced via Postgres RLS. */
  | 'rls'
  /** Each tenant gets its own Postgres schema. (Reserved — lands later.) */
  | 'schema-per-tenant'
  /** Each tenant gets its own database. (Reserved — lands later.) */
  | 'database-per-tenant'

export type PartitioningStrategy =
  /** No partitioning. txn_transitions and postings are flat tables. Default. */
  | 'none'
  /**
   * Monthly RANGE partitioning by `occurred_at` on `txn_transitions`
   * and `postings` (§12.3). Keeps VACUUM cost bounded, makes
   * archival cheap, and lets reconciliation scope to recent
   * partitions. Postgres requires the partition key in every PK
   * and unique constraint, so partitioned mode also widens the
   * relevant indexes and drops the cross-table FKs to the
   * partitioned tables — integrity is enforced by the hash chain
   * and the reconciler instead.
   */
  | 'monthly'

export type MigrationOptions = {
  /** Tenancy isolation mode. M1 only implements `rls`. */
  readonly tenancy?: TenancyMode
  /** Postgres role granted constrained INSERT/UPDATE on engine tables. Default `ledger_app`. */
  readonly appRole?: string
  /** Postgres role with full access (migrations, reconciler). Default `ledger_admin`. */
  readonly adminRole?: string
  /**
   * Postgres role for the read-only dashboard pool. Created with SELECT
   * on Loki's own tables only — `REVOKE ALL` on `public` (and default
   * privileges); `search_path` pinned to the engine schema. Default
   * `ledger_readonly`. See DASHBOARD.md §8.10 layer 4.
   */
  readonly readonlyRole?: string
  /**
   * Optional table-name prefix. The eight engine tables become
   * `${prefix}tenants`, `${prefix}txn_records`, etc. Empty by default.
   */
  readonly tablePrefix?: string
  /**
   * Partition `txn_transitions` and `postings` by `occurred_at`. See
   * `PartitioningStrategy`. Default `'none'`.
   */
  readonly partitioning?: PartitioningStrategy
}

export type ResolvedMigrationOptions = {
  readonly tenancy: TenancyMode
  readonly appRole: string
  readonly adminRole: string
  readonly readonlyRole: string
  readonly tablePrefix: string
  readonly partitioning: PartitioningStrategy
}

export const DEFAULT_OPTIONS: ResolvedMigrationOptions = {
  tenancy: 'rls',
  appRole: 'ledger_app',
  adminRole: 'ledger_admin',
  readonlyRole: 'ledger_readonly',
  tablePrefix: '',
  partitioning: 'none',
}

/**
 * Anything that ends up concatenated into a SQL identifier (table
 * names, partition names, role names) must match this regex.
 * H6 fix: previously the partitions module string-concatenated
 * `tablePrefix` into DDL without validation; a misconfigured
 * deployment could inject SQL.
 */
const SAFE_IDENTIFIER_PART = /^[A-Za-z_][A-Za-z0-9_]*$/
const SAFE_IDENTIFIER_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*)?$/

export function resolveOptions(options: MigrationOptions = {}): ResolvedMigrationOptions {
  const tablePrefix = options.tablePrefix ?? DEFAULT_OPTIONS.tablePrefix
  if (!SAFE_IDENTIFIER_PREFIX.test(tablePrefix)) {
    throw new Error(
      `tablePrefix "${tablePrefix}" must be empty or match [A-Za-z_][A-Za-z0-9_]* (no quotes, spaces, or punctuation).`,
    )
  }
  const appRole = options.appRole ?? DEFAULT_OPTIONS.appRole
  if (!SAFE_IDENTIFIER_PART.test(appRole)) {
    throw new Error(`appRole "${appRole}" must match [A-Za-z_][A-Za-z0-9_]*.`)
  }
  const adminRole = options.adminRole ?? DEFAULT_OPTIONS.adminRole
  if (!SAFE_IDENTIFIER_PART.test(adminRole)) {
    throw new Error(`adminRole "${adminRole}" must match [A-Za-z_][A-Za-z0-9_]*.`)
  }
  const readonlyRole = options.readonlyRole ?? DEFAULT_OPTIONS.readonlyRole
  if (!SAFE_IDENTIFIER_PART.test(readonlyRole)) {
    throw new Error(`readonlyRole "${readonlyRole}" must match [A-Za-z_][A-Za-z0-9_]*.`)
  }
  return {
    tenancy: options.tenancy ?? DEFAULT_OPTIONS.tenancy,
    appRole,
    adminRole,
    readonlyRole,
    tablePrefix,
    partitioning: options.partitioning ?? DEFAULT_OPTIONS.partitioning,
  }
}

/**
 * Canonical engine table identifiers. The prefix is applied at SQL
 * emit time. Order matters for migration up/down — referenced tables
 * come before referencing tables on `up`, reversed on `down`.
 */
export const ENGINE_TABLES = [
  'tenants',
  'accounts',
  'txn_records',
  'txn_transitions',
  'txn_keys',
  'postings',
  'outbox',
  'txn_anomalies',
  'txn_scheduled',
  // M16 — FX rates table (Batch D). Tenant-scoped time-series of
  // base/quote/rate tuples. Reconciler reads it to verify rate-pinned
  // transitions; runtime helpers `engine.fx.publish/lookup/history` are
  // the typed surface.
  'fx_rates',
  // M17 — first-class holds + disputes (Batch E).
  'txn_holds',
  'txn_disputes',
] as const

export type EngineTable = (typeof ENGINE_TABLES)[number]

export type MigrationPlan = {
  /** Stable identifier — `0001_init` for the bootstrap migration. */
  readonly id: string
  /** Ordered list of SQL statements to run forward. */
  readonly up: readonly string[]
  /** Ordered list of SQL statements to roll back. */
  readonly down: readonly string[]
  /** Resolved options the plan was built against. */
  readonly options: ResolvedMigrationOptions
  /** Concatenate `up` into a single SQL document. */
  toUpSql(): string
  /** Concatenate `down` into a single SQL document. */
  toDownSql(): string
}
