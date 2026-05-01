import type { SchemaDef } from '../schema/types.js'
import { type AccountOps, buildAccountOps } from './accounts.js'
import type { Connection } from './connection.js'
import type { Hasher } from './hash.js'
import type { HookRegistry } from './hooks.js'
import { type RecordOps, buildRecordOps } from './records.js'

/**
 * A tenant-scoped client. Every call routes through a tenant-locked
 * transaction (RLS-enforced). Construct via `engine.forTenant(id)` —
 * never directly.
 *
 * Two namespaces:
 *
 *   - `accounts` — provision and inspect balance-bearing accounts
 *   - `transactions` — create records and drive transitions
 *
 * The same instance is safe to share across requests; it doesn't hold
 * state beyond the tenant id and the underlying connection pool.
 */
export type TenantClient = {
  readonly tenantId: string
  readonly accounts: AccountOps
  readonly transactions: RecordOps
}

export function buildTenantClient(opts: {
  schema: SchemaDef
  tenantId: string
  connection: Connection
  hasher: Hasher
  hooks: HookRegistry
}): TenantClient {
  return {
    tenantId: opts.tenantId,
    accounts: buildAccountOps(opts.schema, opts.tenantId, opts.connection),
    transactions: buildRecordOps({
      schema: opts.schema,
      tenantId: opts.tenantId,
      connection: opts.connection,
      hasher: opts.hasher,
      hooks: opts.hooks,
    }),
  }
}
