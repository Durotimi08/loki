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

export type MigrationOptions = {
  /** Tenancy isolation mode. M1 only implements `rls`. */
  readonly tenancy?: TenancyMode
  /** Postgres role granted constrained INSERT/UPDATE on engine tables. Default `ledger_app`. */
  readonly appRole?: string
  /** Postgres role with full access (migrations, reconciler). Default `ledger_admin`. */
  readonly adminRole?: string
  /**
   * Optional table-name prefix. The eight engine tables become
   * `${prefix}tenants`, `${prefix}txn_records`, etc. Empty by default.
   */
  readonly tablePrefix?: string
}

export type ResolvedMigrationOptions = {
  readonly tenancy: TenancyMode
  readonly appRole: string
  readonly adminRole: string
  readonly tablePrefix: string
}

export const DEFAULT_OPTIONS: ResolvedMigrationOptions = {
  tenancy: 'rls',
  appRole: 'ledger_app',
  adminRole: 'ledger_admin',
  tablePrefix: '',
}

export function resolveOptions(options: MigrationOptions = {}): ResolvedMigrationOptions {
  return {
    tenancy: options.tenancy ?? DEFAULT_OPTIONS.tenancy,
    appRole: options.appRole ?? DEFAULT_OPTIONS.appRole,
    adminRole: options.adminRole ?? DEFAULT_OPTIONS.adminRole,
    tablePrefix: options.tablePrefix ?? DEFAULT_OPTIONS.tablePrefix,
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
