import type { SchemaDef } from '../schema/types.js'
import { buildDropTablesSql, buildTablesSql } from './ddl.js'
import { buildDropIndexesSql, buildIndexesSql } from './indexes.js'
import { buildDropRlsSql, buildRlsSql } from './rls.js'
import { buildDropRolesSql, buildGrantsSql, buildRolesSql } from './roles.js'
import type { MigrationOptions, MigrationPlan } from './types.js'
import { resolveOptions } from './types.js'

/**
 * Build the bootstrap migration ("0001_init") for a Loki schema. The
 * plan describes everything the engine needs in a fresh Postgres:
 * roles, eight tables (with schema-derived CHECK constraints), every
 * §12.2 hot-path index, and tenant-isolation RLS policies.
 *
 * The plan is *text* — call sites apply the SQL by feeding it to
 * Postgres. M2 wires the actual `psql`/`postgres.js` execution.
 *
 * @example
 *   import { defineSchema, planInitialMigration } from '@loki/core'
 *   const plan = planInitialMigration(schema, { tenancy: 'rls' })
 *   await pg.unsafe(plan.toUpSql())
 */
export function planInitialMigration(
  schema: SchemaDef,
  options: MigrationOptions = {},
): MigrationPlan {
  const resolved = resolveOptions(options)

  if (resolved.tenancy !== 'rls') {
    throw new Error(
      `Tenancy mode "${resolved.tenancy}" is reserved for a later milestone; only "rls" is implemented in M1.`,
    )
  }

  const up: string[] = [
    ...buildRolesSql(resolved),
    ...buildTablesSql(schema, resolved),
    ...buildIndexesSql(resolved),
    ...buildRlsSql(resolved),
    ...buildGrantsSql(resolved),
  ]

  const down: string[] = [
    ...buildDropRolesSql(resolved),
    ...buildDropRlsSql(resolved),
    ...buildDropIndexesSql(resolved),
    ...buildDropTablesSql(resolved, schema),
  ]

  const sep = '\n'

  return {
    id: '0001_init',
    up,
    down,
    options: resolved,
    toUpSql() {
      return `${up.join(sep)}\n`
    },
    toDownSql() {
      return `${down.join(sep)}\n`
    },
  }
}
