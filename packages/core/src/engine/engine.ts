import { planInitialMigration } from '../db/migration.js'
import type { MigrationOptions, MigrationPlan } from '../db/types.js'
import type { SchemaDef } from '../schema/types.js'
import { type AdminOps, buildAdminOps } from './admin.js'
import { type TenantClient, buildTenantClient } from './client.js'
import { type Connection, type ConnectionInput, openConnection } from './connection.js'
import { type Hasher, sha256Hasher } from './hash.js'
import { type Migrator, createMigrator } from './migrator.js'

export type EngineOptions = {
  /** The compiled schema. */
  readonly schema: SchemaDef
  /** Postgres connection — URL string or a pre-built postgres.js client. */
  readonly connection: ConnectionInput
  /** Migration / DDL options. Defaults: RLS tenancy, ledger_app/ledger_admin roles. */
  readonly migration?: MigrationOptions
  /** Hash chain implementation. Defaults to SHA-256. */
  readonly hasher?: Hasher
}

export type Engine = {
  readonly schema: SchemaDef
  readonly admin: AdminOps
  /** Get a tenant-scoped client. */
  forTenant(tenantId: string): TenantClient
  /** Apply pending migrations (currently just the bootstrap plan). */
  migrate(): Promise<readonly { id: string; checksum: string; applied_at: Date }[]>
  /** Roll back the bootstrap plan. */
  rollback(): Promise<void>
  /** The bootstrap plan, exposed so callers can inspect or run it externally. */
  readonly migrations: readonly MigrationPlan[]
  /** Lower-level handles, useful for tests or advanced operators. */
  readonly migrator: Migrator
  readonly connection: Connection
  /** Close the connection pool. Idempotent. */
  close(): Promise<void>
}

/**
 * Construct an `Engine`. Holds the schema, the connection pool, the
 * admin ops surface, the migrator, and a factory for tenant-scoped
 * clients. Application code typically holds one Engine for the
 * lifetime of the process.
 */
export function createEngine(options: EngineOptions): Engine {
  const connection = openConnection(options.connection)
  const hasher = options.hasher ?? sha256Hasher
  const migrations: readonly MigrationPlan[] = [
    planInitialMigration(options.schema, options.migration),
  ]
  const migrator = createMigrator(connection)

  return {
    schema: options.schema,
    admin: buildAdminOps(connection),
    forTenant(tenantId: string) {
      return buildTenantClient({
        schema: options.schema,
        tenantId,
        connection,
        hasher,
      })
    },
    async migrate() {
      return migrator.apply(migrations)
    },
    async rollback() {
      const last = migrations[migrations.length - 1]
      if (!last) return
      await migrator.rollback(last)
    },
    migrations,
    migrator,
    connection,
    async close() {
      await connection.close()
    },
  }
}
