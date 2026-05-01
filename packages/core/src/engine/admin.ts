import type { Connection, SqlTransaction } from './connection.js'
import type { HookRegistry } from './hooks.js'
import type { CreateTenantInput, TenantRow } from './types.js'

export type SchemaVersionCount = {
  readonly version: number
  readonly records: number
  readonly transitions: number
}

/**
 * Admin operations — tenant lifecycle. These run *outside* a tenant
 * GUC because they cross tenants by definition. Per-tenant operations
 * (accounts, records, transitions) live on the `TenantClient` returned
 * by `engine.forTenant()`.
 */
export type AdminOps = {
  readonly tenants: TenantOps
  readonly schema: SchemaAdminOps
}

export type SchemaAdminOps = {
  /**
   * Count records and transitions grouped by their stored
   * `schema_version`. Use this to plan a deprecation: if version 1
   * still has live records, you can't yet remove its compat code.
   */
  versions(tenantId?: string): Promise<readonly SchemaVersionCount[]>
}

export type TenantOps = {
  /** Insert a new tenant row. Idempotent — re-creating the same id is a no-op. */
  create(input: CreateTenantInput): Promise<TenantRow>
  /** Mark a tenant `suspended`. New transitions are refused for that tenant. */
  suspend(id: string): Promise<TenantRow>
  /** Re-activate a suspended tenant. */
  activate(id: string): Promise<TenantRow>
  /** Mark a tenant `deleted`. Engine refuses any operation for the tenant after this. */
  delete(id: string): Promise<TenantRow>
  /** Look up a tenant. Returns null if it doesn't exist. */
  get(id: string): Promise<TenantRow | null>
  /** List all tenants in insertion order. */
  list(): Promise<readonly TenantRow[]>
  /**
   * Snapshot every row that belongs to the tenant — for compliance
   * portability (GDPR), test fixtures, or migrating between tenancy
   * modes. The export is a plain JSON object whose keys are table
   * names and whose values are arrays of rows.
   */
  export(id: string): Promise<TenantSnapshot>
}

export type TenantSnapshot = {
  readonly tenantId: string
  readonly exportedAt: string
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>
}

export function buildAdminOps(connection: Connection, hooks?: HookRegistry): AdminOps {
  const fireLifecycle = async (
    tenant: TenantRow,
    action: 'created' | 'suspended' | 'activated' | 'deleted' | 'relocated',
  ) => {
    await hooks?.internals.fireTenantLifecycle({
      tenantId: tenant.id,
      action,
      mode: tenant.mode,
      at: new Date(),
    })
  }
  return {
    schema: {
      async versions(tenantId) {
        return connection.asAdmin(async (tx) => {
          type Row = { version: number; records: string; transitions: string }
          const rows = tenantId
            ? await tx<Row[]>`
                select v.version,
                       count(distinct r.id)::text as records,
                       count(distinct t.id)::text as transitions
                from (
                  select schema_version as version from "txn_records" where tenant_id = ${tenantId}
                  union
                  select schema_version as version from "txn_transitions" where tenant_id = ${tenantId}
                ) v
                left join "txn_records" r
                  on r.schema_version = v.version and r.tenant_id = ${tenantId}
                left join "txn_transitions" t
                  on t.schema_version = v.version and t.tenant_id = ${tenantId}
                group by v.version
                order by v.version
              `
            : await tx<Row[]>`
                select v.version,
                       count(distinct r.id)::text as records,
                       count(distinct t.id)::text as transitions
                from (
                  select schema_version as version from "txn_records"
                  union
                  select schema_version as version from "txn_transitions"
                ) v
                left join "txn_records" r on r.schema_version = v.version
                left join "txn_transitions" t on t.schema_version = v.version
                group by v.version
                order by v.version
              `
          return rows.map((r) => ({
            version: r.version,
            records: Number(r.records),
            transitions: Number(r.transitions),
          }))
        })
      },
    },
    tenants: {
      async create(input) {
        const result = await connection.asAdmin(async (tx) => {
          const [existing] = await tx<Record<string, unknown>[]>`
            select * from "tenants" where id = ${input.id}
          `
          if (existing) return { tenant: mapTenant(existing), fresh: false }

          const mode = input.mode ?? 'row'
          const [row] = await tx<Record<string, unknown>[]>`
            insert into "tenants" (id, name, mode, state)
            values (${input.id}, ${input.name}, ${mode}, 'active')
            returning *
          `
          if (!row) throw new Error('Tenant insert returned no row')
          return { tenant: mapTenant(row), fresh: true }
        })
        if (result.fresh) await fireLifecycle(result.tenant, 'created')
        return result.tenant
      },

      async suspend(id) {
        const tenant = await connection.asAdmin(async (tx) =>
          mapTenant(await updateState(tx, id, 'suspended')),
        )
        await fireLifecycle(tenant, 'suspended')
        return tenant
      },

      async activate(id) {
        const tenant = await connection.asAdmin(async (tx) => {
          const row = await updateState(tx, id, 'active')
          return mapTenant(row)
        })
        await fireLifecycle(tenant, 'activated')
        return tenant
      },

      async delete(id) {
        const tenant = await connection.asAdmin(async (tx) => {
          const row = await updateState(tx, id, 'deleted')
          return mapTenant(row)
        })
        await fireLifecycle(tenant, 'deleted')
        return tenant
      },

      async get(id) {
        return connection.asAdmin(async (tx) => {
          const [row] = await tx<Record<string, unknown>[]>`
            select * from "tenants" where id = ${id}
          `
          return row ? mapTenant(row) : null
        })
      },

      async list() {
        return connection.asAdmin(async (tx) => {
          const rows = await tx<Record<string, unknown>[]>`
            select * from "tenants" order by created_at, id
          `
          return rows.map(mapTenant)
        })
      },

      async export(id) {
        return connection.asAdmin(async (tx) => {
          const [tenantRow] = await tx<Record<string, unknown>[]>`
            select * from "tenants" where id = ${id}
          `
          if (!tenantRow) {
            throw new Error(`Tenant "${id}" not found.`)
          }
          // Pull every row that belongs to the tenant, ordered for
          // determinism. bytea hashes are emitted as hex so the
          // snapshot survives JSON.stringify.
          const records = await tx<Record<string, unknown>[]>`
            select * from "txn_records" where tenant_id = ${id} order by created_at, id
          `
          const transitions = await tx<Record<string, unknown>[]>`
            select id, tenant_id, txn_id, type, from_state, to_state, name, schema_version,
                   actor_type, actor_id, payload, idempotency_key, trace_id,
                   encode(prev_hash, 'hex') as prev_hash_hex,
                   encode(row_hash, 'hex') as row_hash_hex,
                   encode(postings_checksum, 'hex') as postings_checksum_hex,
                   reverses, occurred_at
            from "txn_transitions" where tenant_id = ${id} order by id
          `
          const accounts = await tx<Record<string, unknown>[]>`
            select * from "accounts" where tenant_id = ${id}
            order by owner_actor_type, owner_actor_id, name, currency, shard_index
          `
          const postings = await tx<Record<string, unknown>[]>`
            select * from "postings" where tenant_id = ${id} order by occurred_at, id
          `
          const keys = await tx<Record<string, unknown>[]>`
            select * from "txn_keys" where tenant_id = ${id} order by id
          `
          const outbox = await tx<Record<string, unknown>[]>`
            select * from "outbox" where tenant_id = ${id} order by id
          `
          const anomalies = await tx<Record<string, unknown>[]>`
            select * from "txn_anomalies" where tenant_id = ${id} order by detected_at, id
          `

          const snapshot: TenantSnapshot = {
            tenantId: id,
            exportedAt: new Date().toISOString(),
            tables: {
              tenants: [tenantRow],
              txn_records: records,
              txn_transitions: transitions,
              accounts: accounts,
              postings: postings,
              txn_keys: keys,
              outbox: outbox,
              txn_anomalies: anomalies,
            },
          }
          return snapshot
        })
      },
    },
  }
}

async function updateState(
  tx: SqlTransaction,
  id: string,
  state: 'active' | 'suspended' | 'deleted',
): Promise<Record<string, unknown>> {
  const [row] = await tx<Record<string, unknown>[]>`
    update "tenants" set state = ${state} where id = ${id} returning *
  `
  if (!row) {
    throw new Error(`Tenant ${id} not found`)
  }
  return row
}

function mapTenant(row: Record<string, unknown>): TenantRow {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    mode: row['mode'] as 'db' | 'schema' | 'row',
    state: row['state'] as 'active' | 'suspended' | 'deleted',
    createdAt: row['created_at'] as Date,
  }
}
