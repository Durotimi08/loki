/**
 * Read-only projection of the Loki engine. This is the *only* module
 * under `dashboard/` that imports `createEngine` and the *only* one
 * allowed to issue raw `engine.connection.sql` queries (the lint script
 * scopes the exception to this file).
 *
 * Three layers of read-only enforcement (DASHBOARD.md §8.10):
 *   1. This facade exposes a narrowed type — write methods are off-surface.
 *   2. The Postgres pool is opened with `default_transaction_read_only`
 *      so any DML hits PG error 25006.
 *   3. (Prod) `ledger_readonly` role; (M4) raw queries below are all
 *      SELECT-only.
 */
import { createEngine } from '@loki/core'
import type {
  ActorRef,
  AnomalyRow,
  ConnectionInput,
  Dispute,
  DisputeStatus,
  Engine,
  FxRate,
  FxRateHistoryInput,
  HealthCheckOptions,
  HealthReport,
  Hold,
  HoldStatus,
  ListScheduledFilter,
  QueryOps,
  ScheduledTransition,
  TenantRow,
} from '@loki/core'
import { LokiError } from '@loki/core'
import type { LokiConfig } from '../config.js'

export type ReadEngine = {
  readonly health: (options?: HealthCheckOptions) => Promise<HealthReport>
  readonly forTenant: (tenantId: string) => ReadTenantClient
  readonly admin: ReadAdminOps
  readonly decryptPayload: (value: unknown) => Promise<unknown>
  /** Dashboard-specific aggregate queries. SELECT-only, scoped to a tenant. */
  readonly dashboard: DashboardQueries
  /** Operational data — direct projection of read-only engine surfaces. */
  readonly scheduler: ReadSchedulerOps
  readonly holds: ReadHoldsOps
  readonly disputes: ReadDisputesOps
  readonly fx: ReadFxOps
  readonly close: () => Promise<void>
}

export type ReadSchedulerOps = {
  list(filter?: ListScheduledFilter): Promise<readonly ScheduledTransition[]>
}

export type ReadHoldsOps = {
  list(args: { tenantId: string; status?: HoldStatus; limit?: number }): Promise<readonly Hold[]>
  get(id: string): Promise<Hold | null>
}

export type ReadDisputesOps = {
  list(args: {
    tenantId: string
    status?: DisputeStatus
    limit?: number
  }): Promise<readonly Dispute[]>
  get(id: string): Promise<Dispute | null>
}

export type ReadFxOps = {
  history(input: FxRateHistoryInput): Promise<readonly FxRate[]>
}

export type ReadTenantClient = {
  readonly queries: QueryOps
  readonly accounts: {
    readonly balance: Engine['forTenant'] extends (id: string) => infer C
      ? C extends { accounts: { balance: infer B } }
        ? B
        : never
      : never
  }
}

export type ReadAdminOps = {
  readonly tenants: {
    readonly list: () => Promise<readonly TenantRow[]>
    readonly get: (id: string) => Promise<TenantRow | null>
  }
  readonly schema: {
    readonly versions: Engine['admin']['schema']['versions']
  }
}

export type TenantSummary = {
  readonly id: string
  readonly records: number
  readonly transitions: number
  readonly accounts: number
  readonly compromised: number
  readonly openAnomalies: number
  readonly outbox: { readonly pending: number; readonly inflight: number; readonly terminal: number }
  readonly scheduler: { readonly scheduled: number; readonly due: number }
}

export type ActorAccountSummary = {
  readonly name: string
  readonly currency: string
  readonly balance: bigint
}

export type TxnRecordRow = {
  readonly id: string
  readonly tenantId: string
  readonly type: string
  readonly state: string
  readonly version: number
  readonly compromised: boolean
  readonly schemaVersion: number
  readonly activeKeys: readonly string[]
  readonly createdBy: { readonly type: string; readonly id: string }
  readonly participants: Readonly<Record<string, { readonly type: string; readonly id: string }>>
  readonly createdAt: string
  readonly updatedAt: string
}

export type TxnPostingRow = {
  readonly id: string
  readonly transitionId: string
  readonly accountId: string
  readonly ownerActorType: string
  readonly ownerActorId: string
  readonly accountName: string
  readonly currency: string
  readonly direction: 'D' | 'C'
  readonly amount: string
  readonly occurredAt: string
}

export type CapabilityKeyEvent = {
  readonly id: string
  readonly name: string
  readonly status: 'active' | 'consumed' | 'expired'
  readonly grantedByTransitionId: string | null
  readonly consumedByTransitionId: string | null
  readonly expiresAt: string | null
}

export type OutboxStatus = 'pending' | 'in_flight' | 'terminal' | 'failed_terminal'

export type OutboxRow = {
  readonly id: string
  readonly txnId: string
  readonly transitionId: string
  readonly event: string
  readonly intent: string | null
  readonly status: OutboxStatus
  readonly attempts: number
  readonly nextAttemptAt: string
  readonly lastError: string | null
  readonly createdAt: string
  readonly payload: unknown
}

export type ReconcilerWatermark = {
  readonly checkKind: string
  readonly watermark: string | null
  readonly lastSweepAt: string | null
  readonly fullSweepAt: string | null
}

export type FlowStateCount = {
  readonly state: string
  readonly count: number
}

export type FlowTransitionCount = {
  readonly name: string
  readonly fromState: string | null
  readonly toState: string
  readonly count: number
  readonly lastAt: string | null
}

export type TransitionTailRow = {
  readonly id: string
  readonly txnId: string
  readonly type: string
  readonly name: string
  readonly fromState: string | null
  readonly toState: string
  readonly actorType: string
  readonly actorId: string
  readonly occurredAt: string
}

export type AnomalyTailRow = {
  readonly id: string
  readonly check: string
  readonly severity: 'warn' | 'error' | 'critical'
  readonly txnId: string | null
  readonly accountId: string | null
  readonly resolvedAt: string | null
  readonly detectedAt: string
}

/** Watermark a stream uses to ask for "rows after this point". */
export type StreamWatermark = { readonly occurredAt: string; readonly id: string } | null

export type DashboardQueries = {
  /** Rollup numbers for a tenant overview. All SELECT, tenant-scoped via WHERE tenant_id = $1. */
  tenantSummary(tid: string): Promise<TenantSummary>
  /** Distinct actor-id counts grouped by owner type — one row per type that has any accounts. */
  actorTypeCounts(tid: string): Promise<readonly { type: string; count: number }[]>
  /** Distinct actor-id counts grouped by actor type that fired ≥1 transition since `sinceMs` ago. */
  actorTypeActiveCounts(
    tid: string,
    sinceMs: number,
  ): Promise<readonly { type: string; count: number }[]>
  /**
   * Account-perspective activity for an actor: counts transitions whose
   * postings landed on accounts this actor owns, plus the credit/debit
   * sums on those accounts. Returns ALL money movement involving this
   * actor's books — including transitions fired by other actors.
   */
  actorAccountActivity(
    tid: string,
    actor: ActorRef,
    args: { since?: Date; until?: Date },
  ): Promise<{
    transitionsTouched: number
    credited: string
    debited: string
  }>
  /** Paginated, sorted, cursor-keyed list of actor IDs of one type. */
  actorIds(
    tid: string,
    actorType: string,
    args: { cursor?: string | undefined; limit: number },
  ): Promise<{ items: readonly string[]; nextCursor: string | null }>
  /** Snapshot of an actor's accounts with balances. Empty array when actor unknown. */
  actorAccounts(tid: string, actor: ActorRef): Promise<readonly ActorAccountSummary[]>
  /** Single record header by id. Returns null when the record doesn't exist for this tenant. */
  txnRecord(tid: string, txnId: string): Promise<TxnRecordRow | null>
  /** Postings across every transition of a transaction. Cursor is the last `(occurredAt, id)` tuple. */
  txnPostings(
    tid: string,
    txnId: string,
    args: { cursor?: string | undefined; limit: number },
  ): Promise<{ items: readonly TxnPostingRow[]; nextCursor: string | null }>
  /** Capability-key lineage for a transaction. */
  txnKeys(tid: string, txnId: string): Promise<readonly CapabilityKeyEvent[]>
  /** Single anomaly row by id. Returns null when missing for this tenant. */
  anomalyGet(tid: string, id: string): Promise<AnomalyRow | null>
  /** Outbox events page; keyset cursor over `(next_attempt_at, id)`. */
  outboxList(
    tid: string,
    args: { status?: OutboxStatus | undefined; cursor?: string | undefined; limit: number },
  ): Promise<{ items: readonly OutboxRow[]; nextCursor: string | null }>
  /** Single outbox event by id. */
  outboxGet(tid: string, id: string): Promise<OutboxRow | null>
  /** Single scheduled transition by id (engine.scheduler.list filters by tenant but lacks a get). */
  scheduledGet(tid: string, id: string): Promise<ScheduledTransition | null>
  /** Reconciler watermarks, one row per declared check kind. */
  reconcilerState(tid: string): Promise<readonly ReconcilerWatermark[]>
  /** Per-txn-type record counts grouped by state. */
  flowStates(tid: string, txnType: string): Promise<readonly FlowStateCount[]>
  /** Per-transition edge counts within a recent window (ms). */
  flowTransitionCounts(
    tid: string,
    txnType: string,
    windowMs: number,
  ): Promise<readonly FlowTransitionCount[]>
  /**
   * Transitions emitted since a `(occurredAt, id)` cursor. Used by the
   * stream poll loop. Ordered ascending; bounded by `limit`.
   */
  transitionsSince(
    tid: string,
    args: {
      readonly since: StreamWatermark
      readonly limit: number
      readonly txnType?: string | undefined
    },
  ): Promise<readonly TransitionTailRow[]>
  /** Anomalies emitted since a `(detectedAt, id)` cursor. */
  anomaliesSince(
    tid: string,
    args: {
      readonly since: StreamWatermark
      readonly limit: number
      readonly severity?: 'warn' | 'error' | 'critical' | undefined
    },
  ): Promise<readonly AnomalyTailRow[]>
}

export type CreateReadEngineOptions = {
  readonly readUrl?: string
  readonly statementTimeoutMs?: number
  readonly poolMax?: number
}

export function createReadEngine(cfg: LokiConfig, opts: CreateReadEngineOptions = {}): ReadEngine {
  const baseUrl = resolveReadUrl(cfg.connection, opts.readUrl)
  if (baseUrl === null) {
    throw new LokiError(
      'dashboard: read pool requires a URL-based connection. ' +
        "Either configure `connection.url` in loki.config or pass `dashboard.readUrl`. " +
        'A pre-built `sql` client cannot be safely shared with the dashboard because ' +
        'we set `default_transaction_read_only` session-wide on its pool.',
    )
  }

  const url = withReadOnlyParams(baseUrl, {
    application_name: 'loki-dashboard',
    default_transaction_read_only: 'on',
    statement_timeout: String(opts.statementTimeoutMs ?? 5_000),
  })

  const engine = createEngine({
    schema: cfg.schema,
    connection: {
      url,
      options: { max: opts.poolMax ?? 4, connect_timeout: 3 },
    },
  })

  return projectReadOnly(engine)
}

export function projectReadOnly(engine: Engine): ReadEngine {
  return {
    health: (options) => engine.health(options),
    forTenant: (tenantId) => {
      const client = engine.forTenant(tenantId)
      return {
        queries: client.queries,
        accounts: { balance: client.accounts.balance },
      }
    },
    admin: {
      tenants: {
        list: () => engine.admin.tenants.list(),
        get: (id) => engine.admin.tenants.get(id),
      },
      schema: {
        versions: engine.admin.schema.versions,
      },
    },
    decryptPayload: (value) => engine.decryptPayload(value),
    dashboard: buildDashboardQueries(engine),
    scheduler: { list: (filter) => engine.scheduler.list(filter) },
    holds: { list: (args) => engine.holds.list(args), get: (id) => engine.holds.get(id) },
    disputes: { list: (args) => engine.disputes.list(args), get: (id) => engine.disputes.get(id) },
    fx: { history: (input) => engine.fx.history(input) },
    close: () => engine.close(),
  }
}

function buildDashboardQueries(engine: Engine): DashboardQueries {
  return {
    async tenantSummary(tid) {
      // All SELECTs; the pool's `default_transaction_read_only=on` plus
      // the lint exception scoped to this file make raw SQL acceptable.
      // We deliberately avoid `engine.forTenant(tid).queries.*` here
      // because each method opens its own tx — these counters cohere
      // better as a single connection's batch.
      const sql = engine.connection.sql
      const [
        rRecords,
        rTransitions,
        rAccounts,
        rCompromised,
        rAnomalies,
        rOutbox,
        rScheduler,
      ] = await Promise.all([
        sql<{ count: string }[]>`select count(*)::text as count from txn_records where tenant_id = ${tid}`,
        sql<{ count: string }[]>`select count(*)::text as count from txn_transitions where tenant_id = ${tid}`,
        sql<{ count: string }[]>`select count(*)::text as count from accounts where tenant_id = ${tid}`,
        sql<{ count: string }[]>`select count(*)::text as count from txn_records where tenant_id = ${tid} and compromised = true`,
        sql<{ count: string }[]>`select count(*)::text as count from txn_anomalies where tenant_id = ${tid} and resolved_at is null`,
        sql<{ pending: string; inflight: string; terminal: string }[]>`
          select
            count(*) filter (where delivered_at is null and failed_at is null and attempts = 0)::text as pending,
            count(*) filter (where delivered_at is null and failed_at is null and attempts > 0)::text as inflight,
            count(*) filter (where delivered_at is not null or failed_at is not null)::text as terminal
          from outbox where tenant_id = ${tid}
        `,
        sql<{ scheduled: string; due: string }[]>`
          select
            count(*) filter (where status = 'pending')::text as scheduled,
            count(*) filter (where status = 'pending' and run_at <= now())::text as due
          from txn_scheduled where tenant_id = ${tid}
        `,
      ])
      return {
        id: tid,
        records: toN(rRecords[0]?.count),
        transitions: toN(rTransitions[0]?.count),
        accounts: toN(rAccounts[0]?.count),
        compromised: toN(rCompromised[0]?.count),
        openAnomalies: toN(rAnomalies[0]?.count),
        outbox: {
          pending: toN(rOutbox[0]?.pending),
          inflight: toN(rOutbox[0]?.inflight),
          terminal: toN(rOutbox[0]?.terminal),
        },
        scheduler: {
          scheduled: toN(rScheduler[0]?.scheduled),
          due: toN(rScheduler[0]?.due),
        },
      }
    },

    async actorTypeCounts(tid) {
      const sql = engine.connection.sql
      const rows = await sql<{ type: string; count: string }[]>`
        select owner_actor_type as type, count(distinct owner_actor_id)::text as count
        from accounts
        where tenant_id = ${tid}
        group by owner_actor_type
        order by owner_actor_type asc
      `
      return rows.map((r) => ({ type: r.type, count: toN(r.count) }))
    },

    async actorAccountActivity(tid, actor, args) {
      const sql = engine.connection.sql
      const since = args.since
      const until = args.until
      const rows = await sql<
        {
          transitions_touched: string
          credited: string
          debited: string
        }[]
      >`
        select
          count(distinct p.transition_id)::text as transitions_touched,
          coalesce(sum(case when p.direction = 'C' then p.amount else 0 end), 0)::text as credited,
          coalesce(sum(case when p.direction = 'D' then p.amount else 0 end), 0)::text as debited
        from postings p
        join accounts a on a.id = p.account_id
        where p.tenant_id = ${tid}
          and a.owner_actor_type = ${actor.type}
          and a.owner_actor_id = ${actor.id}
          ${since !== undefined ? sql`and p.occurred_at >= ${since}` : sql``}
          ${until !== undefined ? sql`and p.occurred_at < ${until}` : sql``}
      `
      const r = rows[0]
      return {
        transitionsTouched: toN(r?.transitions_touched),
        credited: r?.credited ?? '0',
        debited: r?.debited ?? '0',
      }
    },

    async actorTypeActiveCounts(tid, sinceMs) {
      const sql = engine.connection.sql
      const since = new Date(Date.now() - sinceMs)
      const rows = await sql<{ type: string; count: string }[]>`
        select actor_type as type, count(distinct actor_id)::text as count
        from txn_transitions
        where tenant_id = ${tid} and occurred_at >= ${since}
        group by actor_type
        order by actor_type asc
      `
      return rows.map((r) => ({ type: r.type, count: toN(r.count) }))
    },

    async actorIds(tid, actorTypeName, args) {
      const sql = engine.connection.sql
      const limit = args.limit
      const cursor = args.cursor
      const rows = cursor === undefined
        ? await sql<{ owner_actor_id: string }[]>`
            select distinct owner_actor_id
            from accounts
            where tenant_id = ${tid} and owner_actor_type = ${actorTypeName}
            order by owner_actor_id asc
            limit ${limit + 1}
          `
        : await sql<{ owner_actor_id: string }[]>`
            select distinct owner_actor_id
            from accounts
            where tenant_id = ${tid} and owner_actor_type = ${actorTypeName} and owner_actor_id > ${cursor}
            order by owner_actor_id asc
            limit ${limit + 1}
          `
      const hasMore = rows.length > limit
      const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => r.owner_actor_id)
      const last = items[items.length - 1]
      return { items, nextCursor: hasMore && last !== undefined ? last : null }
    },

    async actorAccounts(tid, actor) {
      const sql = engine.connection.sql
      const rows = await sql<{ name: string; currency: string; balance: string }[]>`
        select name, currency, sum(balance)::text as balance
        from accounts
        where tenant_id = ${tid} and owner_actor_type = ${actor.type} and owner_actor_id = ${actor.id}
        group by name, currency
        order by name asc, currency asc
      `
      return rows.map((r) => ({
        name: r.name,
        currency: r.currency,
        balance: BigInt(r.balance),
      }))
    },

    async txnRecord(tid, txnId) {
      const sql = engine.connection.sql
      const rows = await sql<
        {
          id: string
          type: string
          state: string
          version: number
          active_keys: string[]
          participants: Record<string, { type: string; id: string }>
          created_by_actor_type: string
          created_by_actor_id: string
          compromised: boolean
          schema_version: number
          created_at: Date
          updated_at: Date
        }[]
      >`
        select id, type, state, version, active_keys, participants,
               created_by_actor_type, created_by_actor_id,
               compromised, schema_version, created_at, updated_at
        from txn_records
        where tenant_id = ${tid} and id = ${txnId}
        limit 1
      `
      const r = rows[0]
      if (r === undefined) return null
      return {
        id: r.id,
        tenantId: tid,
        type: r.type,
        state: r.state,
        version: r.version,
        compromised: r.compromised,
        schemaVersion: r.schema_version,
        activeKeys: r.active_keys,
        createdBy: { type: r.created_by_actor_type, id: r.created_by_actor_id },
        participants: r.participants,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      }
    },

    async txnPostings(tid, txnId, args) {
      const sql = engine.connection.sql
      const limit = args.limit
      const cursorParts = args.cursor !== undefined ? parsePostingCursor(args.cursor) : null
      const rows = cursorParts === null
        ? await sql<PostingJoinRow[]>`
            select p.id, p.transition_id, p.account_id, p.amount::text as amount,
                   p.direction, p.occurred_at,
                   a.owner_actor_type, a.owner_actor_id, a.name as account_name, a.currency
            from postings p
            join txn_transitions t on p.transition_id = t.id
            join accounts a on p.account_id = a.id
            where p.tenant_id = ${tid} and t.txn_id = ${txnId}
            order by p.occurred_at asc, p.id asc
            limit ${limit + 1}
          `
        : await sql<PostingJoinRow[]>`
            select p.id, p.transition_id, p.account_id, p.amount::text as amount,
                   p.direction, p.occurred_at,
                   a.owner_actor_type, a.owner_actor_id, a.name as account_name, a.currency
            from postings p
            join txn_transitions t on p.transition_id = t.id
            join accounts a on p.account_id = a.id
            where p.tenant_id = ${tid} and t.txn_id = ${txnId}
              and (p.occurred_at, p.id) > (${cursorParts.occurredAt}, ${cursorParts.id})
            order by p.occurred_at asc, p.id asc
            limit ${limit + 1}
          `
      const hasMore = rows.length > limit
      const slice = hasMore ? rows.slice(0, limit) : rows
      const items = slice.map(
        (r): TxnPostingRow => ({
          id: r.id,
          transitionId: r.transition_id,
          accountId: r.account_id,
          ownerActorType: r.owner_actor_type,
          ownerActorId: r.owner_actor_id,
          accountName: r.account_name,
          currency: r.currency,
          direction: r.direction,
          amount: r.amount,
          occurredAt: r.occurred_at.toISOString(),
        }),
      )
      const last = slice[slice.length - 1]
      const nextCursor =
        hasMore && last !== undefined ? makePostingCursor(last.occurred_at, last.id) : null
      return { items, nextCursor }
    },

    async txnKeys(tid, txnId) {
      const sql = engine.connection.sql
      const rows = await sql<
        {
          id: string
          name: string
          status: 'active' | 'consumed' | 'expired'
          granted_by_transition_id: string | null
          consumed_by_transition_id: string | null
          expires_at: Date | null
        }[]
      >`
        select id, name, status,
               granted_by_transition_id, consumed_by_transition_id, expires_at
        from txn_keys
        where tenant_id = ${tid} and txn_id = ${txnId}
        order by id asc
      `
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        grantedByTransitionId: r.granted_by_transition_id,
        consumedByTransitionId: r.consumed_by_transition_id,
        expiresAt: r.expires_at !== null ? r.expires_at.toISOString() : null,
      }))
    },

    async anomalyGet(tid, id) {
      const sql = engine.connection.sql
      const rows = await sql<Record<string, unknown>[]>`
        select id, tenant_id, detected_at, check_name, txn_id, account_id, severity,
               expected, observed, resolved_at, resolved_by, resolution
        from txn_anomalies
        where tenant_id = ${tid} and id = ${id}
        limit 1
      `
      const r = rows[0]
      if (r === undefined) return null
      return mapAnomaly(r)
    },

    async outboxList(tid, args) {
      const sql = engine.connection.sql
      const limit = args.limit
      const status = args.status
      const cursor = args.cursor !== undefined ? parseOutboxCursor(args.cursor) : null
      const rows = await sql<OutboxRawRow[]>`
        select id, txn_id, transition_id, event, intent,
               (case
                  when delivered_at is not null then 'terminal'
                  when failed_at is not null then 'failed_terminal'
                  when attempts > 0 then 'in_flight'
                  else 'pending'
                end) as status,
               attempts, next_attempt_at, last_error,
               next_attempt_at as created_at, payload
        from outbox
        where tenant_id = ${tid}
          ${status !== undefined ? sql`and (case
              when delivered_at is not null then 'terminal'
              when failed_at is not null then 'failed_terminal'
              when attempts > 0 then 'in_flight'
              else 'pending'
            end) = ${status}` : sql``}
          ${cursor !== null
            ? sql`and (next_attempt_at, id) > (${cursor.nextAttemptAt}, ${cursor.id})`
            : sql``}
        order by next_attempt_at asc, id asc
        limit ${limit + 1}
      `
      const hasMore = rows.length > limit
      const slice = hasMore ? rows.slice(0, limit) : rows
      const items = slice.map(mapOutbox)
      const last = slice[slice.length - 1]
      const nextCursor =
        hasMore && last !== undefined ? makeOutboxCursor(last.next_attempt_at, last.id) : null
      return { items, nextCursor }
    },

    async outboxGet(tid, id) {
      const sql = engine.connection.sql
      const rows = await sql<OutboxRawRow[]>`
        select id, txn_id, transition_id, event, intent,
               (case
                  when delivered_at is not null then 'terminal'
                  when failed_at is not null then 'failed_terminal'
                  when attempts > 0 then 'in_flight'
                  else 'pending'
                end) as status,
               attempts, next_attempt_at, last_error,
               next_attempt_at as created_at, payload
        from outbox
        where tenant_id = ${tid} and id = ${id}
        limit 1
      `
      const r = rows[0]
      return r === undefined ? null : mapOutbox(r)
    },

    async scheduledGet(tid, id) {
      const sql = engine.connection.sql
      const rows = await sql<Record<string, unknown>[]>`
        select id, tenant_id, txn_id, name, run_at,
               actor_type, actor_id, payload, with_key, idempotency_key,
               status, attempts, last_error, fired_at, fired_transition_id, created_at
        from txn_scheduled
        where tenant_id = ${tid} and id = ${id}
        limit 1
      `
      const r = rows[0]
      if (r === undefined) return null
      return mapScheduled(r)
    },

    async reconcilerState(tid) {
      const sql = engine.connection.sql
      // Real table is { key, watermark, updated_at } — key is
      // `<tenant-or-*>:<check>` (see ensureReconcilerStateTable in
      // packages/core/src/engine/reconciler.ts). Filter by the tenant
      // prefix and project check_kind out of the suffix.
      const rows = await sql<
        {
          check_kind: string
          watermark: string | null
          last_sweep_at: Date | null
        }[]
      >`
        select
          split_part(key, ':', 2) as check_kind,
          watermark::text as watermark,
          updated_at as last_sweep_at
        from _loki_reconciler_state
        where split_part(key, ':', 1) = ${tid}
        order by check_kind asc
      `
      return rows.map((r) => ({
        checkKind: r.check_kind,
        watermark: r.watermark,
        lastSweepAt: r.last_sweep_at !== null ? r.last_sweep_at.toISOString() : null,
        fullSweepAt: null,
      }))
    },

    async flowStates(tid, txnType) {
      const sql = engine.connection.sql
      const rows = await sql<{ state: string; count: string }[]>`
        select state, count(*)::text as count
        from txn_records
        where tenant_id = ${tid} and type = ${txnType}
        group by state
        order by state asc
      `
      return rows.map((r) => ({ state: r.state, count: toN(r.count) }))
    },

    async flowTransitionCounts(tid, txnType, windowMs) {
      const sql = engine.connection.sql
      const since = new Date(Date.now() - windowMs)
      const rows = await sql<
        {
          name: string
          from_state: string | null
          to_state: string
          count: string
          last_at: Date
        }[]
      >`
        select name, from_state, to_state,
               count(*)::text as count,
               max(occurred_at) as last_at
        from txn_transitions
        where tenant_id = ${tid} and type = ${txnType} and occurred_at >= ${since}
        group by name, from_state, to_state
        order by name asc
      `
      return rows.map((r) => ({
        name: r.name,
        fromState: r.from_state,
        toState: r.to_state,
        count: toN(r.count),
        lastAt: r.last_at !== null ? r.last_at.toISOString() : null,
      }))
    },

    async transitionsSince(tid, args) {
      const sql = engine.connection.sql
      const since = args.since
      const txnType = args.txnType
      const rows = await sql<
        {
          id: string
          txn_id: string
          type: string
          name: string
          from_state: string | null
          to_state: string
          actor_type: string
          actor_id: string
          occurred_at: Date
        }[]
      >`
        select id, txn_id, type, name, from_state, to_state,
               actor_type, actor_id, occurred_at
        from txn_transitions
        where tenant_id = ${tid}
          ${txnType !== undefined ? sql`and type = ${txnType}` : sql``}
          ${since !== null
            ? sql`and (occurred_at, id) > (${since.occurredAt}, ${since.id})`
            : sql``}
        order by occurred_at asc, id asc
        limit ${args.limit}
      `
      return rows.map((r) => ({
        id: r.id,
        txnId: r.txn_id,
        type: r.type,
        name: r.name,
        fromState: r.from_state,
        toState: r.to_state,
        actorType: r.actor_type,
        actorId: r.actor_id,
        occurredAt: r.occurred_at.toISOString(),
      }))
    },

    async anomaliesSince(tid, args) {
      const sql = engine.connection.sql
      const since = args.since
      const sev = args.severity
      const rows = await sql<
        {
          id: string
          check_name: string
          severity: 'warn' | 'error' | 'critical'
          txn_id: string | null
          account_id: string | null
          detected_at: Date
          resolved_at: Date | null
        }[]
      >`
        select id, check_name, severity, txn_id, account_id, detected_at, resolved_at
        from txn_anomalies
        where tenant_id = ${tid}
          ${sev !== undefined ? sql`and severity = ${sev}` : sql``}
          ${since !== null
            ? sql`and (detected_at, id) > (${since.occurredAt}, ${since.id})`
            : sql``}
        order by detected_at asc, id asc
        limit ${args.limit}
      `
      return rows.map((r) => ({
        id: r.id,
        check: r.check_name,
        severity: r.severity,
        txnId: r.txn_id,
        accountId: r.account_id,
        detectedAt: r.detected_at.toISOString(),
        resolvedAt: r.resolved_at !== null ? r.resolved_at.toISOString() : null,
      }))
    },
  }
}

type OutboxRawRow = {
  id: string
  txn_id: string
  transition_id: string
  event: string
  intent: string | null
  status: OutboxStatus
  attempts: number
  next_attempt_at: Date
  last_error: string | null
  created_at: Date
  payload: unknown
}

function mapOutbox(r: OutboxRawRow): OutboxRow {
  return {
    id: r.id,
    txnId: r.txn_id,
    transitionId: r.transition_id,
    event: r.event,
    intent: r.intent,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at.toISOString(),
    lastError: r.last_error,
    createdAt: r.created_at.toISOString(),
    payload: r.payload,
  }
}

function mapAnomaly(r: Record<string, unknown>): AnomalyRow {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    detectedAt: r['detected_at'] as Date,
    check: r['check_name'] as string,
    txnId: (r['txn_id'] as string | null) ?? null,
    accountId: (r['account_id'] as string | null) ?? null,
    severity: r['severity'] as 'warn' | 'error' | 'critical',
    expected: r['expected'],
    observed: r['observed'],
    resolvedAt: (r['resolved_at'] as Date | null) ?? null,
    resolvedBy: (r['resolved_by'] as string | null) ?? null,
    resolution: (r['resolution'] as string | null) ?? null,
  }
}

function mapScheduled(r: Record<string, unknown>): ScheduledTransition {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    txnId: r['txn_id'] as string,
    name: r['name'] as string,
    runAt: r['run_at'] as Date,
    actor: { type: r['actor_type'] as string, id: r['actor_id'] as string },
    payload: (r['payload'] as Record<string, unknown> | null) ?? {},
    withKey: (r['with_key'] as string | null) ?? null,
    idempotencyKey: r['idempotency_key'] as string,
    status: r['status'] as ScheduledTransition['status'],
    attempts: (r['attempts'] as number | null) ?? 0,
    lastError: (r['last_error'] as string | null) ?? null,
    firedAt: (r['fired_at'] as Date | null) ?? null,
    firedTransitionId: (r['fired_transition_id'] as string | null) ?? null,
    createdAt: r['created_at'] as Date,
  }
}

function makeOutboxCursor(nextAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([nextAt.toISOString(), id]), 'utf8').toString('base64url')
}

function parseOutboxCursor(raw: string): { nextAttemptAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [iso, id] = parsed as [unknown, unknown]
    if (typeof iso !== 'string' || typeof id !== 'string') return null
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    return { nextAttemptAt: d, id }
  } catch {
    return null
  }
}

type PostingJoinRow = {
  id: string
  transition_id: string
  account_id: string
  amount: string
  direction: 'D' | 'C'
  occurred_at: Date
  owner_actor_type: string
  owner_actor_id: string
  account_name: string
  currency: string
}

function makePostingCursor(occurredAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([occurredAt.toISOString(), id]), 'utf8').toString('base64url')
}

function parsePostingCursor(raw: string): { occurredAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [iso, id] = parsed as [unknown, unknown]
    if (typeof iso !== 'string' || typeof id !== 'string') return null
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    return { occurredAt: d, id }
  } catch {
    return null
  }
}

function toN(s: string | undefined): number {
  if (s === undefined) return 0
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

function resolveReadUrl(connection: ConnectionInput, override: string | undefined): string | null {
  if (override) return override
  if ('url' in connection) {
    return connection.readUrl ?? connection.url
  }
  return null
}

function withReadOnlyParams(url: string, params: Record<string, string>): string {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v)
  }
  return u.toString()
}
