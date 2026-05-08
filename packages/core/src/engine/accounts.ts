import type { SchemaDef } from '../schema/types.js'
import type { Connection, SqlTransaction } from './connection.js'
import { LokiError } from './errors.js'
import type { AccountIdentity, AccountRow, ActorRef, CreateAccountInput } from './types.js'

/**
 * Per-tenant account ops. Each call wraps in a tenant-scoped tx so RLS
 * is enforced. Sharding is declared by the schema (`shards: 16`) and
 * provisioned eagerly here — N rows per account name, one per shard.
 *
 * For M1 the engine writes every posting to shard 0. Shard-aware
 * posting routing lands with M9 (hot-account sharding) — at that point
 * read-side aggregation already works because `account.balance()` sums
 * across all shards.
 */
export type AccountOps = {
  /**
   * Create an account (or all of its shards if the schema declares
   * `shards > 1`). Idempotent — re-issuing the call returns the
   * existing rows.
   */
  create(input: CreateAccountInput): Promise<readonly AccountRow[]>
  /** Look up the canonical (shard 0) account row by identity. */
  get(identity: AccountIdentity): Promise<AccountRow | null>
  /** Sum the cached balance across every shard for the account. */
  balance(identity: Omit<AccountIdentity, 'shardIndex'>): Promise<bigint>
  /** List every shard row for an account name (useful in tests). */
  shards(identity: Omit<AccountIdentity, 'shardIndex'>): Promise<readonly AccountRow[]>
}

export function buildAccountOps(
  schema: SchemaDef,
  tenantId: string,
  connection: Connection,
): AccountOps {
  return {
    async create(input) {
      const decl = lookupAccountDecl(schema, input.actor.type, input.name)
      const currency = input.currency ?? decl.currency
      const shards = decl.shards
      return connection.withTenant(tenantId, async (tx) => {
        return await provisionShards(
          tx,
          tenantId,
          input.actor,
          input.name,
          currency,
          shards,
          input.parentAccountId,
        )
      })
    },

    async get(identity) {
      return connection.withTenant(tenantId, async (tx) => {
        const shard = identity.shardIndex ?? 0
        const currency = identity.currency
        const [row] = await tx<Record<string, unknown>[]>`
          select * from "accounts"
          where tenant_id = ${tenantId}
            and owner_actor_type = ${identity.actor.type}
            and owner_actor_id = ${identity.actor.id}
            and name = ${identity.name}
            and currency = ${currency}
            and shard_index = ${shard}
        `
        return row ? mapAccount(row) : null
      })
    },

    async balance(identity) {
      return connection.withTenant(tenantId, async (tx) => {
        const [row] = await tx<{ total: string | null }[]>`
          select coalesce(sum(balance), 0)::text as total
          from "accounts"
          where tenant_id = ${tenantId}
            and owner_actor_type = ${identity.actor.type}
            and owner_actor_id = ${identity.actor.id}
            and name = ${identity.name}
            and currency = ${identity.currency}
        `
        return BigInt(row?.total ?? '0')
      })
    },

    async shards(identity) {
      return connection.withTenant(tenantId, async (tx) => {
        const rows = await tx<Record<string, unknown>[]>`
          select * from "accounts"
          where tenant_id = ${tenantId}
            and owner_actor_type = ${identity.actor.type}
            and owner_actor_id = ${identity.actor.id}
            and name = ${identity.name}
            and currency = ${identity.currency}
          order by shard_index
        `
        return rows.map(mapAccount)
      })
    },
  }
}

// =============================================================================
// Internals shared with the transition writer
// =============================================================================

export type AccountDecl = {
  readonly currency: string
  readonly shards: number
  readonly parent?: string
  /** M1: per-account overdraft policy. Defaults `true` for back-compat. */
  readonly allowOverdraft: boolean
}

export function lookupAccountDecl(
  schema: SchemaDef,
  actorType: string,
  accountName: string,
): AccountDecl {
  const actor = schema.meta.actorsByName.get(actorType)
  if (!actor) {
    throw new LokiError(`Schema has no actor of type "${actorType}".`)
  }
  const account = (
    actor.accounts as Record<
      string,
      { currency: string; shards: number; parent?: string; allowOverdraft?: boolean }
    >
  )[accountName]
  if (!account) {
    throw new LokiError(`Actor "${actorType}" has no account named "${accountName}".`)
  }
  // `allowOverdraft` defaults false — see schema/types.ts. The schema
  // builder bakes the resolved value into every AccountDef, so this
  // fallback only kicks in for hand-rolled actor objects that bypass
  // `defineActor`.
  return { ...account, allowOverdraft: account.allowOverdraft ?? false }
}

export async function provisionShards(
  tx: SqlTransaction,
  tenantId: string,
  actor: ActorRef,
  name: string,
  currency: string,
  shards: number,
  parentAccountId?: string,
): Promise<readonly AccountRow[]> {
  // Use ON CONFLICT DO NOTHING so re-creating an account is a no-op.
  const inserted = await tx<Record<string, unknown>[]>`
    insert into "accounts" (
      tenant_id, owner_actor_type, owner_actor_id, name,
      parent_account_id, shard_index, currency, balance
    )
    select
      ${tenantId},
      ${actor.type},
      ${actor.id},
      ${name},
      ${parentAccountId ?? null},
      gs.idx,
      ${currency},
      0
    from generate_series(0, ${shards - 1}) gs(idx)
    on conflict (tenant_id, owner_actor_type, owner_actor_id, name, currency, shard_index)
      do nothing
    returning *
  `

  if (inserted.length === shards) {
    return inserted.map(mapAccount)
  }

  // Some shards already existed — return the full set.
  const all = await tx<Record<string, unknown>[]>`
    select * from "accounts"
    where tenant_id = ${tenantId}
      and owner_actor_type = ${actor.type}
      and owner_actor_id = ${actor.id}
      and name = ${name}
      and currency = ${currency}
    order by shard_index
  `
  return all.map(mapAccount)
}

export function mapAccount(row: Record<string, unknown>): AccountRow {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    ownerActorType: row['owner_actor_type'] as string,
    ownerActorId: row['owner_actor_id'] as string,
    name: row['name'] as string,
    currency: row['currency'] as string,
    shardIndex: row['shard_index'] as number,
    parentAccountId: (row['parent_account_id'] as string | null) ?? null,
    balance: BigInt((row['balance'] as { toString(): string }).toString()),
    createdAt: row['created_at'] as Date,
  }
}
