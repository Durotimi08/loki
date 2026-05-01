import { ident, literalString, trimSql } from './sql.js'
import type { ResolvedMigrationOptions } from './types.js'
import { ENGINE_TABLES } from './types.js'

/**
 * Build the RLS bootstrap for tenant isolation. Every engine table
 * (with the exception of `tenants`, which scopes itself by primary key)
 * gets:
 *
 *   1. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
 *   2. `ALTER TABLE ... FORCE ROW LEVEL SECURITY` — applies even to
 *      table owners; without this, the application's role can bypass
 *      RLS the moment it owns the table.
 *   3. A `tenant_isolation` policy that pins every read/write to
 *      `current_setting('loki.tenant_id')`. Every connection must set
 *      this GUC at session start; queries that don't are rejected.
 *
 * The `loki.tenant_id` GUC is used (not `ledger.tenant_id` from §7.3)
 * to match the project name. If/when the package is renamed, the GUC
 * key follows.
 */
export const TENANT_GUC = 'loki.tenant_id'

export function buildRlsSql(options: ResolvedMigrationOptions): string[] {
  if (options.tenancy !== 'rls') return []

  const stmts: string[] = []
  // tenants is scoped by `id` (which IS the tenant id) — RLS would be
  // self-referential. Skip it.
  const tables = ENGINE_TABLES.filter((name) => name !== 'tenants')

  for (const tableName of tables) {
    const t = ident(`${options.tablePrefix}${tableName}`)
    const policyName = ident(`${options.tablePrefix}${tableName}_tenant_isolation`)

    stmts.push(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;\n`)
    stmts.push(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;\n`)
    stmts.push(
      `CREATE POLICY ${policyName} ON ${t}
  USING (${ident('tenant_id')} = current_setting(${literalString(TENANT_GUC)}, true))
  WITH CHECK (${ident('tenant_id')} = current_setting(${literalString(TENANT_GUC)}, true));
`,
    )
  }

  return stmts.map(trimSql)
}

export function buildDropRlsSql(options: ResolvedMigrationOptions): string[] {
  if (options.tenancy !== 'rls') return []

  const stmts: string[] = []
  const tables = [...ENGINE_TABLES].reverse().filter((name) => name !== 'tenants')

  for (const tableName of tables) {
    const t = ident(`${options.tablePrefix}${tableName}`)
    const policyName = ident(`${options.tablePrefix}${tableName}_tenant_isolation`)

    stmts.push(`DROP POLICY IF EXISTS ${policyName} ON ${t};\n`)
    stmts.push(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;\n`)
  }

  return stmts.map(trimSql)
}
