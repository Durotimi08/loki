// Public surface for the `db/` namespace — schema → SQL DDL.
//
// M2 turns these statements into live migrations executed against a
// real Postgres connection; M1 produces the SQL text and proves it
// stable via snapshot tests.

export {
  buildDropTablesSql,
  buildTablesSql,
} from './ddl.js'
export {
  buildDropIndexesSql,
  buildIndexesSql,
} from './indexes.js'
export { planInitialMigration } from './migration.js'
export {
  buildDropRlsSql,
  buildRlsSql,
  TENANT_GUC,
} from './rls.js'
export {
  buildDropRolesSql,
  buildGrantsSql,
  buildRolesSql,
} from './roles.js'
export {
  ident,
  inList,
  literal,
  literalString,
  SqlError,
  trimSql,
} from './sql.js'
export type {
  EngineTable,
  MigrationOptions,
  MigrationPlan,
  ResolvedMigrationOptions,
  TenancyMode,
} from './types.js'
export {
  DEFAULT_OPTIONS,
  ENGINE_TABLES,
  resolveOptions,
} from './types.js'
