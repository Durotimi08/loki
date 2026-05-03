import type { MigrationPlan } from '../db/types.js'
import { type Connection, type SqlTransaction, withSearchPath } from './connection.js'
import type { HookRegistry } from './hooks.js'
import type { Migrator } from './migrator.js'
import { mapTransition as mapTransitionRow } from './records.js'
import type { CreateTenantInput, TenantRow, TxnTransition } from './types.js'

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
  /**
   * Find records whose stored transitions violate a newly-introduced
   * invariant. This powers `loki migrate enforce <invariant>` (§14.2):
   * when a restrictive change adds a new rule, existing rows are not
   * rewritten; this op surfaces the offending records so an operator
   * can drive forced reversal transitions.
   *
   * The predicate runs in TypeScript on the rehydrated `TxnTransition`
   * row — true means the transition VIOLATES the new rule. We don't
   * try to push the predicate into SQL because invariants are schema
   * authors' arbitrary code; pulling rows back and filtering in TS is
   * the only honest implementation.
   */
  findViolations(args: FindViolationsArgs): Promise<readonly ViolationHit[]>
}

export type FindViolationsArgs = {
  /** Limit to one tenant. Defaults to every tenant. */
  readonly tenantId?: string
  /** Restrict to one transaction type (matches `txn_records.type`). */
  readonly txnType: string
  /** Optional: only check transitions with this name. */
  readonly transitionName?: string
  /** Predicate returning `true` for violators. */
  readonly predicate: (transition: TxnTransition) => boolean
  /**
   * Stop after `limit` rows of work. The full sweep is bounded by
   * the number of stored transitions for `txnType`, which can be
   * large — operators usually want a sample first.
   */
  readonly limit?: number
}

export type ViolationHit = {
  readonly recordId: string
  readonly tenantId: string
  readonly transition: TxnTransition
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
  /**
   * Restore a snapshot into a target connection (default: this engine's
   * own connection). The destination must already have its engine
   * tables migrated. Idempotent — re-importing the same snapshot is a
   * no-op because every insert uses `ON CONFLICT DO NOTHING`.
   */
  import(snapshot: TenantSnapshot, target?: Connection): Promise<void>
  /**
   * Move a tenant from this engine's connection to a target connection
   * (the canonical use: graduate from row-level RLS to a dedicated
   * schema or DB by pointing the target at that connection). Returns
   * the snapshot that was copied.
   *
   * `deleteFromSource: true` removes the tenant from the source after
   * the import lands — the relocation is a hard move, not a copy.
   */
  relocate(args: {
    id: string
    target: Connection
    deleteFromSource?: boolean
  }): Promise<TenantSnapshot>
  /**
   * Provision the physical isolation backing a tenant in `schema` or
   * `db` mode (§7.2). For `schema` mode the engine runs `CREATE SCHEMA`
   * and a fresh migration plan inside that schema so the per-tenant
   * tables exist before any write lands. For `db` mode the caller
   * supplies a pre-opened target connection; the engine just runs the
   * migration plan against it.
   *
   * RLS-mode tenants don't need provisioning — the row-level tables
   * are shared. Calling provision on an `rls` tenant is a no-op.
   */
  provision(args: ProvisionTenantInput): Promise<ProvisionTenantResult>
}

export type ProvisionTenantInput = {
  readonly id: string
  readonly mode: 'schema' | 'db' | 'row'
  /** The target connection to migrate into. Required for `schema` and `db` modes. */
  readonly target?: Connection
  /** Override the schema name used in `schema` mode. Default: `loki_t_<id>`. */
  readonly schemaName?: string
}

export type ProvisionTenantResult = {
  readonly tenantId: string
  readonly schemaName?: string
  readonly applied: number
}

export type TenantSnapshot = {
  readonly tenantId: string
  readonly exportedAt: string
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>
}

export function buildAdminOps(
  connection: Connection,
  hooks?: HookRegistry,
  /**
   * Optional migration plans + migrator, supplied by the engine. Required
   * for `tenants.provision({ mode: 'schema' | 'db' })`. RLS-only setups
   * can omit them.
   */
  provisioning?: { migrations: readonly MigrationPlan[]; migrator: Migrator },
): AdminOps {
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
      async findViolations(args) {
        const limit = args.limit ?? 1_000
        return await connection.asAdmin(async (tx) => {
          const tenantFrag = args.tenantId ? tx`and tenant_id = ${args.tenantId}` : tx``
          const transitionFrag = args.transitionName ? tx`and name = ${args.transitionName}` : tx``
          const rows = await tx<Record<string, unknown>[]>`
            select * from "txn_transitions"
            where type = ${args.txnType}
              ${tenantFrag}
              ${transitionFrag}
            order by id
          `
          const out: ViolationHit[] = []
          for (const row of rows) {
            const transition = mapTransitionRow(row)
            if (!args.predicate(transition)) continue
            out.push({
              recordId: transition.txnId,
              tenantId: transition.tenantId,
              transition,
            })
            if (out.length >= limit) break
          }
          return out
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
          const scheduled = await tx<Record<string, unknown>[]>`
            select * from "txn_scheduled" where tenant_id = ${id} order by created_at, id
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
              txn_scheduled: scheduled,
            },
          }
          return snapshot
        })
      },

      async import(snapshot, target) {
        const dest = target ?? connection
        await dest.asAdmin(async (tx) => {
          await restoreSnapshot(tx, snapshot)
        })
      },

      async relocate(args) {
        // Step 1: export from source (current engine).
        const snapshot = await this.export(args.id)
        // Step 2: import into target. The target must already have its
        // engine tables migrated — we restore data, not schema.
        await args.target.asAdmin(async (tx) => {
          await restoreSnapshot(tx, snapshot)
        })
        // Step 3: optionally delete from source.
        if (args.deleteFromSource) {
          await connection.asAdmin(async (tx) => {
            await deleteTenantData(tx, args.id)
          })
        }
        const [targetRow] = await args.target.asAdmin(async (tx) => {
          return await tx<Record<string, unknown>[]>`
            select * from "tenants" where id = ${args.id}
          `
        })
        const tenant = targetRow ? mapTenant(targetRow) : null
        if (tenant) await fireLifecycle(tenant, 'relocated')
        return snapshot
      },

      async provision(input) {
        if (input.mode === 'row') {
          // RLS tenants share the engine's tables — nothing to provision.
          return { tenantId: input.id, applied: 0 }
        }
        if (!provisioning) {
          throw new Error(
            'tenants.provision({ mode: schema|db }) requires the engine to expose its migration plans. Use createEngine() rather than buildAdminOps directly.',
          )
        }

        if (input.mode === 'schema') {
          const schemaName = input.schemaName ?? `loki_t_${sanitizeForSchemaName(input.id)}`
          if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
            throw new Error(
              `Invalid schema name "${schemaName}". Provide --schemaName matching [a-z][a-z0-9_]{0,62}.`,
            )
          }
          // Step 1: create the schema. CREATE SCHEMA can't run in the
          // same tx as the migration apply (the tables would land in
          // public if search_path isn't set yet), so we run it on its
          // own first.
          await connection.asAdmin(async (tx) => {
            await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
          })
          // Step 2: open a search-path-scoped wrap and migrate into it.
          // The engine's migration plans use unqualified names; the
          // wrap makes them resolve to our new schema.
          const target = input.target ?? withSearchPath(connection, schemaName)
          const migrator = provisioning.migrator
          const applied = await migrator.applyOn(target, provisioning.migrations)
          return { tenantId: input.id, schemaName, applied: applied.length }
        }

        // mode === 'db'
        const target = input.target
        if (!target) {
          throw new Error("tenants.provision({ mode: 'db' }) requires `target` connection.")
        }
        const migrator = provisioning.migrator
        const applied = await migrator.applyOn(target, provisioning.migrations)
        return { tenantId: input.id, applied: applied.length }
      },
    },
  }
}

function sanitizeForSchemaName(tenantId: string): string {
  // Replace anything outside [a-z0-9_] with `_`. Lowercase the rest.
  // The full identifier is checked again before use; this just makes
  // sensible defaults for tenant ids that include `-` etc.
  return tenantId
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 50)
}

/**
 * Replay a snapshot into a destination tx. The order matters because of
 * foreign keys: tenants → accounts → txn_records → txn_transitions →
 * postings/txn_keys → outbox/anomalies/scheduled. Hex-encoded hashes
 * are decoded back to bytea on the way in.
 */
async function restoreSnapshot(tx: SqlTransaction, snapshot: TenantSnapshot): Promise<void> {
  const tables = snapshot.tables
  const tenantRow = (tables.tenants ?? [])[0]
  if (!tenantRow) throw new Error('Snapshot has no tenants row.')

  // Tenant row first; on conflict do nothing so re-importing a snapshot
  // is idempotent.
  await tx`
    insert into "tenants" (id, name, mode, state, created_at)
    values (
      ${tenantRow.id as string},
      ${tenantRow.name as string},
      ${tenantRow.mode as string},
      ${tenantRow.state as string},
      ${tenantRow.created_at as Date}
    )
    on conflict (id) do nothing
  `

  for (const a of tables.accounts ?? []) {
    await tx`
      insert into "accounts" (
        id, tenant_id, owner_actor_type, owner_actor_id, name,
        parent_account_id, shard_index, currency, balance, created_at
      ) values (
        ${a.id as string}, ${a.tenant_id as string},
        ${a.owner_actor_type as string}, ${a.owner_actor_id as string},
        ${a.name as string}, ${(a.parent_account_id as string | null) ?? null},
        ${a.shard_index as number}, ${a.currency as string},
        ${a.balance as string | number}, ${a.created_at as Date}
      )
      on conflict (id) do nothing
    `
  }

  for (const r of tables.txn_records ?? []) {
    await tx`
      insert into "txn_records"
      select * from jsonb_populate_record(null::"txn_records", ${tx.json(r as never)})
      on conflict (id) do nothing
    `
  }

  for (const t of tables.txn_transitions ?? []) {
    // Re-encode the hex hashes back to bytea for storage.
    await tx`
      insert into "txn_transitions" (
        id, tenant_id, txn_id, type, from_state, to_state, name,
        schema_version, actor_type, actor_id, payload, idempotency_key,
        trace_id, prev_hash, row_hash, postings_checksum, reverses, occurred_at
      ) values (
        ${t.id as string}, ${t.tenant_id as string}, ${t.txn_id as string},
        ${t.type as string}, ${(t.from_state as string | null) ?? null},
        ${t.to_state as string}, ${t.name as string},
        ${t.schema_version as number}, ${t.actor_type as string},
        ${t.actor_id as string}, ${tx.json((t.payload as never) ?? ({} as never))},
        ${t.idempotency_key as string}, ${(t.trace_id as string | null) ?? null},
        ${decodeHex(t.prev_hash_hex as string | null)},
        ${decodeHex(t.row_hash_hex as string)},
        ${decodeHex(t.postings_checksum_hex as string)},
        ${(t.reverses as string | null) ?? null}, ${t.occurred_at as Date}
      )
      on conflict (id) do nothing
    `
  }

  for (const p of tables.postings ?? []) {
    await tx`
      insert into "postings"
      select * from jsonb_populate_record(null::"postings", ${tx.json(p as never)})
      on conflict (id) do nothing
    `
  }

  for (const k of tables.txn_keys ?? []) {
    await tx`
      insert into "txn_keys"
      select * from jsonb_populate_record(null::"txn_keys", ${tx.json(k as never)})
      on conflict (id) do nothing
    `
  }

  for (const o of tables.outbox ?? []) {
    await tx`
      insert into "outbox"
      select * from jsonb_populate_record(null::"outbox", ${tx.json(o as never)})
      on conflict (id) do nothing
    `
  }

  for (const a of tables.txn_anomalies ?? []) {
    await tx`
      insert into "txn_anomalies"
      select * from jsonb_populate_record(null::"txn_anomalies", ${tx.json(a as never)})
      on conflict (id) do nothing
    `
  }

  for (const s of tables.txn_scheduled ?? []) {
    await tx`
      insert into "txn_scheduled"
      select * from jsonb_populate_record(null::"txn_scheduled", ${tx.json(s as never)})
      on conflict (id) do nothing
    `
  }
}

function decodeHex(hex: string | null): Buffer | null {
  if (hex === null || hex === undefined) return null
  return Buffer.from(hex, 'hex')
}

async function deleteTenantData(tx: SqlTransaction, id: string): Promise<void> {
  // Reverse-dependency order — anything that references txn_transitions
  // / records / accounts goes first.
  await tx`delete from "txn_scheduled" where tenant_id = ${id}`
  await tx`delete from "outbox" where tenant_id = ${id}`
  await tx`delete from "txn_anomalies" where tenant_id = ${id}`
  await tx`delete from "txn_keys" where tenant_id = ${id}`
  await tx`delete from "postings" where tenant_id = ${id}`
  await tx`delete from "txn_transitions" where tenant_id = ${id}`
  await tx`delete from "txn_records" where tenant_id = ${id}`
  await tx`delete from "accounts" where tenant_id = ${id}`
  await tx`delete from "tenants" where id = ${id}`
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
