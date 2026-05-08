# Loki API Reference

Comprehensive reference for every public export, configuration option, and CLI command. For the conceptual narrative, see [README.md](./README.md); for the design spec, see [project.md](./project.md).

**Conventions used below**

- TypeScript signatures are abbreviated for readability — see the source for `readonly` / generic-parameter detail.
- Required fields are listed first; optional fields show `?` and their defaults.
- Every API runs against Postgres (≥14, 15+ recommended for partitioning).

---

## Table of contents

- [Packages](#packages)
- [Schema DSL — `@loki/core`](#schema-dsl)
  - [`defineTenant`](#definetenant)
  - [`defineActor`](#defineactor)
  - [`defineTransaction`](#definetransaction)
  - [`defineSchema`](#defineschema)
  - [`defineProjection`](#defineprojection)
  - [`diffSchemas`](#diffschemas)
  - [`validateSchema`](#validateschema)
  - [Standard Schema validators](#standard-schema-validators)
- [Engine — `createEngine` and `EngineOptions`](#engine)
- [Connections](#connections)
  - [`openConnection` / `ConnectionInput`](#openconnection--connectioninput)
  - [`withSearchPath`](#withsearchpath)
- [Tenant client (`engine.forTenant`)](#tenant-client)
  - [`accounts.*`](#accounts)
  - [`transactions.*`](#transactions)
  - [`queries.*`](#queries)
- [Admin ops (`engine.admin`)](#admin-ops)
  - [`admin.tenants.*`](#admintenants)
  - [`admin.schema.*`](#adminschema)
- [Reconciler (`engine.reconciler`)](#reconciler)
- [Payload encryption (Batch B / M6)](#payload-encryption-batch-b--m6)
- [FX rates (Batch D / M16)](#fx-rates-batch-d--m16)
- [Holds and disputes (Batch E / M17)](#holds-and-disputes-batch-e--m17)
- [Read-your-writes (Batch G)](#read-your-writes-batch-g)
- [Observability (Batch H)](#observability-batch-h)
- [Scheduler (`engine.scheduler`)](#scheduler)
- [Partitions (`engine.partitions`)](#partitions)
- [Outbox (`engine.outbox`)](#outbox)
- [Adapters (`engine.adapters`)](#adapters)
  - [`@loki/adapter-sdk` — `defineAdapter`](#defineadapter)
  - [`@loki/adapter-mocked` — `createMockedPsp`](#createmockedpsp)
- [Hooks (`engine.hooks`)](#hooks)
- [Sagas](#sagas)
- [Migrations & DDL](#migrations--ddl)
- [Currency & primitive helpers](#currency--primitive-helpers)
- [Cursors & pagination](#cursors--pagination)
- [Errors](#errors)
- [CLI — `@loki/cli`](#cli)
- [CLI config (`loki.config.ts`)](#cli-config)
- [Standard hashing (`Hasher`)](#hasher)
- [Constants](#constants)

---

## Packages

| Package | What it ships |
|---|---|
| `@loki/core` | Schema DSL, engine, connection layer, reconciler, scheduler, partitions, outbox, hooks, query API, migrations, errors. |
| `@loki/cli` | The `loki` binary plus exported runners (`run`, `runMigrate`, `runReconcile`, `runSchema`, `runTenant`) you can call programmatically. |
| `@loki/adapter-sdk` | `defineAdapter()` plus the `Adapter` / `OutboundContext` / `InboundContext` / `TransitionAction` types. |
| `@loki/adapter-mocked` | `createMockedPsp()` deterministic in-memory PSP for tests. |
| `@loki/client` | Optional typed-facade builder (`defineClient`) for per-transaction-type namespaces. The generic `engine.forTenant(...).transactions` API in `@loki/core` is fully usable on its own. |

---

## Schema DSL

In-code TypeScript builders. Each builder freezes a small object describing one piece of the schema; `defineSchema` composes them and validates the whole.

### `defineTenant`

```ts
defineTenant(name: string): TenantDef
```

The tenant primitive carries no fields beyond a name; every other primitive is implicitly tenant-scoped.

```ts
const Org = defineTenant('Org')
```

### `defineActor`

```ts
defineActor(name: string, input?: ActorInput): ActorDef

type ActorInput = {
  accounts?: AccountSpecMap // { name: AccountOptions }
}

type AccountOptions = {
  currency: CurrencyCode    // 'NGN' | 'USD' | 'EUR' | …
  shards?: number           // hot-account sharding (default 1)
  allowOverdraft?: boolean  // M1: refuse negative balance when false. Default `false`.
  parent?: string           // sub-accounts
}
```

```ts
const User = defineActor('User', {
  accounts: { wallet: { currency: 'NGN' } },
})
const Company = defineActor('Company', {
  accounts: {
    // Sharded accounts must opt into overdraft.
    revenue: { currency: 'NGN', shards: 16, allowOverdraft: true },
    promo_pool: { currency: 'NGN' },
  },
})
const Funder = defineActor('Funder', {
  accounts: { source: { currency: 'NGN', allowOverdraft: true } },
})
const System = defineActor('System')
```

**Overdraft policy.** Default `allowOverdraft: false`. The engine refuses any transition that would take an account's net balance below zero. Per-account net delta is summed across all postings on that account first, then a guarded `UPDATE` runs (`set balance = balance + delta WHERE balance + delta >= 0`). On 0 rows updated, the engine throws `OverdraftError` and the tx rolls back — balance is unchanged.

`allowOverdraft: true` opts in. Reversal transitions (`postings: 'invert:...'`) bypass the check regardless. `allowOverdraft: false` cannot combine with `shards > 1`; `defineActor` throws at schema-build time.

### `defineTransaction`

```ts
defineTransaction<Name, Input>(name: Name, input: Input): TransactionDef

type TransactionInputArgs = {
  states: readonly string[]
  initial: string                                 // must be in `states`
  terminal?: readonly string[]                     // subset of `states`
  participants: Record<string, ActorDef>           // named slots
  transitions: (t: TransitionFactory) => Record<string, TransitionDef>
}
```

`t({...})` shape (one per transition):

```ts
type TransitionInput = {
  from: string | typeof NONE_STATE | readonly string[]
  to: string
  by: readonly ActorDef[]                         // permitted actor types
  payload?: StandardSchemaV1                      // any Standard Schema validator
  postings?: PostingsFn | `invert:${string}`      // double-entry legs
  invariant?: (ctx) => boolean                    // additional rule
  unlocks?: readonly (string | { name; expiresInMs? })[]
  needs?: string                                  // capability key required
  emit?: string                                   // outbox event name
  intent?: string                                 // adapter-routable intent
}
```

Posting function:

```ts
type PostingsFn = (ctx: TransitionContext) => readonly PostingDraft[]

type PostingDraft = {
  direction: 'D' | 'C'
  account: AccountInstanceRef                     // participants.<slot>.<accountName>
  amount: bigint
}
```

`invert:<name>` reverses a previous transition's postings — used for refunds / chargebacks. Supply alternates with `|`: `invert:pay|pay_with_promo`.

```ts
const DeliveryPayment = defineTransaction('DeliveryPayment', {
  states: ['pending', 'completed', 'failed', 'refunded'],
  initial: 'pending',
  terminal: ['failed', 'refunded'],
  participants: { user: User, driver: Driver, company: Company },
  transitions: (t) => ({
    pay: t({
      from: 'pending',
      to: 'completed',
      by: [User],
      payload: z.object({
        amount: z.bigint(),
        driverShare: z.bigint(),
        companyShare: z.bigint(),
      }),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.user.wallet, amount: data.amount },
        { direction: 'C', account: participants.driver.balance, amount: data.driverShare },
        { direction: 'C', account: participants.company.revenue, amount: data.companyShare },
      ],
      invariant: ({ data }) => data.driverShare + data.companyShare === data.amount,
      unlocks: ['refund', { name: 'late_dispute', expiresInMs: 30 * 24 * 60 * 60 * 1000 }],
      emit: 'delivery.paid',
      intent: 'stripe.capture', // optional adapter routing
    }),
    refund: t({
      from: 'completed',
      to: 'refunded',
      by: [Company],
      needs: 'refund',
      postings: 'invert:pay',
    }),
  }),
})
```

`NONE_STATE` is the sentinel for "no current state" — used in initial transitions of records with `<none> -> X` semantics (rare; the engine emits a synthetic `_init` for every `create()`).

### `defineSchema`

```ts
defineSchema<TTenant, TActors, TTransactions>(
  input: SchemaInputArgs
): SchemaDef

type SchemaInputArgs = {
  tenant: TenantDef
  actors: readonly ActorDef[]
  transactions: readonly TransactionDef[]
  version?: number                                 // default 1
  aliases?: Record<number, AliasMap>               // per-version rename maps
  projections?: readonly ProjectionDef[]           // materialized projections
  skipValidation?: boolean                         // tests only
}

type AliasMap = {
  transitions?: Record<string, string>             // oldName -> newName
  states?: Record<string, Record<string, string>>  // {txnName: {old: new}}
  actors?: Record<string, string>
  accounts?: Record<string, Record<string, string>>// {actorName: {old: new}}
}
```

Throws `SchemaError` on validation failure unless `skipValidation: true`.

```ts
export default defineSchema({
  tenant: Org,
  actors: [User, Driver, Company],
  transactions: [DeliveryPayment],
  version: 2,
  aliases: { 1: { actors: { Customer: 'User' } } },
})
```

### `defineProjection`

```ts
defineProjection(name: string, input: ProjectionInput): ProjectionDef

type ProjectionInput = {
  source?: 'txn_transitions'                       // default (only source supported in v1)
  when?: { actorType: string }                     // structural filter
  columns: readonly ProjectionColumn[]
}

type ProjectionColumn =
  | 'id' | 'tenant_id' | 'txn_id' | 'type' | 'name'
  | 'from_state' | 'to_state'
  | 'actor_type' | 'actor_id'
  | 'occurred_at' | 'schema_version'
```

The migrator creates `proj_<name>` table; the engine writes a row inside the same DB transaction as every matching source write. `id` and `tenant_id` are always added.

```ts
const driverActivity = defineProjection('driver_activity', {
  source: 'txn_transitions',
  when: { actorType: 'Driver' },
  columns: ['txn_id', 'type', 'name', 'actor_id', 'occurred_at'],
})
```

### `diffSchemas`

```ts
diffSchemas(from: SchemaDef, to: SchemaDef): SchemaDiff

type SchemaDiff = {
  fromVersion: number
  toVersion: number
  changes: readonly SchemaChange[]
  counts: Record<ChangeKind, number>
}

type ChangeKind = 'additive' | 'rename' | 'restrictive' | 'destructive'
```

Pure structural diff. Use `aliases` on the `to` schema to teach it about renames; without an alias, a removed name is reported as `destructive`.

### `validateSchema`

```ts
validateSchema(schema: SchemaDef, opts?: ValidateOptions): ValidateResult

type ValidateOptions = {
  throwOnError?: boolean // default false
}

type ValidateResult = {
  ok: boolean
  issues: readonly SchemaIssue[]
}
```

Run automatically inside `defineSchema` unless `skipValidation: true`.

### Standard Schema validators

`payload:` accepts any [Standard Schema](https://standardschema.dev) validator. Zod, Valibot, and ArkType all comply:

```ts
import { z } from 'zod'
import * as v from 'valibot'
import { type } from 'arktype'

payload: z.object({ amount: z.bigint() })
payload: v.object({ amount: v.bigint() })
payload: type({ amount: 'bigint' })
```

If you need to test the schema DSL without a real validator, `stubPayload<T>()` (in test fixtures) returns a no-op validator typed as `StandardSchemaV1<T, T>`.

---

## Engine

### `createEngine`

```ts
createEngine(options: EngineOptions): Engine

type EngineOptions = {
  schema: SchemaDef
  connection: ConnectionInput
  migration?: MigrationOptions    // see "Migrations & DDL"
  hasher?: Hasher                 // default sha256Hasher
  connectionFor?: (tenantId: string) => Connection | null
  hooks?: {
    /**
     * Max time a `beforeTransition` handler can run inside the
     * transition tx. Exceeding this throws `BeforeTransitionTimeoutError`
     * and aborts the tx normally. Default 1000ms; pass `null` to disable.
     */
    beforeTransitionTimeoutMs?: number | null
  }
  /** Override shard pick on sharded accounts (M7). Default `Math.random`. */
  shardPicker?: (n: number) => number
  /** Wall-clock injection for tests. Default `() => new Date()`. */
  clock?: () => Date
  /** Payload-encryption hook (Batch B / M6). See "Payload encryption". */
  payloadCrypto?: PayloadCrypto
  /** Read-your-writes (Batch G). `'auto'` | `'off'`. Default `'off'`. */
  readYourWrites?: 'auto' | 'off'
  /** Metrics adapter (Batch H). No-op shim when omitted. */
  metrics?: MetricsAdapter
  /** Tracer (Batch H). No-op shim when omitted. */
  tracer?: Tracer
}
```

`connectionFor` is the per-tenant routing hook (§7.2):

- Return `null` → falls back to the default connection (RLS mode).
- Return a search-path-wrapped Connection → that tenant runs in schema-per-tenant mode.
- Return a separate Connection → that tenant runs in db-per-tenant mode.

`hooks.beforeTransitionTimeoutMs` enforces an upper bound on synchronous pre-commit hooks. The handler runs inside the transition's DB tx, so a runaway would hold row locks; the timeout protects every other writer. Move long work to `afterTransition` (post-commit, async) or an outbox handler.

### `Engine` surface

```ts
type Engine = {
  schema: SchemaDef
  admin: AdminOps                 // tenant + schema admin
  hooks: HookRegistry             // 11 hooks
  outbox: OutboxOps               // worker control
  reconciler: Reconciler          // integrity sweeps
  scheduler: Scheduler            // scheduled transitions
  partitions: PartitionsOps       // monthly-partition mgmt
  adapters: AdaptersOps           // PSP adapter registry
  instruments: EngineInstruments  // metrics + tracer (Batch H)
  fx: FxOps                       // FX rate publish/lookup/history (Batch D)
  holds: HoldsOps                 // first-class holds (Batch E)
  disputes: DisputesOps           // first-class disputes (Batch E)
  forTenant(tenantId: string): TenantClient
  migrate(): Promise<readonly AppliedMigration[]>
  rollback(): Promise<void>
  migrations: readonly MigrationPlan[]
  migrator: Migrator
  connection: Connection
  decryptPayload(value: unknown): Promise<unknown>  // Batch B helper
  close(): Promise<void>
}
```

```ts
const engine = createEngine({
  schema,
  connection: { url: process.env.DATABASE_URL! },
  migration: { partitioning: 'monthly', tenancy: 'rls' },
  hasher: sha256Hasher,
})
await engine.migrate()
// ... use engine.forTenant(...) ...
await engine.close()
```

---

## Connections

### `openConnection` / `ConnectionInput`

```ts
openConnection(input: ConnectionInput): Connection

type ConnectionInput =
  | {
      url: string
      options?: postgres.Options       // postgres.js options
      readUrl?: string                 // optional read-replica URL
      readOptions?: postgres.Options
    }
  | { sql: postgres.Sql; readSql?: postgres.Sql } // bring your own pool
```

```ts
type Connection = {
  sql: postgres.Sql
  hasReplica: boolean
  withTenant<T>(tenantId, fn: (tx) => Promise<T>): Promise<T>          // sets RLS GUC
  withTenantReplica<T>(tenantId, fn): Promise<T>                       // routes to replica when configured
  asAdmin<T>(fn: (tx) => Promise<T>): Promise<T>                       // bypasses GUC
  close(): Promise<void>
}
```

Read paths in the runtime client (`findMany`, `trace`, `balance`, `verify`, `aggregate`, …) all route through `withTenantReplica`; writes use `withTenant`. The replica falls back to primary when `readUrl` isn't set.

### `withSearchPath`

```ts
withSearchPath(base: Connection, schemaName: string): Connection
```

Wraps a base connection so every per-tenant tx runs `SET LOCAL search_path = "<schemaName>", public`. The schema name is validated against `[a-z][a-z0-9_]{0,62}` to prevent SQL injection. `close()` is a no-op (the caller still owns the base).

```ts
import { openConnection, withSearchPath } from '@loki/core'

const base = openConnection({ url: DATABASE_URL })
const orgA = withSearchPath(base, 'loki_t_org_a')

const engine = createEngine({
  schema,
  connection: { url: DATABASE_URL },
  connectionFor: (id) => (id === 'org-a' ? orgA : null),
})
```

---

## Tenant client

```ts
engine.forTenant(tenantId: string): TenantClient

type TenantClient = {
  tenantId: string
  accounts: AccountOps
  transactions: RecordOps
  queries: QueryOps
}
```

### `accounts.*`

```ts
type AccountOps = {
  create(input: CreateAccountInput): Promise<AccountRow>
  get(identity: AccountIdentity): Promise<AccountRow | null>
  balance(identity: Omit<AccountIdentity, 'shardIndex'>): Promise<bigint>
  shards(identity: Omit<AccountIdentity, 'shardIndex'>): Promise<readonly AccountRow[]>
}

type CreateAccountInput = {
  actor: { type: string; id: string }
  name: string                  // declared on the actor
  parentAccountId?: string      // sub-accounts
}

type AccountIdentity = {
  actor: { type: string; id: string }
  name: string
  currency: CurrencyCode
  shardIndex?: number
}
```

```ts
await c.accounts.create({ actor: user, name: 'wallet' })
const balance = await c.accounts.balance({ actor: user, name: 'wallet', currency: 'NGN' })
```

### `transactions.*`

```ts
type RecordOps = {
  create(input: CreateRecordInput): Promise<CreateRecordResult>
  transition(input: TransitionInputArgs): Promise<TransitionResult>
  bulkTransition(items: readonly BulkTransitionItem[], opts?): Promise<{ results: ... }>
  get(id: string): Promise<TxnRecord | null>
  trace(id: string): Promise<readonly TxnTransition[]>
}

type CreateRecordInput = {
  type: string
  by: { type: string; id: string }
  participants: Record<string, { type: string; id: string }>
  data?: Record<string, unknown>      // `_init` payload
  idempotencyKey: string
  traceId?: string
}

type TransitionInputArgs = {
  id: string                          // record id
  name: string                        // transition name
  by: { type: string; id: string }
  data?: Record<string, unknown>
  withKey?: string                    // capability key id (uuid) — required for `needs:` transitions
  idempotencyKey: string
  traceId?: string
}

type TransitionResult = {
  record: TxnRecord
  transition: TxnTransition
  postings: readonly Posting[]
  unlocked: Record<string, string>    // keyName -> active key id
  replayed: boolean                   // true on idempotent replay
}

type BulkTransitionItem = TransitionInputArgs
```

```ts
const r = await c.transactions.transition({
  id: txn.record.id,
  name: 'pay',
  by: user,
  data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
  idempotencyKey: 'd9001:pay',
})
// r.unlocked.refund — capability key id, pass as withKey on refund
```

### `queries.*`

```ts
type QueryOps = {
  actor(actor: ActorRef): ActorScopedOps
  account: AccountQueryOps
  transactions: { findMany(args?: FindManyTransactionsArgs): Promise<Page<TxnRecord>> }
  transitions: { findMany(args?: FindManyTransitionsArgs): Promise<Page<TxnTransition>> }
  postings: { findMany(args?: FindManyPostingsArgs): Promise<Page<EnginePosting>> }
  anomalies: { findMany(args?: FindManyAnomaliesArgs): Promise<Page<AnomalyRow>> }
  verify(txnId: string, hasher: Hasher): Promise<VerifyResult>
}

type ActorScopedOps = {
  transactions(args?: ActorTransactionsArgs): Promise<Page<TxnRecord>>
  trails(args?: ActorTransactionsArgs): Promise<Page<{ record; trail }>>
  summary(args?: ActorSummaryArgs): Promise<ActorSummary>
  accounts(): Promise<readonly AccountRow[]>
}

type AccountQueryOps = {
  history(identity: Omit<AccountIdentity, 'shardIndex'>, args?: AccountHistoryArgs): Promise<Page<EnginePosting>>
  balanceAt(identity: Omit<AccountIdentity, 'shardIndex'>, when: Date | string): Promise<bigint>
  aggregate(identity: Omit<AccountIdentity, 'shardIndex'>, args: AccountAggregateArgs): Promise<AccountAggregate>
}

type AccountAggregateArgs = {
  since?: Date | string
  until?: Date | string
  metrics: readonly ('count' | 'sum_credit' | 'sum_debit' | 'min_amount' | 'max_amount')[]
}

type Page<T> = {
  items: readonly T[]
  nextCursor: string | null
}
```

Every list endpoint uses [keyset pagination](#cursors--pagination) — `OFFSET` is never generated.

```ts
const page = await c.queries.actor(driver).transactions({
  type: 'DeliveryPayment',
  state: ['completed', 'refunded'],
  since: '2026-04-01',
  limit: 50,
  cursor: prev?.nextCursor,
})
const stats = await c.queries.account.aggregate(
  { actor: driver, name: 'balance', currency: 'NGN' },
  { since, until, metrics: ['count', 'sum_credit', 'sum_debit'] },
)
```

---

## Admin ops

### `admin.tenants.*`

```ts
type TenantOps = {
  create(input: CreateTenantInput): Promise<TenantRow>
  suspend(id: string): Promise<TenantRow>
  activate(id: string): Promise<TenantRow>
  delete(id: string): Promise<TenantRow>
  get(id: string): Promise<TenantRow | null>
  list(): Promise<readonly TenantRow[]>
  export(id: string): Promise<TenantSnapshot>
  import(snapshot: TenantSnapshot, target?: Connection): Promise<void>
  relocate(args: {
    id: string
    target: Connection
    deleteFromSource?: boolean
  }): Promise<TenantSnapshot>
  provision(args: ProvisionTenantInput): Promise<ProvisionTenantResult>
}

type CreateTenantInput = {
  id: string
  name: string
  mode?: 'row' | 'schema' | 'db'    // default 'row'
}

type TenantRow = {
  id: string
  name: string
  mode: 'row' | 'schema' | 'db'
  state: 'active' | 'suspended' | 'deleted'
  createdAt: Date
}

type TenantSnapshot = {
  tenantId: string
  exportedAt: string
  tables: Record<string, readonly Record<string, unknown>[]>
}

type ProvisionTenantInput = {
  id: string
  mode: 'schema' | 'db' | 'row'
  target?: Connection                // required for 'db'; optional for 'schema'
  schemaName?: string                // override (default: loki_t_<sanitized id>)
}

type ProvisionTenantResult = {
  tenantId: string
  schemaName?: string
  applied: number                    // count of migrations applied
}
```

`provision()` runs `CREATE SCHEMA` (in `schema` mode) and migrates engine tables into the target. RLS mode is a no-op.

### `admin.schema.*`

```ts
type SchemaAdminOps = {
  versions(tenantId?: string): Promise<readonly SchemaVersionCount[]>
  findViolations(args: FindViolationsArgs): Promise<readonly ViolationHit[]>
}

type FindViolationsArgs = {
  tenantId?: string
  txnType: string
  transitionName?: string
  predicate: (transition: TxnTransition) => boolean   // returns TRUE for violators
  limit?: number                                       // default 1000
}

type ViolationHit = {
  recordId: string
  tenantId: string
  transition: TxnTransition
}

type SchemaVersionCount = { version: number; records: number; transitions: number }
```

---

## Reconciler

```ts
type Reconciler = {
  runOnce(options?: RunOnceOptions): Promise<RunOnceResult>
  start(options?: StartOptions): ReconcilerHandle
}

type RunOnceOptions = {
  tenantId?: string                  // default: every tenant
  quarantine?: boolean               // default true — mark records compromised on integrity-class anomalies
  repairBalanceDrift?: boolean       // default false — rebuild accounts.balance from postings
  fullSweep?: boolean                // default false — set true to ignore the watermark
}

type RunOnceResult = {
  anomalies: readonly AnomalyEvent[]
  quarantined: readonly string[]     // record ids
  repaired: readonly string[]        // account ids whose balance was rebuilt
  expiredKeys: number                // janitor stat
}

type StartOptions = {
  /** Shorthand for `schedule: { kind: 'continuous', intervalMs: N }`. */
  intervalMs?: number
  /** Schedule for incremental sweeps. Default: `{ kind: 'continuous', intervalMs: 60_000 }`. */
  schedule?: ReconcilerSchedule
  /** Optional separate schedule for full sweeps (`fullSweep: true`). */
  fullSweepSchedule?: ReconcilerSchedule
  tenantId?: string
  onError?: (e: unknown) => void
}

type ReconcilerSchedule =
  | { kind: 'continuous'; intervalMs: number }
  | { kind: 'daily'; at: string; tz?: 'local' | 'utc' }
  | { kind: 'weekly'; dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; at: string; tz?: 'local' | 'utc' }
  | { kind: 'monthly'; dayOfMonth: number; at: string; tz?: 'local' | 'utc' }

type ReconcilerHandle = {
  stop(): Promise<void>
  nextPass(): Promise<RunOnceResult>
}

// Pure helper exposed for testability; the reconciler is the only consumer.
nextFireMs(schedule: ReconcilerSchedule, now: Date): number
```

`at` is `HH:MM` or `HH:MM:SS` in 24h format. `dayOfWeek` follows the JS convention (`0` = Sunday). `dayOfMonth` is 1–31; if the target month is shorter, the fire time clamps to the last day (e.g. `dayOfMonth: 31` in February fires on the 28th/29th). `tz` defaults to `'utc'` — safer for distributed deployments.

```ts
// Simplest: continuous, 60s default
engine.reconciler.start()

// Continuous incremental + weekly full sweep on Sunday 02:00 UTC
engine.reconciler.start({
  schedule: { kind: 'continuous', intervalMs: 60_000 },
  fullSweepSchedule: { kind: 'weekly', dayOfWeek: 0, at: '02:00', tz: 'utc' },
})

// Daily at 03:30 in the host's local timezone
engine.reconciler.start({ schedule: { kind: 'daily', at: '03:30', tz: 'local' } })

// First of every month at midnight UTC
engine.reconciler.start({ schedule: { kind: 'monthly', dayOfMonth: 1, at: '00:00' } })
```

Six checks run on every pass — **all six are O(Δ) per pass** when watermarks are loaded:

| Check | Catches | Watermark axis |
|---|---|---|
| `balance_drift` | direct `accounts.balance` edits | `drift` (re-checks accounts whose postings moved) |
| `unbalanced_postings` | sum(D) ≠ sum(C) per transition, **per currency** | `transitions` |
| `checksum_mismatch` | postings inserted/edited/deleted | `transitions` |
| `hash_chain_break` | transition rows edited or inserted | `transitions` |
| `state_mismatch` | record `state` ≠ latest transition's `to_state` | `state` (re-checks records touched by new transitions) |
| `fabricated_key` | `txn_keys` row pointing at a non-existent transition | `keys` (re-checks keys granted by new transitions) |
| `fx_rate_drift` | rate-pinned transition disagrees with the FX table beyond `fxRateTolerance` (Batch D) | `transitions` |

Watermark state lives in `_loki_reconciler_state(key, watermark)` keyed by `<scope>:<axis>` (e.g. `org-1:transitions`, `org-1:drift`). All four advance to the highest transition id observed at the end of each pass. Use `fullSweep: true` for cold-row verification — typically scheduled via `fullSweepSchedule` on a weekly or monthly cadence.

#### Self-correction options (Batch C / M10)

Three opt-in repair flags on `runOnce`:

| flag | what it does | safety argument |
|---|---|---|
| `repairBalanceDrift` | rebuilds `accounts.balance` from postings | postings are the source of truth, balance is just a denorm |
| `repairStateMismatch` | bumps `txn_records.state` to the latest transition's `to_state` | the transitions table is the source of truth |
| `repairFabricatedKeys` | flips orphan keys `active` → `expired` and skips quarantine for that anomaly | the granting transition doesn't exist; the key cannot be legitimately consumed |

Hash-chain breaks, checksum mismatches, and unbalanced postings still quarantine — Loki cannot self-heal those without inventing data. The result fields `stateRepaired` and `fabricatedKeysExpired` list the affected ids.

---

## Payload encryption (Batch B / M6)

```ts
type PayloadCrypto = {
  encrypt(plaintextJson: string): string | Promise<string>   // returns base64 ciphertext
  decrypt(ciphertext: string): string | Promise<string>      // returns the original UTF-8 JSON
  algorithm?: string                                         // free-form tag, default 'aes-256-gcm'
}
```

**Pipeline.** `plaintext → canonicalize + hash chain → encrypt → store`. On read: `row → decrypt → canonicalize → re-hash → verify`.

**Where applied.** `txn_transitions.payload`, `outbox.payload`, `txn_anomalies.expected/observed`.

**Storage envelope.** A single-key object that JSONB stores transparently:

```json
{ "$encrypted": "v1:aes-256-gcm:<base64-ciphertext>" }
```

**Read paths.** Inside the engine API (`transition` results, `trace`, `queries.findMany`, outbox dispatch, reconciler hash verify) auto-decrypt. For raw rows (a direct SELECT against `txn_transitions`, an adapter inspecting an outbox row before processing), use `engine.decryptPayload(row.payload)` to recover the original.

**Hash chain.** Computed over the **plaintext** canonical form, so a key rotation never invalidates `row_hash`.

**No-crypto.** Default `undefined` — payloads are stored as plaintext JSON, byte-for-byte unchanged from the pre-Batch-B behaviour.

```ts
const engine = createEngine({
  schema,
  connection: { url },
  payloadCrypto: {
    encrypt: (json) => kms.encrypt(json),     // sync or async
    decrypt: (b64) => kms.decrypt(b64),
    algorithm: 'aes-256-gcm',
  },
})

// Adapter handler that reads raw outbox rows.
const event = await db`select payload from outbox where id = ${id}`
const plain = await engine.decryptPayload(event.payload)
```

---

## FX rates (Batch D / M16)

```ts
type FxOps = {
  publish(input: PublishFxRateInput): Promise<FxRate>
  lookup(input: LookupFxRateInput): Promise<FxRate | null>
  history(input: FxRateHistoryInput): Promise<readonly FxRate[]>
}

type FxRate = {
  id: string
  tenantId: string
  baseCurrency: string
  quoteCurrency: string
  rate: string             // numeric(38,18) as a string
  fixedAt: Date
  expiresAt: Date | null
  source: string
  createdAt: Date
}
```

Storage is `fx_rates(id, tenant_id, base_currency, quote_currency, rate numeric(38,18), fixed_at, expires_at?, source, created_at)`. Indexed on `(tenant_id, base, quote, fixed_at DESC)` for the lookup hot path.

```ts
await engine.fx.publish({
  tenantId: 'chidori',
  baseCurrency: 'USD',
  quoteCurrency: 'NGN',
  rate: '1500.0',
  source: 'cbn',
})
const rate = await engine.fx.lookup({ tenantId: 'chidori', baseCurrency: 'USD', quoteCurrency: 'NGN' })
```

**Reconciler check.** A transition that pins a rate via `data.rate` (decimal string) + `data.baseCurrency` + `data.quoteCurrency` is verified against the published rate **that was in effect at the transition's `occurred_at`** — not the current rate. The lookup uses:

- `fixed_at <= transition.occurred_at` (rate must have been published before the transition)
- `expires_at IS NULL OR expires_at > transition.occurred_at` (rate must not have expired by then)
- `source = transition.payload.rateSource` (when the transition pinned a specific feed — supports multi-source FX setups)

So old transitions pinned at an old rate keep verifying cleanly even after the rate changes. New rates only affect new transitions; back-publishing with `fixed_at` in the past does retroactively re-verify older transitions, which is what you want when correcting a feed error.

Two `fx_rate_drift` failure modes (discriminated by `observed.status`):

| `observed.status` | what happened |
|---|---|
| absent | published rate exists but differs from the pinned rate beyond `fxRateTolerance` (default `0.0001`) |
| `'no_rate_in_effect'` | no published rate matches the (base, quote, source) tuple at the transition's `occurred_at` — operator forgot to publish, `expires_at` coverage gap, or source typo |

Severity `error`; no quarantine — `fx_rate_drift` is a billing dispute, not an integrity break.

```ts
await engine.reconciler.runOnce({ tenantId: 'chidori', fxRateTolerance: 0.001 })
```

---

## Holds and disputes (Batch E / M17)

First-class storage tables with helper APIs. Schema-DSL primitives (`defineHold`, `defineDispute`) are a follow-up — for now, operators wire holds and disputes around capability keys + the existing scheduler.

### Holds

```ts
type HoldsOps = {
  place(input: PlaceHoldInput): Promise<Hold>
  release(input: ReleaseHoldInput): Promise<Hold>
  expireDue(now?: Date): Promise<ExpireHoldsResult>
  get(id: string): Promise<Hold | null>
  list(args: { tenantId: string; status?: HoldStatus; limit?: number }): Promise<readonly Hold[]>
}

type Hold = {
  id: string
  tenantId: string
  txnId: string | null
  holdAccountId: string
  amount: bigint
  status: 'placed' | 'released' | 'expired' | 'captured'
  expiresAt: Date | null
  releasedByTransitionId: string | null
  placedAt: Date
  releasedAt: Date | null
}
```

`release` is idempotent (second call returns the row unchanged). `expireDue` flips `placed` → `expired` for every hold whose `expires_at` has passed; run from a scheduler tick.

### Disputes

```ts
type DisputesOps = {
  open(input: OpenDisputeInput): Promise<Dispute>
  resolve(input: ResolveDisputeInput): Promise<Dispute>
  expireDue(now?: Date): Promise<ExpireDisputesResult>
  get(id: string): Promise<Dispute | null>
  list(args: { tenantId: string; status?: DisputeStatus; limit?: number }): Promise<readonly Dispute[]>
}

type Dispute = {
  id: string
  tenantId: string
  originalTransitionId: string
  status: 'open' | 'resolved_customer' | 'resolved_merchant' | 'expired'
  openedAt: Date
  deadlineAt: Date | null
  resolvedAt: Date | null
  resolution: string | null
  reason: string | null
}
```

`resolve({ outcome: 'customer' | 'merchant' })` flips the status and stamps `resolved_at`. The engine doesn't drive the refund transition itself — operators wire that via their declared transitions; this just stamps the dispute closed.

---

## Read-your-writes (Batch G)

```ts
type ReadYourWritesMode = 'auto' | 'off'

createEngine({
  schema,
  connection: { url, readUrl, readYourWrites: 'auto' },
})
// or, equivalently, on EngineOptions:
createEngine({ schema, connection: { url, readUrl }, readYourWrites: 'auto' })
```

When `'auto'` and a read replica is configured, every primary write captures `pg_current_wal_lsn()` in an `AsyncLocalStorage` context. The next replica-eligible read in the same async chain probes the replica's `pg_last_wal_replay_lsn()`; if the replica hasn't caught up, the read transparently falls back to the primary.

Default `'off'` — the historical behaviour. No-op when there's no replica.

The `compareLsn(a, b)` helper is exported for tests.

---

## Observability (Batch H)

```ts
type Counter = { inc(value?: number, labels?: MetricLabels): void }
type Histogram = { observe(value: number, labels?: MetricLabels): void }
type Gauge = {
  set(value: number, labels?: MetricLabels): void
  inc(value?: number, labels?: MetricLabels): void
  dec(value?: number, labels?: MetricLabels): void
}

type MetricsAdapter = {
  counter(name: string, help?: string): Counter
  histogram(name: string, help?: string, buckets?: readonly number[]): Histogram
  gauge(name: string, help?: string): Gauge
}

type Tracer = {
  startSpan(name: string, attributes?: MetricLabels): Span
}

type Span = {
  setAttribute(key: string, value: string | number | boolean): void
  setStatus(status: 'ok' | 'error', message?: string): void
  recordException(error: unknown): void
  end(): void
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>

type Logger = {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fieldsOrError?: LogFields | Error, error?: Error): void
  child(fields: LogFields): Logger
}
```

The metric/tracer shapes match Prometheus (counter / histogram / gauge) and OpenTelemetry (`Tracer.startSpan`). The logger shape is a deliberate subset of pino / winston / bunyan so adapting any of them is a one-line wrapper. Without a config, the engine uses no-op shims (`NOOP_METRICS`, `NOOP_TRACER`, `NOOP_LOGGER`) so call sites compile to nothing.

**`consoleLogger(opts?)`** — convenience JSON-per-line logger for development. Records on stdout, error/warn on stderr. Default level `'info'`; pass `{ level: 'debug' }` for full chatter.

**Engine operational events emitted via the logger:**

| level | message | when |
|---|---|---|
| info | `engine constructed` | `createEngine` returns |
| info | `engine closing` | `engine.close()` enters |
| info | `migrations applied` | `engine.migrate()` succeeds (with `count`, `durationMs`) |
| error | `migration apply failed` | `engine.migrate()` throws |
| info | `migration rolled back` | `engine.rollback()` succeeds |
| error | `migration rollback failed` | `engine.rollback()` throws |
| debug | `reconciliation pass clean` | `runOnce` finishes with zero anomalies |
| info | `reconciliation pass found anomalies` | non-critical anomalies present |
| warn | `reconciliation pass finished with critical anomalies` | hash-chain breaks etc. |
| warn | `outbox dispatch transient failure` | a dispatch threw but the row will retry |
| error | `outbox dispatch failed terminally` | dispatch hit `maxAttempts` |

**Pre-built instruments** (`engine.instruments.*`):

| name | kind | when |
|---|---|---|
| `loki_transition_duration_ms` | histogram | every transition (labeled by `name`) |
| `loki_transition_errors_total` | counter | every transition that throws (labeled by error class) |
| `loki_reconciler_duration_ms` | histogram | every reconciliation pass (labeled `full_sweep`) |
| `loki_reconciler_anomalies_total` | counter | per recorded anomaly (labeled `check`, `severity`) |
| `loki_outbox_dispatch_success_total` | counter | every successful outbox dispatch (labeled `event`) |
| `loki_outbox_dispatch_failure_total` | counter | every failed dispatch (labeled `event`, `terminal`) |
| `loki_scheduler_fires_total` | counter | every scheduled fire (labeled `status`) |

```ts
import { createEngine, type MetricsAdapter, type Tracer } from '@loki/core'

const metrics: MetricsAdapter = makePromBridge()
const tracer: Tracer = otelTracer

const engine = createEngine({ schema, connection, metrics, tracer })
```

---

## Scheduler

```ts
type Scheduler = {
  create(input: CreateScheduledTransitionInput): Promise<ScheduledTransition>
  cancel(id: string, opts?: { tenantId?: string }): Promise<boolean>
  list(filter?: ListScheduledFilter): Promise<readonly ScheduledTransition[]>
  runDue(options?: RunDueOptions): Promise<RunDueResult>
  startWorker(options?: SchedulerWorkerOptions): SchedulerWorkerHandle
}

type CreateScheduledTransitionInput = {
  tenantId: string
  txnId: string
  name: string
  runAt: Date
  by: { type: string; id: string }
  data?: Record<string, unknown>
  withKey?: string                       // capability key for `needs:` transitions
  idempotencyKey: string
}

type ScheduledTransition = {
  id: string
  tenantId: string
  txnId: string
  name: string
  runAt: Date
  actor: { type: string; id: string }
  payload: Record<string, unknown>
  withKey: string | null
  idempotencyKey: string
  status: 'pending' | 'completed' | 'cancelled' | 'failed'
  attempts: number
  lastError: string | null
  firedAt: Date | null
  firedTransitionId: string | null
  createdAt: Date
}

type RunDueOptions = {
  tenantId?: string
  batchSize?: number    // default 50
  now?: Date            // override clock (tests)
}

type RunDueResult = {
  fired: readonly string[]                       // ids that landed
  failed: readonly { id: string; error: string }[]
}
```

Each tick claims `pending` rows whose `run_at <= now()` with `FOR UPDATE SKIP LOCKED` so multiple workers can run safely. The downstream transition uses `_scheduled:<schedId>` as its idempotency key — a worker restart between fire and commit re-drives the same transition idempotently.

---

## Partitions

```ts
type PartitionsOps = {
  ensureFor(date: Date, options?: EnsureForOptions): Promise<readonly EnsuredPartition[]>
  list(table: PartitionTable, options?: { tablePrefix?: string }): Promise<readonly { partitionName; bounds }[]>
}

type PartitionTable = 'txn_transitions' | 'postings'

type EnsureForOptions = {
  monthsAhead?: number                  // default 0
  tablePrefix?: string                  // default ''
}

type EnsuredPartition = {
  table: PartitionTable
  partitionName: string                 // <prefix><table>_y<YYYY>m<MM>
  fromInclusive: string                 // YYYY-MM-01
  toExclusive: string
  created: boolean                      // false on idempotent re-run
}
```

Only relevant when the engine is created with `migration: { partitioning: 'monthly' }`. The migrator creates the parent tables `PARTITION BY RANGE (occurred_at)` plus a `<table>_default` partition; concrete monthly partitions are provisioned on demand.

```ts
// Cron task: keep 3 months ahead provisioned
await engine.partitions.ensureFor(new Date(), { monthsAhead: 3 })
```

---

## Outbox

```ts
type OutboxOps = {
  startWorker(options?: OutboxWorkerOptions): OutboxWorkerHandle
  drainOnce(options?: OutboxWorkerOptions): Promise<number>
}

type OutboxWorkerOptions = {
  handler?: (event: OutboxEvent) => Promise<void> | void
  batchSize?: number              // default 100
  maxAttempts?: number            // default 5
  backoff?: (nextAttempt: number) => number  // capped exponential w/ jitter
  intervalMs?: number             // default 1_000
  onError?: (e: unknown) => void
}

type OutboxEvent = {
  id: string
  tenantId: string
  txnId: string
  transitionId: string
  event: string                   // schema-declared `emit` value
  intent: string | null           // adapter-routable intent
  payload: Record<string, unknown>
  attempts: number
  nextAttemptAt: Date
}

type OutboxWorkerHandle = {
  stop(): Promise<void>
  drainOnce(): Promise<number>
}
```

Routing rules per event:

1. If `intent` matches a registered adapter (intent prefix === adapter name), the adapter's outbound handler runs.
2. Otherwise, the consumer-supplied `handler` runs.
3. If neither matches, the event stays delivered (silently consumed).

Terminal failure (after `maxAttempts`) fires the `onOutboxFailureTerminal` hook.

---

## Adapters

### `engine.adapters` registry

```ts
type AdaptersOps = {
  register(adapter: AdapterContract): void          // throws on duplicate name
  unregister(name: string): boolean
  get(name: string): AdapterContract | undefined
  list(): readonly AdapterContract[]
  handleInbound(
    adapterName: string,
    eventName: string,
    payload: unknown,
    ctx: AdapterInboundContext,
  ): Promise<AdapterInboundResult>
}
```

### `defineAdapter`

From `@loki/adapter-sdk`:

```ts
defineAdapter(definition: AdapterDefinition): Adapter

type AdapterDefinition = {
  name: string                                                        // intent prefix
  outbound?: Record<string, OutboundHandler>                          // intent suffix -> handler
  inbound?: Record<string, InboundMapper>                             // event name -> mapper
}

type OutboundHandler = (event: OutboxEvent, ctx: OutboundContext) => Promise<void> | void

type OutboundContext = {
  confirm(action: TransitionAction): Promise<void>
  fail(action: TransitionAction): Promise<void>
  outboxId: string
  tenantId: string
}

type TransitionAction = {
  transition: string
  data?: Record<string, unknown>
  by?: ActorRef                                                       // default { type:'System', id: '<adapter>' }
  idempotencyKey?: string                                             // default <outboxId>:confirm|fail
  withKey?: string
  traceId?: string
}

type InboundMapper<TPayload = unknown> = (event: TPayload) => InboundResult | Promise<InboundResult>

type InboundResult = {
  transition: string
  txnId: string
  data?: Record<string, unknown>
  by?: ActorRef
  idempotencyKey: string
  withKey?: string
  traceId?: string
}
```

Outbox events with `intent: '<name>.<key>'` route to the adapter's `outbound[<key>]` handler. Adapters call `confirm()` or `fail()` to drive a follow-up Loki transition; that transition is itself recorded, balanced, and hash-chained.

```ts
import { defineAdapter } from '@loki/adapter-sdk'

const stripeAdapter = defineAdapter({
  name: 'stripe',
  outbound: {
    'capture': async (event, { confirm, fail }) => {
      try {
        const r = await stripe.paymentIntents.capture(event.payload.id, {
          idempotencyKey: event.id,
        })
        await confirm({ transition: 'mark_captured', data: { stripe_id: r.id } })
      } catch (e) {
        if (e.code === 'card_declined') {
          await fail({ transition: 'mark_capture_failed', data: { reason: e.message } })
        } else {
          throw e // outbox retries with backoff
        }
      }
    },
  },
  inbound: {
    'payment_intent.succeeded': (event) => ({
      transition: 'mark_funded',
      txnId: event.data.object.metadata.txnId,
      idempotencyKey: `stripe:${event.id}`,
      data: { psp_reference: event.data.object.id, amount: event.data.object.amount },
    }),
  },
})

engine.adapters.register(stripeAdapter)
engine.outbox.startWorker()

// Inside your webhook handler:
await engine.adapters.handleInbound('stripe', body.type, body, {
  engine,
  tenantId,
})
```

### `createMockedPsp`

From `@loki/adapter-mocked` — deterministic, in-memory PSP for tests.

```ts
createMockedPsp(options: CreateMockedPspOptions): MockedPsp

type CreateMockedPspOptions = {
  transitions: Record<string, { success: string; failure: string }>
  inbound?: Record<string, (event: Record<string, unknown>) => InboundResult>
  name?: string                       // default 'mocked'
}

type MockedPsp = {
  adapter: Adapter
  queue(action: string, outcome: MockedOutcome): void
  callCount(action: string): number
  reset(): void
  buildInbound<P>(eventName: string, payload: P): { eventName; payload }
}

type MockedOutcome =
  | { kind: 'success'; data: Record<string, unknown> }
  | { kind: 'failure'; data: Record<string, unknown> }
  | { kind: 'transient'; error: Error }     // outbox retries with backoff
```

```ts
const psp = createMockedPsp({
  transitions: { charge: { success: 'mark_funded', failure: 'mark_failed' } },
})
engine.adapters.register(psp.adapter)

psp.queue('charge', { kind: 'success', data: { reference: 'pi_test', amount: 1500n } })
await engine.outbox.drainOnce()
expect(psp.callCount('charge')).toBe(1)
```

---

## Hooks

```ts
type HookRegistry = {
  beforeTransition(filter, handler): Unsubscribe        // SYNC, can throw to abort
  afterTransition(filter, handler): Unsubscribe         // post-commit, async OK
  onAnomaly(filter, handler): Unsubscribe
  onIntegrityViolation(filter, handler): Unsubscribe    // critical-only subset of anomaly
  onQuarantine(filter, handler): Unsubscribe
  onReversal(filter, handler): Unsubscribe              // when an `invert:` transition lands
  onOutboxFailureTerminal(filter, handler): Unsubscribe
  onReconciliationComplete(filter, handler): Unsubscribe
  onSchemaMigration(filter, handler): Unsubscribe
  onTenantLifecycle(filter, handler): Unsubscribe       // create/suspend/activate/delete/relocate
  onHookFailure(handler): Unsubscribe                   // catches throws from other hooks
}

type HookFilter<E> = ((event: E) => boolean) | {
  severity?: 'warn' | 'error' | 'critical'
  check?: AnomalyCheckName | readonly AnomalyCheckName[]
  tenantId?: string | readonly string[]
  txnType?: string | readonly string[]
} | undefined

type HookHandler<E> = (event: E) => Promise<void> | void

// Tunable on the registry (or via EngineOptions.hooks)
type HookRegistryOptions = {
  /** Max time a beforeTransition handler can run. Default 1000ms; null to disable. */
  beforeTransitionTimeoutMs?: number | null
}

createHookRegistry(options?: HookRegistryOptions): HookRegistry

// Thrown when a beforeTransition handler exceeds the timeout
class BeforeTransitionTimeoutError extends Error {
  readonly timeoutMs: number
}
```

Pass `undefined` for `filter` to match every event. All hooks fire — multiple handlers compose. Errors inside a hook are caught and routed to `onHookFailure` (they never block the engine), except `beforeTransition` whose throw aborts the in-progress transition.

`beforeTransition` runs **inside** the transition's DB tx, so a slow handler would hold row locks. Each invocation races against `beforeTransitionTimeoutMs` (default 1000ms). On timeout, the handler is rejected with `BeforeTransitionTimeoutError` and the tx aborts via the same path as an explicit `RejectTransition`. Long-running work belongs in `afterTransition` (post-commit, async) or an outbox handler.

```ts
// Engine-level configuration
const engine = createEngine({
  schema,
  connection,
  hooks: { beforeTransitionTimeoutMs: 250 }, // tighten the default
})

// Or disable entirely (NOT recommended in production)
const engine = createEngine({
  schema, connection,
  hooks: { beforeTransitionTimeoutMs: null },
})
```

```ts
engine.hooks.onAnomaly({ severity: 'critical' }, async (a) => {
  await pagerduty.trigger({ severity: 'P1', details: a })
})

engine.hooks.beforeTransition(
  { txnType: 'DeliveryPayment', name: 'pay' } as never,    // typed event
  async ({ data, tenantId }) => {
    if (tenantId === 'org-ng' && !withinBusinessHours()) {
      throw new RejectTransition('outside business hours')
    }
  },
)

engine.hooks.onHookFailure((e) => sentry.capture(e))
```

### Authenticating the actor (H4)

`input.by` (`{ type, id }`) is **caller-supplied and unauthenticated** by the engine — the type signature accepts whatever the application passes. If your HTTP frontend forwards `req.body.actor` directly to `transactions.transition()`, anyone with HTTP access can impersonate any actor. The engine has no notion of "the authenticated user" because identity is upstream.

Two recommended patterns:

```ts
// 1) Validate the actor against your auth context inside beforeTransition.
//    Cheap, runs inside the transition tx, aborts on mismatch.
engine.hooks.beforeTransition(undefined, async ({ actor, tenantId, signal }) => {
  const ctx = currentRequestContext() // your AsyncLocalStorage / kernel etc.
  if (!ctx) throw new RejectTransition('no auth context')
  if (ctx.tenantId !== tenantId) throw new RejectTransition('tenant mismatch')
  if (`${actor.type}:${actor.id}` !== `${ctx.actor.type}:${ctx.actor.id}`) {
    throw new RejectTransition('actor mismatch')
  }
  // signal is aborted on timeout; honor it for fetch() etc.
})

// 2) Wrap the engine in a thin "authorized client" so callers can't
//    pass `by` at all — the wrapper fills it from the auth context.
function authorizedClient(engine: Engine, ctx: AuthContext) {
  const c = engine.forTenant(ctx.tenantId)
  return {
    create: (input: Omit<CreateRecordInput, 'by'>) =>
      c.transactions.create({ ...input, by: ctx.actor }),
    transition: (input: Omit<TransitionInputArgs, 'by'>) =>
      c.transactions.transition({ ...input, by: ctx.actor }),
  }
}
```

The library deliberately doesn't ship an `AuthContext` type because identity is application-shaped — JWT claims, session ids, mTLS certs, IAM principals all model "who is this" differently. Pick the pattern that matches your auth system.

### Event payloads (selected)

```ts
type AnomalyEvent = {
  id: string
  detectedAt: Date
  tenantId: string
  check: 'balance_drift' | 'unbalanced_postings' | 'hash_chain_break'
       | 'checksum_mismatch' | 'state_mismatch' | 'fabricated_key'
  severity: 'warn' | 'error' | 'critical'
  txnId?: string
  txnType?: string
  accountId?: string
  expected: unknown
  observed: unknown
  context?: Record<string, unknown>
}

type QuarantineEvent = {
  tenantId: string
  recordId: string
  txnType: string
  reason: AnomalyEvent
}

type TenantLifecycleEvent = {
  tenantId: string
  action: 'created' | 'suspended' | 'activated' | 'deleted' | 'relocated'
  mode: 'row' | 'schema' | 'db'
  at: Date
}

type ReconciliationCompleteEvent = {
  startedAt: Date
  finishedAt: Date
  anomaliesFound: number
  quarantined: number
  tenantId?: string
  fullSweep: boolean
}
```

---

## Sagas

```ts
runSaga(definition: SagaOptions, ctx: SagaContext): Promise<SagaResult>

type SagaOptions = {
  steps: readonly SagaStep[]
  rollback?: 'auto' | 'manual'         // default 'auto'
}

type SagaStep = {
  name: string
  forward: (ctx: SagaContext) => Promise<unknown>
  compensate?: (ctx: SagaContext) => Promise<void>
}

type SagaResult =
  | { ok: true; index: number; result: TransitionResult }
  | { ok: false; failedAt: number; error: unknown; compensated: readonly number[] }
```

`runSaga` runs each step; on failure, the previously-completed steps' `compensate` callbacks fire in reverse. The four invariants still hold inside each step — sagas are sequences of normal transitions.

```ts
import { runSaga, isSagaSuccess } from '@loki/core'

const result = await runSaga({
  steps: [
    {
      name: 'charge',
      forward: async () => clientA.transactions.transition({ ... }),
      compensate: async () => clientA.transactions.transition({ name: 'refund', ... }),
    },
    {
      name: 'payout',
      forward: async () => clientB.transactions.transition({ ... }),
    },
  ],
}, ctx)

if (!isSagaSuccess(result)) {
  console.error('saga failed at step', result.failedAt, result.error)
}
```

---

## Migrations & DDL

### `MigrationOptions`

```ts
type MigrationOptions = {
  tenancy?: TenancyMode                            // default 'rls'
  appRole?: string                                 // default 'ledger_app'
  adminRole?: string                               // default 'ledger_admin'
  tablePrefix?: string                             // default ''
  partitioning?: PartitioningStrategy              // default 'none'
}

type TenancyMode = 'rls' | 'schema-per-tenant' | 'database-per-tenant'
type PartitioningStrategy = 'none' | 'monthly'
```

### Migrator

```ts
type Migrator = {
  apply(plans: readonly MigrationPlan[]): Promise<readonly AppliedMigration[]>
  applyOn(target: Connection, plans: readonly MigrationPlan[]): Promise<readonly AppliedMigration[]>
  status(plans: readonly MigrationPlan[]): Promise<MigratorStatus>
  rollback(plan: MigrationPlan): Promise<void>
}

type AppliedMigration = { id: string; checksum: string; applied_at: Date }
type MigratorStatus = { applied: readonly AppliedMigration[]; pending: readonly MigrationPlan[] }
```

### Low-level DDL helpers (advanced)

These are exported for tooling that wants to emit SQL without touching a DB:

```ts
planInitialMigration(schema: SchemaDef, options?: MigrationOptions): MigrationPlan

buildTablesSql(schema, options): string[]
buildIndexesSql(options): string[]
buildRolesSql(options): string[]
buildGrantsSql(options): string[]
buildRlsSql(options): string[]
buildDropTablesSql(options, schema?): string[]
buildDropIndexesSql(options): string[]
buildDropRolesSql(options): string[]
buildDropRlsSql(options): string[]

resolveOptions(input?: MigrationOptions): ResolvedMigrationOptions
```

---

## Currency & primitive helpers

```ts
type CurrencyCode = string                         // 'NGN', 'USD', 'EUR', …

const ZERO: bigint                                 // 0n alias
isPositive(n: bigint): boolean                     // n > 0
isNonNegative(n: bigint): boolean                  // n >= 0

// Two formatMinor overloads
formatMinor(amount: bigint, decimals?: number): string                                 // 150_000n -> "1500.00"
formatMinor(amount: bigint, code: CurrencyCode, currencies: CurrencyMap): string       // looks up decimals
```

### Precision & rounding (Batch F)

```ts
type RoundingMode = 'banker' | 'half-up' | 'half-down' | 'truncate' | 'ceil' | 'floor'

type CurrencyMeta = {
  code: CurrencyCode
  decimals: number          // 0–18
  rounding: RoundingMode
  name?: string             // display only
  symbol?: string           // display only
}

defineCurrency(code, options?): CurrencyMeta
defineCurrencyMap(input): ReadonlyMap<CurrencyCode, CurrencyMeta>

// Always sums back to `total` — no precision is lost.
splitAmount(total: bigint, parts: number, rounding?: RoundingMode): bigint[]
```

Examples:

```ts
const currencies = defineCurrencyMap({
  NGN: { decimals: 2, rounding: 'banker' },
  BTC: { decimals: 8, rounding: 'truncate' },
})

formatMinor(150_000n, 'NGN', currencies)  // "1500.00"
formatMinor(150_000n, 'BTC', currencies)  // "0.00150000"

splitAmount(1000n, 3, 'banker')   // [334n, 333n, 333n]
splitAmount(1000n, 3, 'truncate') // [334n, 333n, 333n] — residual on first
splitAmount(1000n, 3, 'floor')    // [333n, 333n, 334n] — residual on tail
```

The metadata is purely advisory at the engine layer — postings are always integer minor units. Use it for display, splits, and any FX conversion the consumer drives.

Postings:

```ts
isBalanced(postings: readonly Posting[]): boolean
sumByDirection(postings): { debits: bigint; credits: bigint }
sumByDirectionPerCurrency(postings): Map<CurrencyCode, { debits; credits }>
```

ULIDs:

```ts
ulid(): string                                     // monotonic ULID
ULID_REGEX: RegExp
```

Hashing:

```ts
sha256Hasher: Hasher

type Hasher = {
  algorithm: string
  digest(input: Uint8Array): Uint8Array
}

computeRowHash(hasher, content, prevHash: Buffer | null): Buffer
computePostingsChecksum(hasher, postings): Buffer
canonicalize(value): string                        // canonical JSON for hashing
canonicalizeToString(value): string
```

---

## Cursors & pagination

```ts
type Cursor = string                               // opaque base64 of (occurredAt, id)

encodeCursor(state: { occurredAt: Date; id: string }): Cursor
decodeCursor(cursor: Cursor): { occurredAt: Date; id: string }

type Page<T> = {
  items: readonly T[]
  nextCursor: Cursor | null
}

type Order = 'asc' | 'desc'
```

Every list endpoint accepts `limit` (default varies; 50–100) and `cursor` (opaque). `OFFSET` is never generated.

```ts
let cursor: string | undefined
do {
  const page = await c.queries.transactions.findMany({ limit: 1000, cursor })
  for (const t of page.items) processOne(t)
  cursor = page.nextCursor ?? undefined
} while (cursor)
```

---

## Errors

All engine errors extend `LokiError`:

```ts
class LokiError extends Error
class UnknownTransitionError extends LokiError
class IllegalStateTransitionError extends LokiError
class ActorNotPermittedError extends LokiError
class KeyAlreadyConsumedError extends LokiError
class UnbalancedPostingsError extends LokiError      // .currency: string | null
class CompromisedRecordError extends LokiError       // .recordId: string
class ConcurrencyConflictError extends LokiError
class InvalidPostingError extends LokiError          // .reason: string
class OverdraftError extends LokiError               // .accountId, .currentBalance, .attemptedDelta (M1)
class RejectTransition extends LokiError             // throw inside beforeTransition
class MigrationMismatchError extends LokiError
class DatabaseError extends LokiError                // .cause: unknown
class CanonicalizationError extends LokiError
class SchemaError extends Error                      // .issues: SchemaIssue[]
class BeforeTransitionTimeoutError extends Error     // .timeoutMs: number
```

```ts
try {
  await c.transactions.transition({ ... })
} catch (e) {
  if (e instanceof KeyAlreadyConsumedError) {
    // refund key already used — surface to the user
  } else if (e instanceof CompromisedRecordError) {
    // record is quarantined; reconciler must clear it first
  } else if (e instanceof LokiError) {
    // any other engine-emitted error
  } else {
    throw e
  }
}
```

---

## CLI

The `loki` binary ships from `@loki/cli`. Every command resolves a `loki.config.{js,mjs,ts}` from the cwd (or `--config <path>`).

```
loki migrate apply
loki migrate plan
loki migrate rollback
loki migrate status
loki migrate enforce <enforcer-name> [--tenant <id>] [--limit N]

loki reconcile [--tenant <id>] [--no-quarantine]

loki tenant create <id> --name <name>
loki tenant list
loki tenant get <id>
loki tenant suspend <id>
loki tenant activate <id>
loki tenant delete <id>
loki tenant dashboard <id>

loki schema versions [--tenant <id>]
loki schema diff --from <other-config-path>

loki anomalies list --tenant <id> [--severity warn|error|critical] [--check <name>] [--unresolved] [--limit N]
loki anomalies resolve <id> --tenant <id> --by <name> --note <text>

loki trace <txnId> --tenant <id> [--verify]

loki --help
loki --config <path> <command>
```

Exit codes:

- `0` — success
- `1` — command-level failure (anomalies detected, missing tenant, violations found, hash chain broken, …)
- `2` — invalid usage (missing required flag, unknown subcommand, …)

### Programmatic CLI runners

The CLI is also importable. Useful for in-process tests and bespoke ops scripts.

```ts
import { run, bufferedIo, type LokiConfig } from '@loki/cli'

const io = bufferedIo()
const code = await run({
  args: ['anomalies', 'list', '--tenant', 'org-1'],
  io,
  config: cfg,
})
console.log(io.stdout())
```

Individual command runners are exported too: `runMigrate`, `runReconcile`, `runSchema`, `runTenant`.

---

## CLI config

### `LokiConfig`

```ts
type LokiConfig = {
  schema: SchemaDef                 // your defined schema
  connection: ConnectionInput
  migration?: MigrationOptions
  enforcers?: Record<string, LokiEnforcer>   // for `loki migrate enforce`
}

type LokiEnforcer = {
  txnType: string
  transitionName?: string
  predicate: (transition: TxnTransition) => boolean
  description?: string
}
```

### Example `loki.config.ts`

```ts
import schema from './ledger.schema'
import type { LokiConfig } from '@loki/cli'

const config: LokiConfig = {
  schema,
  connection: { url: process.env.DATABASE_URL ?? '' },
  migration: { partitioning: 'monthly' },
  enforcers: {
    min_pay_amount: {
      txnType: 'DeliveryPayment',
      transitionName: 'pay',
      description: 'New rule: pay.amount must be ≥ 1000',
      predicate: (t) => {
        const raw = (t.payload as { amount?: { $bigint?: string } }).amount
        return !!raw?.$bigint && BigInt(raw.$bigint) < 1000n
      },
    },
  },
}

export default config
```

```sh
loki migrate enforce min_pay_amount --tenant org-acme
```

Exit code 1 with the list of violators when any are found — wire it into CI to block schemas that orphan live records.

### `loadConfig`

```ts
loadConfig(input?: { path?: string; cwd?: string }): Promise<LokiConfig>
```

Auto-discovers `loki.config.{js,mjs,ts}` from `cwd`, or loads `path` directly. The module must `export default` a `LokiConfig`.

---

## Hasher

```ts
type Hasher = {
  algorithm: string                    // e.g. 'sha256'
  digest(input: Uint8Array): Uint8Array
}

const sha256Hasher: Hasher
```

The default is SHA-256. You can plug in BLAKE3 (or anything) by implementing the interface and passing it as `EngineOptions.hasher`. The hash chain and posting checksums use this throughout — *don't* change it on a deployed engine without a migration plan; existing rows would no longer verify.

---

## Constants

```ts
const TENANT_GUC          = 'loki.tenant_id'      // RLS session GUC name
const ENGINE_TENANT_GUC                            // alias re-exported by the engine
const MIGRATIONS_TABLE    = '_loki_migrations'
const RECONCILER_STATE_TABLE = '_loki_reconciler_state'
const NONE_STATE                                   // sentinel for `<none>` in transition `from`
const DEFAULT_SEVERITY    = { … }                  // anomaly check → severity map
const ENGINE_TABLES       = readonly [
  'tenants', 'accounts', 'txn_records', 'txn_transitions',
  'txn_keys', 'postings', 'outbox', 'txn_anomalies', 'txn_scheduled',
] as const
const DEFAULT_MIGRATION_OPTIONS: ResolvedMigrationOptions
const ULID_REGEX: RegExp
const LOKI_CORE_VERSION: string
```

SQL helpers (advanced — needed only when emitting custom DDL alongside the engine):

```ts
ident(name: string): string         // safe identifier quoting
literal(value: unknown): string
literalString(s: string): string
inList(values: readonly string[]): string
trimSql(s: string): string
SqlError                            // class — thrown by ident() on invalid input
```

---

## Adapter package re-exports

Every `@loki/adapter-*` package re-exports the SDK types it relies on. If you're writing your own adapter, importing from `@loki/adapter-sdk` directly is the recommended path; the engine consumes whatever satisfies the `Adapter` shape.

```ts
import { defineAdapter, type OutboundContext, type InboundResult } from '@loki/adapter-sdk'
import type { OutboxEvent, ActorRef } from '@loki/core'
```

---

## Versioning

`@loki/core` is the source of truth for the public surface. All other packages' versions track the `core` major version they're compatible with. Schema-level `version` (`defineSchema({ version: 2, ... })`) is **independent** — it tracks your application's transaction shape, not the library version. Bump it on every additive or rename change so old records keep their original semantics; never decrement it.
