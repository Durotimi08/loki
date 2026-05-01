import type { Connection, SqlTransaction } from './connection.js'
import type { CreateTenantInput, TenantRow } from './types.js'

/**
 * Admin operations — tenant lifecycle. These run *outside* a tenant
 * GUC because they cross tenants by definition. Per-tenant operations
 * (accounts, records, transitions) live on the `TenantClient` returned
 * by `engine.forTenant()`.
 */
export type AdminOps = {
  readonly tenants: TenantOps
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
}

export function buildAdminOps(connection: Connection): AdminOps {
  return {
    tenants: {
      async create(input) {
        return connection.asAdmin(async (tx) => {
          const [existing] = await tx<Record<string, unknown>[]>`
            select * from "tenants" where id = ${input.id}
          `
          if (existing) return mapTenant(existing)

          const mode = input.mode ?? 'row'
          const [row] = await tx<Record<string, unknown>[]>`
            insert into "tenants" (id, name, mode, state)
            values (${input.id}, ${input.name}, ${mode}, 'active')
            returning *
          `
          if (!row) throw new Error('Tenant insert returned no row')
          return mapTenant(row)
        })
      },

      async suspend(id) {
        return connection.asAdmin(async (tx) => {
          return mapTenant(await updateState(tx, id, 'suspended'))
        })
      },

      async activate(id) {
        return connection.asAdmin(async (tx) => {
          const row = await updateState(tx, id, 'active')
          return mapTenant(row)
        })
      },

      async delete(id) {
        return connection.asAdmin(async (tx) => {
          const row = await updateState(tx, id, 'deleted')
          return mapTenant(row)
        })
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
