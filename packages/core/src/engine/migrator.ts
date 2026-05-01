import { createHash } from 'node:crypto'
import { ident } from '../db/sql.js'
import type { MigrationPlan } from '../db/types.js'
import type { Connection, SqlTransaction } from './connection.js'
import { MigrationMismatchError } from './errors.js'
import type { HookRegistry } from './hooks.js'

/**
 * Migration runner. The runner owns a single bookkeeping table,
 * `_loki_migrations`, that records which migrations have been applied.
 * Applying the bootstrap (`0001_init`) creates the engine tables; any
 * subsequent plan applies in order.
 *
 * Conventions:
 *   - The bookkeeping table lives outside the engine schema and is
 *     never RLS-protected. Migrations themselves create RLS policies.
 *   - Each row stores a SHA-256 of the up-SQL so subsequent runs can
 *     detect divergence between the recorded migration and what the
 *     code currently emits — early warning that someone tampered with
 *     a deployed schema.
 *   - Application happens inside one transaction per plan; partial
 *     application leaves no rows in `_loki_migrations`.
 */

export const MIGRATIONS_TABLE = '_loki_migrations'

export type AppliedMigration = {
  readonly id: string
  readonly checksum: string
  readonly applied_at: Date
}

export type MigratorStatus = {
  readonly applied: readonly AppliedMigration[]
  readonly pending: readonly MigrationPlan[]
}

export type Migrator = {
  /** Apply every plan that hasn't been applied yet. Returns the new applied set. */
  apply(plans: readonly MigrationPlan[]): Promise<readonly AppliedMigration[]>
  /** List which plans have been applied vs are still pending. */
  status(plans: readonly MigrationPlan[]): Promise<MigratorStatus>
  /** Tear down a plan. Use with care — drops engine tables. */
  rollback(plan: MigrationPlan): Promise<void>
}

export function createMigrator(connection: Connection, hooks?: HookRegistry): Migrator {
  return {
    async apply(plans) {
      const newlyApplied: AppliedMigration[] = []
      await connection.asAdmin(async (tx) => {
        await ensureMigrationsTable(tx)
        const seen = await loadApplied(tx)
        for (const plan of plans) {
          const existing = seen.get(plan.id)
          const checksum = sha256Hex(plan.toUpSql())
          if (existing) {
            if (existing.checksum !== checksum) {
              throw new MigrationMismatchError(
                `Migration "${plan.id}" has been applied with a different SQL body. Expected checksum ${existing.checksum}, got ${checksum}. Refusing to re-run.`,
              )
            }
            continue
          }
          await applyPlan(tx, plan)
          const row: AppliedMigration = {
            id: plan.id,
            checksum,
            applied_at: new Date(),
          }
          await tx`
            insert into ${tx(MIGRATIONS_TABLE)}
              (id, checksum, applied_at)
            values
              (${row.id}, ${row.checksum}, ${row.applied_at})
          `
          newlyApplied.push(row)
        }
      })
      // Hooks fire post-commit so a slow handler can never roll back
      // a migration that already landed.
      for (const row of newlyApplied) {
        await hooks?.internals.fireSchemaMigration({
          id: row.id,
          direction: 'up',
          checksum: row.checksum,
          appliedAt: row.applied_at,
        })
      }
      return newlyApplied
    },

    async status(plans) {
      return connection.asAdmin(async (tx) => {
        await ensureMigrationsTable(tx)
        const seen = await loadApplied(tx)
        const applied: AppliedMigration[] = []
        const pending: MigrationPlan[] = []
        for (const plan of plans) {
          const found = seen.get(plan.id)
          if (found) applied.push(found)
          else pending.push(plan)
        }
        return { applied, pending }
      })
    },

    async rollback(plan) {
      const checksum = sha256Hex(plan.toUpSql())
      await connection.asAdmin(async (tx) => {
        await ensureMigrationsTable(tx)
        await applyDownSql(tx, plan)
        await tx`delete from ${tx(MIGRATIONS_TABLE)} where id = ${plan.id}`
      })
      await hooks?.internals.fireSchemaMigration({
        id: plan.id,
        direction: 'down',
        checksum,
        appliedAt: new Date(),
      })
    },
  }
}

// =============================================================================
// Helpers
// =============================================================================

async function ensureMigrationsTable(tx: SqlTransaction): Promise<void> {
  await tx.unsafe(`
    CREATE TABLE IF NOT EXISTS ${ident(MIGRATIONS_TABLE)} (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `)
}

async function loadApplied(tx: SqlTransaction): Promise<Map<string, AppliedMigration>> {
  const rows = await tx<AppliedMigration[]>`
    select id, checksum, applied_at from ${tx(MIGRATIONS_TABLE)} order by id
  `
  const out = new Map<string, AppliedMigration>()
  for (const row of rows) out.set(row.id, row)
  return out
}

async function applyPlan(tx: SqlTransaction, plan: MigrationPlan): Promise<void> {
  // Run the entire `up` script as a single SQL command. postgres.js'
  // `unsafe()` allows multi-statement scripts; we feed it the plan's
  // joined output exactly as the snapshot golden tests verify.
  await tx.unsafe(plan.toUpSql())
}

async function applyDownSql(tx: SqlTransaction, plan: MigrationPlan): Promise<void> {
  await tx.unsafe(plan.toDownSql())
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}
