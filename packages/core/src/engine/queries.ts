import { type PayloadCrypto, decryptPayload } from '../primitives/payload-crypto.js'
import { mapAccount } from './accounts.js'
import type { CanonicalValue } from './canonical.js'
import type { Connection, SqlTransaction } from './connection.js'
import { type Cursor, type Page, decodeCursor, encodeCursor } from './cursor.js'
import { LokiError } from './errors.js'
import { type Hasher, computePostingsChecksum, computeRowHash } from './hash.js'
import type {
  AccountIdentity,
  AccountRow,
  ActorRef,
  AnomalyRow,
  Posting as EnginePosting,
  TxnRecord,
  TxnTransition,
} from './types.js'

/**
 * Per-tenant read API (§11). Every list endpoint uses keyset
 * pagination on `(occurred_at, id)` — `OFFSET` is never emitted.
 * Filters compile to index-covered queries; the `txn_records`,
 * `txn_transitions`, `postings`, `outbox`, and `txn_anomalies` indexes
 * declared in §12.2 cover every hot path here.
 */

export type QueryOps = {
  /**
   * Per-actor view — every record this actor either *created* or
   * *drove a transition on* in the given window. Distinct on record
   * id; ordered by `updated_at DESC, id DESC`.
   */
  actor(actor: ActorRef): ActorScopedOps
  /** Account-centric reads. */
  account: AccountQueryOps
  /** Generic Prisma-style finders. */
  transactions: { findMany(args?: FindManyTransactionsArgs): Promise<Page<TxnRecord>> }
  transitions: { findMany(args?: FindManyTransitionsArgs): Promise<Page<TxnTransition>> }
  anomalies: { findMany(args?: FindManyAnomaliesArgs): Promise<Page<AnomalyRow>> }
  postings: { findMany(args?: FindManyPostingsArgs): Promise<Page<EnginePosting>> }
  /**
   * On-demand integrity recheck for a single record. Recomputes the
   * hash chain and posting checksums and compares against stored
   * values without writing to `txn_anomalies`.
   */
  verify(txnId: string, hasher: Hasher): Promise<VerifyResult>
}

export type VerifyResult = {
  readonly ok: boolean
  readonly recordId: string
  readonly transitionsChecked: number
  readonly issues: readonly {
    readonly transitionId: string
    readonly check: 'hash_chain_break' | 'checksum_mismatch'
    readonly expected: string
    readonly observed: string
  }[]
}

export type ActorScopedOps = {
  /** Records the actor has touched, with optional type/state filters and pagination. */
  transactions(args?: ActorTransactionsArgs): Promise<Page<TxnRecord>>
  /** Aggregate summary for the actor over a window. */
  summary(args?: ActorSummaryArgs): Promise<ActorSummary>
  /**
   * Full transition trail for every record in `transactions(...)`'s
   * page. Use only with a small `limit` — each item triggers a join.
   */
  trails(args?: ActorTransactionsArgs): Promise<
    Page<{
      readonly record: TxnRecord
      readonly trail: readonly TxnTransition[]
    }>
  >
  /** All accounts owned by the actor (every name, every shard). */
  accounts(): Promise<readonly AccountRow[]>
}

export type AccountQueryOps = {
  /** Postings on an account, paginated. */
  history(account: AccountIdentity, args?: AccountHistoryArgs): Promise<Page<EnginePosting>>
  /** Point-in-time balance, computed by replaying postings up to `when`. */
  balanceAt(account: AccountIdentity, when: Date): Promise<bigint>
  /** Aggregate metrics over an account's posting history. */
  aggregate(account: AccountIdentity, args?: AccountAggregateArgs): Promise<AccountAggregate>
}

export type AccountAggregateArgs = {
  readonly since?: DateLike
  readonly until?: DateLike
  readonly metrics?: readonly AccountAggregateMetric[]
}

export type AccountAggregateMetric =
  | 'count'
  | 'sum_credit'
  | 'sum_debit'
  | 'min_amount'
  | 'max_amount'

export type AccountAggregate = {
  readonly count: number
  readonly sumCredit: bigint
  readonly sumDebit: bigint
  readonly minAmount: bigint | null
  readonly maxAmount: bigint | null
}

// =============================================================================
// Args
// =============================================================================

export type DateLike = Date | string

export type ActorTransactionsArgs = {
  readonly type?: string | readonly string[]
  readonly state?: string | readonly string[]
  readonly since?: DateLike
  readonly until?: DateLike
  readonly limit?: number
  readonly cursor?: string
}

export type ActorSummaryArgs = {
  readonly since?: DateLike
  readonly until?: DateLike
  readonly type?: string | readonly string[]
}

export type ActorSummary = {
  readonly transitions: number
  readonly totalCredited: bigint
  readonly totalDebited: bigint
  readonly byState: Readonly<Record<string, number>>
  readonly byType: Readonly<Record<string, number>>
}

export type AmountFilter = {
  readonly gte?: bigint | number
  readonly lte?: bigint | number
}

export type AccountHistoryArgs = {
  readonly since?: DateLike
  readonly until?: DateLike
  readonly direction?: 'D' | 'C'
  readonly amount?: AmountFilter
  readonly limit?: number
  readonly cursor?: string
}

export type FindManyTransactionsArgs = {
  readonly where?: {
    readonly type?: string | readonly string[] | { readonly in: readonly string[] }
    readonly state?: string | readonly string[] | { readonly in: readonly string[] }
    readonly compromised?: boolean
  }
  readonly limit?: number
  readonly cursor?: string
  readonly orderBy?: 'updatedAt:desc' | 'updatedAt:asc'
}

export type FindManyTransitionsArgs = {
  readonly where?: {
    readonly type?: string | readonly string[]
    readonly name?: string | readonly string[]
    readonly txnId?: string
    readonly actor?: ActorRef
    readonly occurredAt?: { readonly gte?: DateLike; readonly lt?: DateLike }
  }
  readonly limit?: number
  readonly cursor?: string
  readonly orderBy?: 'occurredAt:desc' | 'occurredAt:asc'
}

export type FindManyAnomaliesArgs = {
  readonly where?: {
    readonly severity?: 'warn' | 'error' | 'critical' | readonly ('warn' | 'error' | 'critical')[]
    readonly check?: string | readonly string[]
    readonly resolved?: boolean
  }
  readonly limit?: number
  readonly cursor?: string
}

export type FindManyPostingsArgs = {
  readonly where?: {
    readonly accountId?: string
    readonly transitionId?: string
    readonly direction?: 'D' | 'C'
    readonly amount?: AmountFilter
    readonly occurredAt?: { readonly gte?: DateLike; readonly lt?: DateLike }
  }
  readonly limit?: number
  readonly cursor?: string
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 1000

// =============================================================================
// Build
// =============================================================================

export type BuildQueryOpsOptions = {
  /** Auto-decrypt envelope payloads on read paths (M6). */
  readonly payloadCrypto?: PayloadCrypto
}

export function buildQueryOps(
  tenantId: string,
  connection: Connection,
  opts: BuildQueryOpsOptions = {},
): QueryOps {
  const crypto = opts.payloadCrypto
  return {
    actor(actor: ActorRef): ActorScopedOps {
      return {
        async transactions(args = {}) {
          return connection.withTenantReplica(tenantId, async (tx) => {
            return await actorTransactions(tx, tenantId, actor, args)
          })
        },
        async summary(args = {}) {
          return connection.withTenantReplica(tenantId, async (tx) => {
            return await actorSummary(tx, tenantId, actor, args)
          })
        },
        async trails(args = {}) {
          return connection.withTenantReplica(tenantId, async (tx) => {
            const page = await actorTransactions(tx, tenantId, actor, args)
            const items = []
            for (const record of page.items) {
              const trail = await loadTrail(tx, tenantId, record.id)
              items.push({ record, trail: await decryptTransitions(trail, crypto) })
            }
            return { items, nextCursor: page.nextCursor }
          })
        },
        async accounts() {
          return connection.withTenantReplica(tenantId, async (tx) => {
            return await actorAccounts(tx, tenantId, actor)
          })
        },
      }
    },

    account: {
      async history(account, args = {}) {
        return connection.withTenant(tenantId, async (tx) => {
          return await accountHistory(tx, tenantId, account, args)
        })
      },
      async balanceAt(account, when) {
        return connection.withTenant(tenantId, async (tx) => {
          return await accountBalanceAt(tx, tenantId, account, toDate(when))
        })
      },
      async aggregate(account, args = {}) {
        return connection.withTenant(tenantId, async (tx) => {
          return await accountAggregate(tx, tenantId, account, args)
        })
      },
    },

    transactions: {
      async findMany(args = {}) {
        return connection.withTenant(tenantId, async (tx) => {
          return await findManyTransactions(tx, tenantId, args)
        })
      },
    },
    transitions: {
      async findMany(args = {}) {
        return connection.withTenant(tenantId, async (tx) => {
          const page = await findManyTransitions(tx, tenantId, args)
          const items = await decryptTransitions(page.items, crypto)
          return { items, nextCursor: page.nextCursor }
        })
      },
    },
    anomalies: {
      async findMany(args = {}) {
        return connection.withTenant(tenantId, async (tx) => {
          const page = await findManyAnomalies(tx, tenantId, args)
          const items = await decryptAnomalies(page.items, crypto)
          return { items, nextCursor: page.nextCursor }
        })
      },
    },
    postings: {
      async findMany(args = {}) {
        return connection.withTenant(tenantId, async (tx) => {
          return await findManyPostings(tx, tenantId, args)
        })
      },
    },
    async verify(txnId, hasher) {
      return connection.withTenant(tenantId, async (tx) => {
        return await verifyRecord(tx, tenantId, txnId, hasher, crypto)
      })
    },
  }
}

async function decryptTransitions(
  items: readonly TxnTransition[],
  crypto: PayloadCrypto | undefined,
): Promise<TxnTransition[]> {
  if (!crypto) return items as TxnTransition[]
  const out: TxnTransition[] = []
  for (const t of items) {
    const decrypted = await decryptPayload(crypto, t.payload)
    out.push({ ...t, payload: (decrypted as Record<string, unknown>) ?? {} })
  }
  return out
}

async function decryptAnomalies(
  items: readonly AnomalyRow[],
  crypto: PayloadCrypto | undefined,
): Promise<AnomalyRow[]> {
  if (!crypto) return items as AnomalyRow[]
  const out: AnomalyRow[] = []
  for (const a of items) {
    out.push({
      ...a,
      expected: await decryptPayload(crypto, a.expected),
      observed: await decryptPayload(crypto, a.observed),
    })
  }
  return out
}

// =============================================================================
// Actor-scoped queries
// =============================================================================

async function actorTransactions(
  tx: SqlTransaction,
  tenantId: string,
  actor: ActorRef,
  args: ActorTransactionsArgs,
): Promise<Page<TxnRecord>> {
  const limit = clampLimit(args.limit)
  const types = normalizeStringArray(args.type)
  const states = normalizeStringArray(args.state)
  const since = args.since ? toDate(args.since) : null
  const until = args.until ? toDate(args.until) : null
  const cursor = args.cursor ? decodeCursor(args.cursor) : null

  // The records this actor has touched: created OR drove some transition
  // OR participated in (matches any slot in the `participants` jsonb).
  // Touched-via-transition uses the §12.2 `txn_transitions_actor_idx`;
  // creator filtering uses `txn_records_creator_idx`. Participant
  // matching walks the jsonb path with parameter binding — never
  // interpolate actor ids into the path string. A GIN-on-jsonb_path_ops
  // index can accelerate it for large tenants; that's an M15 perf
  // hardening concern, not a correctness one.
  const PARTICIPANT_MATCH_PATH = '$.* ? (@.type == $t && @.id == $i)'
  const participantVars = { t: actor.type, i: actor.id }
  const rows = await tx<Record<string, unknown>[]>`
    select r.* from "txn_records" r
    where r.tenant_id = ${tenantId}
      and (
        (r.created_by_actor_type = ${actor.type} and r.created_by_actor_id = ${actor.id})
        or exists (
          select 1 from "txn_transitions" t
          where t.tenant_id = ${tenantId}
            and t.txn_id = r.id
            and t.actor_type = ${actor.type}
            and t.actor_id = ${actor.id}
        )
        or jsonb_path_exists(
          r.participants,
          ${PARTICIPANT_MATCH_PATH}::jsonpath,
          ${tx.json(participantVars as never)}
        )
      )
      ${types.length > 0 ? tx`and r.type = any(${types})` : tx``}
      ${states.length > 0 ? tx`and r.state = any(${states})` : tx``}
      ${since ? tx`and r.updated_at >= ${since}` : tx``}
      ${until ? tx`and r.updated_at < ${until}` : tx``}
      ${cursor ? tx`and (r.updated_at, r.id) < (${cursor.occurredAt}, ${cursor.id})` : tx``}
    order by r.updated_at desc, r.id desc
    limit ${limit + 1}
  `
  return packRecords(rows, limit, (r) => [r['updated_at'] as Date, r['id'] as string])
}

async function actorSummary(
  tx: SqlTransaction,
  tenantId: string,
  actor: ActorRef,
  args: ActorSummaryArgs,
): Promise<ActorSummary> {
  const since = args.since ? toDate(args.since) : null
  const until = args.until ? toDate(args.until) : null
  const types = normalizeStringArray(args.type)

  // Transition count + by-type + credited/debited the actor touched.
  // The transition COUNT uses DISTINCT on t.id because the LEFT JOIN
  // to postings duplicates rows (one per posting) — without the
  // distinct, a `pay` transition with 3 postings would count as 3.
  const [transStats] = await tx<
    {
      transitions: string
      total_credited: string
      total_debited: string
    }[]
  >`
    select
      count(distinct t.id)::text as transitions,
      coalesce(sum(case when p.direction = 'C' then p.amount else 0 end), 0)::text as total_credited,
      coalesce(sum(case when p.direction = 'D' then p.amount else 0 end), 0)::text as total_debited
    from "txn_transitions" t
    left join "postings" p on p.transition_id = t.id
    where t.tenant_id = ${tenantId}
      and t.actor_type = ${actor.type}
      and t.actor_id = ${actor.id}
      ${since ? tx`and t.occurred_at >= ${since}` : tx``}
      ${until ? tx`and t.occurred_at < ${until}` : tx``}
      ${types.length > 0 ? tx`and t.type = any(${types})` : tx``}
  `

  const stateRows = await tx<{ state: string; n: string }[]>`
    select r.state as state, count(*)::text as n from "txn_records" r
    where r.tenant_id = ${tenantId}
      and exists (
        select 1 from "txn_transitions" t
        where t.tenant_id = ${tenantId}
          and t.txn_id = r.id
          and t.actor_type = ${actor.type}
          and t.actor_id = ${actor.id}
          ${since ? tx`and t.occurred_at >= ${since}` : tx``}
          ${until ? tx`and t.occurred_at < ${until}` : tx``}
      )
      ${types.length > 0 ? tx`and r.type = any(${types})` : tx``}
    group by r.state
  `

  const typeRows = await tx<{ type: string; n: string }[]>`
    select r.type as type, count(*)::text as n from "txn_records" r
    where r.tenant_id = ${tenantId}
      and exists (
        select 1 from "txn_transitions" t
        where t.tenant_id = ${tenantId}
          and t.txn_id = r.id
          and t.actor_type = ${actor.type}
          and t.actor_id = ${actor.id}
          ${since ? tx`and t.occurred_at >= ${since}` : tx``}
          ${until ? tx`and t.occurred_at < ${until}` : tx``}
      )
    group by r.type
  `

  const byState: Record<string, number> = {}
  for (const row of stateRows) byState[row.state] = Number(row.n)
  const byType: Record<string, number> = {}
  for (const row of typeRows) byType[row.type] = Number(row.n)

  return {
    transitions: Number(transStats?.transitions ?? '0'),
    totalCredited: BigInt(transStats?.total_credited ?? '0'),
    totalDebited: BigInt(transStats?.total_debited ?? '0'),
    byState,
    byType,
  }
}

// =============================================================================
// Account-centric queries
// =============================================================================

async function accountHistory(
  tx: SqlTransaction,
  tenantId: string,
  account: AccountIdentity,
  args: AccountHistoryArgs,
): Promise<Page<EnginePosting>> {
  const limit = clampLimit(args.limit)
  const since = args.since ? toDate(args.since) : null
  const until = args.until ? toDate(args.until) : null
  const cursor = args.cursor ? decodeCursor(args.cursor) : null

  // Sum across shards by joining accounts on identity.
  const rows = await tx<Record<string, unknown>[]>`
    select p.* from "postings" p
    join "accounts" a on a.id = p.account_id
    where p.tenant_id = ${tenantId}
      and a.owner_actor_type = ${account.actor.type}
      and a.owner_actor_id = ${account.actor.id}
      and a.name = ${account.name}
      and a.currency = ${account.currency}
      ${since ? tx`and p.occurred_at >= ${since}` : tx``}
      ${until ? tx`and p.occurred_at < ${until}` : tx``}
      ${args.direction ? tx`and p.direction = ${args.direction}` : tx``}
      ${
        args.amount?.gte !== undefined
          ? tx`and p.amount >= ${BigInt(args.amount.gte).toString()}::numeric`
          : tx``
      }
      ${
        args.amount?.lte !== undefined
          ? tx`and p.amount <= ${BigInt(args.amount.lte).toString()}::numeric`
          : tx``
      }
      ${cursor ? tx`and (p.occurred_at, p.id) < (${cursor.occurredAt}, ${cursor.id})` : tx``}
    order by p.occurred_at desc, p.id desc
    limit ${limit + 1}
  `
  return packPostings(rows, limit)
}

async function accountBalanceAt(
  tx: SqlTransaction,
  tenantId: string,
  account: AccountIdentity,
  when: Date,
): Promise<bigint> {
  const [row] = await tx<{ total: string | null }[]>`
    select coalesce(sum(case when p.direction = 'C' then p.amount else -p.amount end), 0)::text as total
    from "postings" p
    join "accounts" a on a.id = p.account_id
    where p.tenant_id = ${tenantId}
      and a.owner_actor_type = ${account.actor.type}
      and a.owner_actor_id = ${account.actor.id}
      and a.name = ${account.name}
      and a.currency = ${account.currency}
      and p.occurred_at <= ${when}
  `
  return BigInt(row?.total ?? '0')
}

// =============================================================================
// Generic findMany
// =============================================================================

async function findManyTransactions(
  tx: SqlTransaction,
  tenantId: string,
  args: FindManyTransactionsArgs,
): Promise<Page<TxnRecord>> {
  const limit = clampLimit(args.limit)
  const cursor = args.cursor ? decodeCursor(args.cursor) : null
  const types = normalizeWhereStringSet(args.where?.type)
  const states = normalizeWhereStringSet(args.where?.state)
  const compromised = args.where?.compromised
  const orderDesc = args.orderBy !== 'updatedAt:asc'

  const rows = await tx<Record<string, unknown>[]>`
    select * from "txn_records"
    where tenant_id = ${tenantId}
      ${types.length > 0 ? tx`and type = any(${types})` : tx``}
      ${states.length > 0 ? tx`and state = any(${states})` : tx``}
      ${compromised !== undefined ? tx`and compromised = ${compromised}` : tx``}
      ${
        cursor
          ? orderDesc
            ? tx`and (updated_at, id) < (${cursor.occurredAt}, ${cursor.id})`
            : tx`and (updated_at, id) > (${cursor.occurredAt}, ${cursor.id})`
          : tx``
      }
    order by updated_at ${orderDesc ? tx`desc` : tx`asc`}, id ${orderDesc ? tx`desc` : tx`asc`}
    limit ${limit + 1}
  `
  return packRecords(rows, limit, (r) => [r['updated_at'] as Date, r['id'] as string])
}

async function findManyTransitions(
  tx: SqlTransaction,
  tenantId: string,
  args: FindManyTransitionsArgs,
): Promise<Page<TxnTransition>> {
  const limit = clampLimit(args.limit)
  const cursor = args.cursor ? decodeCursor(args.cursor) : null
  const types = normalizeWhereStringSet(args.where?.type)
  const names = normalizeWhereStringSet(args.where?.name)
  const orderDesc = args.orderBy !== 'occurredAt:asc'
  const since = args.where?.occurredAt?.gte ? toDate(args.where.occurredAt.gte) : null
  const until = args.where?.occurredAt?.lt ? toDate(args.where.occurredAt.lt) : null

  const rows = await tx<Record<string, unknown>[]>`
    select * from "txn_transitions"
    where tenant_id = ${tenantId}
      ${types.length > 0 ? tx`and type = any(${types})` : tx``}
      ${names.length > 0 ? tx`and name = any(${names})` : tx``}
      ${args.where?.txnId ? tx`and txn_id = ${args.where.txnId}` : tx``}
      ${
        args.where?.actor
          ? tx`and actor_type = ${args.where.actor.type} and actor_id = ${args.where.actor.id}`
          : tx``
      }
      ${since ? tx`and occurred_at >= ${since}` : tx``}
      ${until ? tx`and occurred_at < ${until}` : tx``}
      ${
        cursor
          ? orderDesc
            ? tx`and (occurred_at, id) < (${cursor.occurredAt}, ${cursor.id})`
            : tx`and (occurred_at, id) > (${cursor.occurredAt}, ${cursor.id})`
          : tx``
      }
    order by occurred_at ${orderDesc ? tx`desc` : tx`asc`}, id ${orderDesc ? tx`desc` : tx`asc`}
    limit ${limit + 1}
  `
  return packTransitions(rows, limit)
}

async function findManyAnomalies(
  tx: SqlTransaction,
  tenantId: string,
  args: FindManyAnomaliesArgs,
): Promise<Page<AnomalyRow>> {
  const limit = clampLimit(args.limit)
  const cursor = args.cursor ? decodeCursor(args.cursor) : null
  const severities = normalizeWhereStringSet(args.where?.severity)
  const checks = normalizeWhereStringSet(args.where?.check)
  const resolved = args.where?.resolved

  const rows = await tx<Record<string, unknown>[]>`
    select * from "txn_anomalies"
    where tenant_id = ${tenantId}
      ${severities.length > 0 ? tx`and severity = any(${severities})` : tx``}
      ${checks.length > 0 ? tx`and check_name = any(${checks})` : tx``}
      ${
        resolved === true
          ? tx`and resolved_at is not null`
          : resolved === false
            ? tx`and resolved_at is null`
            : tx``
      }
      ${cursor ? tx`and (detected_at, id) < (${cursor.occurredAt}, ${cursor.id})` : tx``}
    order by detected_at desc, id desc
    limit ${limit + 1}
  `
  return packAnomalies(rows, limit)
}

async function findManyPostings(
  tx: SqlTransaction,
  tenantId: string,
  args: FindManyPostingsArgs,
): Promise<Page<EnginePosting>> {
  const limit = clampLimit(args.limit)
  const cursor = args.cursor ? decodeCursor(args.cursor) : null
  const since = args.where?.occurredAt?.gte ? toDate(args.where.occurredAt.gte) : null
  const until = args.where?.occurredAt?.lt ? toDate(args.where.occurredAt.lt) : null

  const rows = await tx<Record<string, unknown>[]>`
    select * from "postings"
    where tenant_id = ${tenantId}
      ${args.where?.accountId ? tx`and account_id = ${args.where.accountId}` : tx``}
      ${args.where?.transitionId ? tx`and transition_id = ${args.where.transitionId}` : tx``}
      ${args.where?.direction ? tx`and direction = ${args.where.direction}` : tx``}
      ${
        args.where?.amount?.gte !== undefined
          ? tx`and amount >= ${BigInt(args.where.amount.gte).toString()}::numeric`
          : tx``
      }
      ${
        args.where?.amount?.lte !== undefined
          ? tx`and amount <= ${BigInt(args.where.amount.lte).toString()}::numeric`
          : tx``
      }
      ${since ? tx`and occurred_at >= ${since}` : tx``}
      ${until ? tx`and occurred_at < ${until}` : tx``}
      ${cursor ? tx`and (occurred_at, id) < (${cursor.occurredAt}, ${cursor.id})` : tx``}
    order by occurred_at desc, id desc
    limit ${limit + 1}
  `
  return packPostings(rows, limit)
}

// =============================================================================
// Helpers
// =============================================================================

function clampLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw new LokiError(`Pagination limit must be a positive integer (got ${limit}).`)
  }
  return Math.min(limit, MAX_LIMIT)
}

function toDate(d: DateLike): Date {
  return d instanceof Date ? d : new Date(d)
}

function normalizeStringArray(value?: string | readonly string[]): readonly string[] {
  if (value === undefined) return []
  return typeof value === 'string' ? [value] : value
}

function normalizeWhereStringSet(
  value?: string | readonly string[] | { in: readonly string[] },
): readonly string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value
  if (typeof value === 'object' && value !== null && 'in' in value) {
    return (value as { in: readonly string[] }).in
  }
  return []
}

type RowToCursor<T> = (row: T) => readonly [Date, string]

function packRecords(
  rows: Record<string, unknown>[],
  limit: number,
  toCursor: RowToCursor<Record<string, unknown>>,
): Page<TxnRecord> {
  const overflow = rows.length > limit
  const trimmed = overflow ? rows.slice(0, limit) : rows
  const items = trimmed.map(mapRecord)
  const last = trimmed[trimmed.length - 1]
  const nextCursor = overflow && last ? makeCursor(toCursor(last)) : null
  return { items, nextCursor }
}

function packTransitions(rows: Record<string, unknown>[], limit: number): Page<TxnTransition> {
  const overflow = rows.length > limit
  const trimmed = overflow ? rows.slice(0, limit) : rows
  const items = trimmed.map(mapTransition)
  const last = trimmed[trimmed.length - 1]
  const nextCursor =
    overflow && last ? makeCursor([last['occurred_at'] as Date, last['id'] as string]) : null
  return { items, nextCursor }
}

function packPostings(rows: Record<string, unknown>[], limit: number): Page<EnginePosting> {
  const overflow = rows.length > limit
  const trimmed = overflow ? rows.slice(0, limit) : rows
  const items = trimmed.map(mapPosting)
  const last = trimmed[trimmed.length - 1]
  const nextCursor =
    overflow && last ? makeCursor([last['occurred_at'] as Date, last['id'] as string]) : null
  return { items, nextCursor }
}

function packAnomalies(rows: Record<string, unknown>[], limit: number): Page<AnomalyRow> {
  const overflow = rows.length > limit
  const trimmed = overflow ? rows.slice(0, limit) : rows
  const items = trimmed.map(mapAnomaly)
  const last = trimmed[trimmed.length - 1]
  const nextCursor =
    overflow && last ? makeCursor([last['detected_at'] as Date, last['id'] as string]) : null
  return { items, nextCursor }
}

// =============================================================================
// New helpers — trails, accounts, aggregate, verify
// =============================================================================

async function loadTrail(
  tx: SqlTransaction,
  tenantId: string,
  txnId: string,
): Promise<readonly TxnTransition[]> {
  const rows = await tx<Record<string, unknown>[]>`
    select * from "txn_transitions"
    where tenant_id = ${tenantId} and txn_id = ${txnId}
    order by id asc
  `
  return rows.map(mapTransition)
}

async function actorAccounts(
  tx: SqlTransaction,
  tenantId: string,
  actor: ActorRef,
): Promise<readonly AccountRow[]> {
  const rows = await tx<Record<string, unknown>[]>`
    select * from "accounts"
    where tenant_id = ${tenantId}
      and owner_actor_type = ${actor.type}
      and owner_actor_id = ${actor.id}
    order by name, currency, shard_index
  `
  return rows.map(mapAccount)
}

async function accountAggregate(
  tx: SqlTransaction,
  tenantId: string,
  account: AccountIdentity,
  args: AccountAggregateArgs,
): Promise<AccountAggregate> {
  const since = args.since ? toDate(args.since) : null
  const until = args.until ? toDate(args.until) : null
  type Row = {
    cnt: string
    sum_credit: string
    sum_debit: string
    min_amount: string | null
    max_amount: string | null
  }
  const [row] = await tx<Row[]>`
    select
      count(p.id)::text as cnt,
      coalesce(sum(case when p.direction = 'C' then p.amount else 0 end), 0)::text as sum_credit,
      coalesce(sum(case when p.direction = 'D' then p.amount else 0 end), 0)::text as sum_debit,
      min(p.amount)::text as min_amount,
      max(p.amount)::text as max_amount
    from "postings" p
    join "accounts" a on a.id = p.account_id
    where p.tenant_id = ${tenantId}
      and a.owner_actor_type = ${account.actor.type}
      and a.owner_actor_id = ${account.actor.id}
      and a.name = ${account.name}
      and a.currency = ${account.currency}
      ${since ? tx`and p.occurred_at >= ${since}` : tx``}
      ${until ? tx`and p.occurred_at < ${until}` : tx``}
  `
  return {
    count: Number(row?.cnt ?? '0'),
    sumCredit: BigInt(row?.sum_credit ?? '0'),
    sumDebit: BigInt(row?.sum_debit ?? '0'),
    minAmount: row?.min_amount ? BigInt(row.min_amount) : null,
    maxAmount: row?.max_amount ? BigInt(row.max_amount) : null,
  }
}

async function verifyRecord(
  tx: SqlTransaction,
  tenantId: string,
  txnId: string,
  hasher: Hasher,
  crypto: PayloadCrypto | undefined,
): Promise<VerifyResult> {
  const transitions = await tx<Record<string, unknown>[]>`
    select * from "txn_transitions"
    where tenant_id = ${tenantId} and txn_id = ${txnId}
    order by id asc
  `
  const issues: {
    transitionId: string
    check: 'hash_chain_break' | 'checksum_mismatch'
    expected: string
    observed: string
  }[] = []
  let prevHash: Buffer | null = null

  for (const t of transitions) {
    const id = t['id'] as string
    const storedRowHash = Buffer.from(t['row_hash'] as Buffer)
    const storedPrev = (t['prev_hash'] as Buffer | null) ?? null
    const storedChecksum = Buffer.from(t['postings_checksum'] as Buffer)

    const expectedPrev = prevHash
    const storedPrevBuf = storedPrev ? Buffer.from(storedPrev) : null
    const prevMismatch = !buffersEqual(storedPrevBuf, expectedPrev)

    // Hashing is over the PLAINTEXT canonical form. Storage may hold an
    // `{ "$encrypted": ... }` envelope; decrypt before rehashing so a
    // payload-crypto rotation never invalidates historical hashes.
    const decryptedPayload = await decryptPayload(crypto, t['payload'])
    const content: CanonicalValue = {
      id,
      txn_id: t['txn_id'] as string,
      tenant_id: t['tenant_id'] as string,
      type: t['type'] as string,
      from_state: (t['from_state'] as string | null) ?? null,
      to_state: t['to_state'] as string,
      name: t['name'] as string,
      schema_version: t['schema_version'] as number,
      actor_type: t['actor_type'] as string,
      actor_id: t['actor_id'] as string,
      payload: ((decryptedPayload as CanonicalValue) ?? {}) as CanonicalValue,
      idempotency_key: t['idempotency_key'] as string,
      occurred_at: t['occurred_at'] as Date,
      reverses: (t['reverses'] as string | null) ?? null,
    }
    const recomputed = computeRowHash(hasher, content, expectedPrev)
    if (prevMismatch || !storedRowHash.equals(recomputed)) {
      issues.push({
        transitionId: id,
        check: 'hash_chain_break',
        expected: recomputed.toString('hex'),
        observed: storedRowHash.toString('hex'),
      })
    }

    const postings = await tx<{ account_id: string; direction: string; amount: string }[]>`
      select account_id, direction, amount::text as amount from "postings"
      where transition_id = ${id}
    `
    const recomputedChecksum = computePostingsChecksum(
      hasher,
      postings.map((p) => ({
        account_id: p.account_id,
        direction: p.direction,
        amount: BigInt(p.amount),
      })),
    )
    if (!storedChecksum.equals(recomputedChecksum)) {
      issues.push({
        transitionId: id,
        check: 'checksum_mismatch',
        expected: recomputedChecksum.toString('hex'),
        observed: storedChecksum.toString('hex'),
      })
    }

    prevHash = storedRowHash
  }

  return {
    ok: issues.length === 0,
    recordId: txnId,
    transitionsChecked: transitions.length,
    issues,
  }
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.equals(b)
}

// =============================================================================
// Page-pack helpers
// =============================================================================

function makeCursor(cursor: readonly [Date, string]): string {
  return encodeCursor(cursor[0], cursor[1])
}

// Same row mappers used elsewhere; kept in sync with engine/records.ts.
function mapRecord(row: Record<string, unknown>): TxnRecord {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    type: row['type'] as string,
    state: row['state'] as string,
    version: row['version'] as number,
    activeKeys: row['active_keys'] as readonly string[],
    participants: (row['participants'] as Readonly<Record<string, ActorRef>>) ?? {},
    createdBy: {
      type: row['created_by_actor_type'] as string,
      id: row['created_by_actor_id'] as string,
    },
    compromised: row['compromised'] as boolean,
    schemaVersion: row['schema_version'] as number,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  }
}

function mapTransition(row: Record<string, unknown>): TxnTransition {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    txnId: row['txn_id'] as string,
    type: row['type'] as string,
    fromState: (row['from_state'] as string | null) ?? null,
    toState: row['to_state'] as string,
    name: row['name'] as string,
    schemaVersion: row['schema_version'] as number,
    actor: {
      type: row['actor_type'] as string,
      id: row['actor_id'] as string,
    },
    payload: (row['payload'] as Record<string, unknown>) ?? {},
    idempotencyKey: row['idempotency_key'] as string,
    traceId: (row['trace_id'] as string | null) ?? null,
    prevHash: (row['prev_hash'] as Buffer | null) ?? null,
    rowHash: row['row_hash'] as Buffer,
    postingsChecksum: row['postings_checksum'] as Buffer,
    reverses: (row['reverses'] as string | null) ?? null,
    occurredAt: row['occurred_at'] as Date,
  }
}

function mapPosting(row: Record<string, unknown>): EnginePosting {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    transitionId: row['transition_id'] as string,
    accountId: row['account_id'] as string,
    amount: BigInt((row['amount'] as { toString(): string }).toString()),
    direction: row['direction'] as 'D' | 'C',
    occurredAt: row['occurred_at'] as Date,
  }
}

function mapAnomaly(row: Record<string, unknown>): AnomalyRow {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    detectedAt: row['detected_at'] as Date,
    check: row['check_name'] as string,
    txnId: (row['txn_id'] as string | null) ?? null,
    accountId: (row['account_id'] as string | null) ?? null,
    severity: row['severity'] as 'warn' | 'error' | 'critical',
    expected: row['expected'],
    observed: row['observed'],
    resolvedAt: (row['resolved_at'] as Date | null) ?? null,
    resolvedBy: (row['resolved_by'] as string | null) ?? null,
    resolution: (row['resolution'] as string | null) ?? null,
  }
}

export type { Page, Cursor }
