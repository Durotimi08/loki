# Loki

> Schema-agnostic transaction tracking & bookkeeping for Postgres — *Prisma for money-movement records.*

You declare your transaction shapes, actors, accounts, and rules in a TypeScript schema. Loki gives you a typed runtime that handles the bookkeeping correctly by construction: idempotency, audit logging, state-transition guards, double-entry invariants, capability gating, multi-tenancy, reconciliation, tamper detection, and adapter-mediated PSP integration. Application code shrinks to *"drive this transition, here's the actor, here's the payload, here's the idempotency key."*

```ts
const c = engine.forTenant('chidori')
const txn = await c.transactions.create({
  type: 'DeliveryPayment',
  by: user,
  participants: { user, driver, company },
  idempotencyKey: 'd9001:create',
})
await c.transactions.transition({
  id: txn.record.id,
  name: 'pay',
  by: user,
  data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
  idempotencyKey: 'd9001:pay',
})
```

That single call writes the audit row, posts the four debits/credits, mints the `refund` capability key, drops a `delivery.paid` outbox row, updates account balances, and commits — atomically, in one DB transaction, with hash-chain integrity. Replay it with the same idempotency key and it's a no-op.

---

## What you stop writing yourself

- Idempotency middleware, audit/event tables, state-transition guards
- Double-entry bookkeeping invariants, per-actor permission checks
- Reconciliation queries, tamper detection on financial tables
- Outbox + retry worker (`FOR UPDATE SKIP LOCKED`) for adapter integration
- Concurrency control across distributed processes
- Tenant isolation policies (RLS, schema-per-tenant, db-per-tenant)
- Anomaly alerting & escalation routing
- Schema migration plans for evolving transaction shapes
- Per-actor and per-account query layers
- Cursor-based pagination, indexes, partitioning, read-replica routing
- Trace / breakdown views for support and ops

---

## When Loki is the right tool

**Use it when** you're tracking money-movement records and need: state machines per record, double-entry postings, idempotent operations, audit trails, multi-tenancy, integration with PSPs (Stripe / Paystack / Flutterwave / NIBSS / Plaid / your own), and the ability to reconcile and detect tampering.

Examples: a delivery marketplace's payment ledger, subscription billing, marketplace escrow, wallet top-ups, FX exchange, payout batches, dispute windows.

**Don't use it for** general application data, identity/auth, workflow orchestration with mostly-non-financial state, or anything that doesn't have a balanced-postings shape. Loki is *not* a PSP and never moves money in the real world; adapters bridge to PSPs, and the actual external call happens after the DB commits.

---

## Install

Loki is Postgres-only. You'll need Postgres ≥ 14 (15+ recommended for declarative partitioning).

```sh
pnpm add @loki/core @loki/cli
# optional: PSP adapters
pnpm add @loki/adapter-sdk @loki/adapter-mocked
```

### Postgres prerequisites

Loki migrations create eight engine tables, indexes, RLS policies, and two roles (`ledger_app`, `ledger_admin`). The connection string used to **run migrations** must be a Postgres role with these privileges:

- `CREATE` on the target schema (default `public`).
- Membership in (or ability to create) `ledger_app` and `ledger_admin`. The migration's `CREATE ROLE ... IF NOT EXISTS` block is wrapped in `DO $$` and is idempotent — re-running on an existing cluster won't fail.
- `CREATEROLE` if the roles don't exist yet, **or** the operator pre-creates them. SUPERUSER is **not** required, but it is the simplest way to bootstrap a development cluster.

After migrations land, the app's runtime connection string can downgrade to a less-privileged user — typically a role that's a member of `ledger_app` only. The reconciler / scheduler / outbox workers run as `ledger_admin`.

```sql
-- one-time bootstrap (as a superuser or a role with CREATEROLE)
CREATE DATABASE loki;
CREATE USER loki_owner WITH PASSWORD 'change-me';
GRANT ALL PRIVILEGES ON DATABASE loki TO loki_owner;

-- connect as loki_owner; the migration creates the two engine roles
-- and grants the appropriate columns. After migrate apply:
--   - `ledger_app`   gets append-only INSERT + cache-column UPDATE
--   - `ledger_admin` gets full DML
-- Loki's runtime connection user must be a member of one of the two.
GRANT ledger_app TO loki_owner;
```

`DATABASE_URL` follows the standard Postgres URL syntax. Use `sslmode=require` for production, `application_name` for observability, and `pool_max=...` is the postgres.js pool ceiling (Loki defaults to `max: 10`):

```
postgres://loki_owner:change-me@db.internal:5432/loki?sslmode=require&application_name=svc-billing
```

#### RLS and role membership

Loki uses Postgres row-level security to scope every per-tenant query by `loki.tenant_id` (a session-local GUC the engine sets inside `withTenant`). The runtime user must NOT have `BYPASSRLS` — that flag silently bypasses the tenant filter and is the most common source of cross-tenant leaks.

#### Pool sizing — what to override

Loki's defaults (`packages/core/src/engine/connection.ts:DEFAULT_POOL_OPTIONS`):

| option | default | recommended override |
|---|---|---|
| `max` | `10` | `25–50` for an API box; `100+` for high-traffic worker pools. Cap at `pg_settings.max_connections / replica_count`. |
| `idle_timeout` | `30` (s) | leave alone unless you've measured connection-recycle churn |
| `connect_timeout` | `10` (s) | lower (`3`–`5`) to fail fast in PaaS environments |
| `connection.statement_timeout` | `30000` (ms) | tune to your workload — a worker draining outbox can run with `60_000`; an API write path should stay tight |

Override per-deployment:

```ts
createEngine({
  schema,
  connection: {
    url: process.env.DATABASE_URL,
    options: {
      max: 50,
      connect_timeout: 5,
      connection: { statement_timeout: 15_000, application_name: 'svc-billing' },
    },
  },
})
```

#### Liveness / readiness probes

`engine.health()` is a typed probe suitable for k8s readiness:

```ts
const r = await engine.health({ timeoutMs: 2000 })
// { ok, primary, replica, migrations, nowMs }
```

It probes the primary (`SELECT pg_current_wal_lsn()`), the replica if configured (`pg_last_wal_replay_lsn()` + lag in WAL bytes), and confirms the bootstrap migration has been applied. Each sub-probe has a per-call timeout so a wedged backend can't hang the response.

#### Graceful shutdown

```ts
import { installShutdownHandlers } from '@loki/core'

const outboxWorker = engine.outbox.startWorker()
const reconcilerHandle = engine.reconciler.start()
const schedulerWorker = engine.scheduler.startWorker()

installShutdownHandlers(engine, [outboxWorker, schedulerWorker, reconcilerHandle], {
  timeoutMs: 30_000,
  onStep: (s) => log.info({ step: s }, 'shutdown'),
  onTimeout: () => process.exit(1),
})
```

Wires `SIGTERM` and `SIGINT` to stop every worker (in order), then close the engine. Subsequent signals during shutdown are ignored so a panicked operator mashing Ctrl-C can't restart the sequence.

---

## 5-minute setup

### 1. Define your schema

`ledger.schema.ts`:

```ts
import {
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '@loki/core'
import { z } from 'zod' // or valibot, arktype — any Standard Schema validator

const Org = defineTenant('Org')

const User = defineActor('User', {
  // Default `allowOverdraft: false` — wallet must be funded before
  // the first debit. Top up via a separate `WalletTopUp` transition.
  accounts: { wallet: { currency: 'NGN' } },
})
const Driver = defineActor('Driver', {
  accounts: { balance: { currency: 'NGN' } },
})
const Company = defineActor('Company', {
  accounts: {
    // Sharded accounts require explicit `allowOverdraft: true` —
    // the cross-shard balance check would race with single-shard
    // writers. Revenue is credit-accumulating in practice, so this
    // is fine.
    revenue: { currency: 'NGN', shards: 16, allowOverdraft: true },
    promo_pool: { currency: 'NGN' },
  },
})
const Funder = defineActor('Funder', {
  // Liability account for top-ups. Credits flow OUT to user wallets,
  // so the source itself runs negative — opt in to overdraft.
  accounts: { source: { currency: 'NGN', allowOverdraft: true } },
})

const WalletTopUp = defineTransaction('WalletTopUp', {
  states: ['pending', 'completed'],
  initial: 'pending',
  terminal: ['completed'],
  participants: { user: User, funder: Funder },
  transitions: (t) => ({
    deposit: t({
      from: 'pending',
      to: 'completed',
      by: [Funder],
      payload: z.object({ amount: z.bigint() }),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.funder.source, amount: data.amount },
        { direction: 'C', account: participants.user.wallet, amount: data.amount },
      ],
    }),
  }),
})

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
      unlocks: ['refund'],
      emit: 'delivery.paid',
    }),
    refund: t({
      from: 'completed',
      to: 'refunded',
      by: [Company],
      needs: 'refund',
      payload: z.object({ reason: z.string() }),
      postings: 'invert:pay',
      emit: 'delivery.refunded',
    }),
  }),
})

export default defineSchema({
  tenant: Org,
  actors: [User, Driver, Company, Funder],
  transactions: [WalletTopUp, DeliveryPayment],
})
```

### 2. Configure the CLI

`loki.config.ts`:

```ts
import schema from './ledger.schema'

export default {
  schema,
  connection: { url: process.env.DATABASE_URL ?? '' },
}
```

### 3. Run migrations

```sh
loki migrate apply              # creates engine tables, RLS, indexes, roles
loki tenant create chidori --name "Chidori Logistics"
```

### 4. Use the engine

```ts
import { createEngine } from '@loki/core'
import schema from './ledger.schema'

const engine = createEngine({
  schema,
  connection: { url: process.env.DATABASE_URL },
})

const c = engine.forTenant('chidori')
const user = { type: 'User', id: 'u-1' }
const driver = { type: 'Driver', id: 'd-1' }
const company = { type: 'Company', id: 'co-1' }

const funder = { type: 'Funder', id: 'demo-bank' }

await c.accounts.create({ actor: user, name: 'wallet' })
await c.accounts.create({ actor: driver, name: 'balance' })
await c.accounts.create({ actor: company, name: 'revenue' })
await c.accounts.create({ actor: funder, name: 'source' })

// Fund the wallet via a typed top-up transaction. (No raw SQL — the
// reconciler would catch the resulting balance drift.)
const top = await c.transactions.create({
  type: 'WalletTopUp',
  by: funder,
  participants: { user, funder },
  idempotencyKey: 'topup:1',
})
await c.transactions.transition({
  id: top.record.id,
  name: 'deposit',
  by: funder,
  data: { amount: 5000n },
  idempotencyKey: 'topup:1:deposit',
})

const txn = await c.transactions.create({
  type: 'DeliveryPayment',
  by: user,
  participants: { user, driver, company },
  idempotencyKey: 'd9001:create',
})
const r = await c.transactions.transition({
  id: txn.record.id,
  name: 'pay',
  by: user,
  data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
  idempotencyKey: 'd9001:pay',
})

// `r.unlocked.refund` is a capability key id — pass it to the refund transition.
await c.transactions.transition({
  id: txn.record.id,
  name: 'refund',
  by: company,
  withKey: r.unlocked.refund,
  data: { reason: 'driver no-show' },
  idempotencyKey: 'd9001:refund',
})
```

---

### Where to go next

- [examples/](./examples) — runnable starters: `delivery-app/`, `subscription/`, `escrow-with-stripe/`.
- [RUNBOOK.md](./RUNBOOK.md) — what to do when reconciler alerts, quarantines, or migration mismatches fire at 3 a.m.
- [SECURITY.md](./SECURITY.md) — PCI / GDPR / PII guidance, crypto-shredding, tenant isolation, vulnerability reporting.
- [docs.md](./docs.md) — full API reference per package.

---

## Capabilities

### The four invariants

Every transition is one DB transaction that enforces:

1. **Idempotency** — `(txn_id, idempotency_key)` is unique. Replays return the original result. Never re-runs.
2. **State legality** — `from -> to` must be declared. Illegal moves fail at compile time (typed) and runtime.
3. **Capability gating** — `needs: X` requires an active, unconsumed key X.
4. **Balanced postings** — `sum(D) == sum(C)`, **per currency** (multi-currency / FX safe).

If any invariant fails, nothing is written. Atomic or nothing.

### Overdraft policy

Default `allowOverdraft: false`. The engine refuses any transition that would take an account's cached balance below zero (`OverdraftError` thrown pre-commit, tx rolled back, balance unchanged).

Opt in for liability or imbalance accounts:

```ts
const Bank = defineActor('Bank', {
  accounts: {
    source: { currency: 'NGN', allowOverdraft: true },
  },
})

const Platform = defineActor('Platform', {
  accounts: {
    // Sharded accounts must opt in (cross-shard race).
    revenue: { currency: 'NGN', shards: 16, allowOverdraft: true },
  },
})
```

Reversal transitions (`postings: 'invert:...'`) bypass the check. `allowOverdraft: false` cannot combine with `shards > 1`; the schema builder rejects the combination at construction.

A fresh wallet defaults to `allowOverdraft: false`, so the first transition on it must be a credit — typically a typed top-up debiting a `Bank` / `Funder` source. See `examples/escrow-with-stripe/`.

### Multi-tenancy (three modes)

| Mode | Isolation | Cost | Use when |
|------|-----------|------|----------|
| **Row-level (RLS)** | DB-enforced via `current_setting('loki.tenant_id')` | One shared DB | High tenant count (SaaS for SMBs) |
| **Schema-per-tenant** | Postgres schema + `search_path` | One DB, N schemas | Medium count |
| **DB-per-tenant** | Separate connection per tenant | N migrations, N pools | Few enterprise tenants |

```ts
// Schema-per-tenant: provision and route
import { withSearchPath } from '@loki/core'

await engine.admin.tenants.create({ id: 'org-a', name: 'A', mode: 'schema' })
await engine.admin.tenants.provision({ id: 'org-a', mode: 'schema' })

const routes = new Map([
  ['org-a', withSearchPath(engine.connection, 'loki_t_org_a')],
])
const engine = createEngine({
  schema,
  connection,
  connectionFor: (id) => routes.get(id) ?? null, // null falls back to RLS
})

// Move a tenant between modes:
await engine.admin.tenants.relocate({ id: 'org-a', target: newConn, deleteFromSource: true })
```

### Integrity & self-correction

- **Hash chain** on every transition (`prev_hash`, `row_hash`).
- **Postings checksum** per transition.
- **Append-only DB roles** (`loki_app` can INSERT but not UPDATE/DELETE on history tables).
- **Watermarked reconciler** — *every* check is O(Δ) per pass. Four watermarks (`transitions`, `drift`, `state`, `keys`) live in `_loki_reconciler_state`; balance-drift, state-mismatch, and fabricated-key checks now skip rows untouched since the last sweep, just like the hash-chain and checksum checks. Bounded by Δ-since-last-sweep, not by table size.
- **Configurable schedule** — `continuous` / `daily` / `weekly` / `monthly`. Common pattern: continuous incremental + weekly full sweep on Sunday 02:00 UTC for cold-row drift.
- **Quarantine** — records with critical anomalies are marked `compromised`; the engine refuses further transitions until cleared.
- **Auto-repair** — `repairBalanceDrift: true` rebuilds the `accounts.balance` cache from postings; `repairStateMismatch: true` bumps cached `state` to the latest transition's `to_state`; `repairFabricatedKeys: true` flips orphan keys `active` → `expired` and skips quarantine for that anomaly. Hash-chain breaks, checksum mismatches, and unbalanced postings still quarantine — Loki cannot self-heal those without inventing data.

```ts
// Continuous, default 60s interval
const handle = engine.reconciler.start()

// Or richer schedules
engine.reconciler.start({
  schedule: { kind: 'continuous', intervalMs: 60_000 },
  // Optional: weekly full sweep to catch drift on cold rows
  fullSweepSchedule: { kind: 'weekly', dayOfWeek: 0, at: '02:00', tz: 'utc' },
})
engine.reconciler.start({ schedule: { kind: 'daily', at: '03:30', tz: 'local' } })
engine.reconciler.start({ schedule: { kind: 'monthly', dayOfMonth: 1, at: '00:00' } })

// Or one-shot
const result = await engine.reconciler.runOnce({
  tenantId: 'chidori',
  repairBalanceDrift: true,
  fullSweep: false, // O(Δ) by default
})
```

### Hooks

In-process callbacks for anomalies, lifecycle events, and business rules.

```ts
// Page on-call for critical anomalies
engine.hooks.onAnomaly({ severity: 'critical' }, async (a) => {
  await pagerduty.trigger({ severity: 'P1', details: a })
})

// Per-tenant escalation
engine.hooks.onAnomaly({ tenantId: 'org-acme' }, async (a) => acmeIncidentApi.create(a))

// Business rule that can ABORT the transition
engine.hooks.beforeTransition(
  { txnType: 'DeliveryPayment', name: 'pay' },
  async ({ data, tenantId }) => {
    if (tenantId === 'org-ng' && !withinBusinessHours()) {
      throw new RejectTransition('outside business hours')
    }
  },
)

// Catch other hooks throwing
engine.hooks.onHookFailure((e) => sentry.capture(e))
```

`beforeTransition` runs **inside** the transition's DB tx, so a slow handler holds row locks. The engine enforces a timeout (default 1000ms) — exceeding it throws `BeforeTransitionTimeoutError` and aborts the tx normally. Override via `createEngine({ hooks: { beforeTransitionTimeoutMs: 250 } })`, or pass `null` to disable.

Available hooks: `beforeTransition`, `afterTransition`, `onAnomaly`, `onIntegrityViolation`, `onQuarantine`, `onReversal`, `onOutboxFailureTerminal`, `onReconciliationComplete`, `onSchemaMigration`, `onTenantLifecycle`, `onHookFailure`. Filters compose: `severity`, `check`, `tenantId`, `txnType`, custom predicate.

### Adapters (PSP integration)

The engine never blocks on a PSP. A transition with `emit: 'stripe.capture'` drops an outbox row; an adapter worker drains it after the DB commits, calls Stripe with a deterministic idempotency key, and drives a follow-up Loki transition (`mark_captured` or `mark_capture_failed`).

```ts
import { defineAdapter } from '@loki/adapter-sdk'

const stripeAdapter = defineAdapter({
  name: 'stripe',
  outbound: {
    'stripe.capture': async (event, { confirm, fail }) => {
      try {
        const r = await stripe.paymentIntents.capture(event.payload.id, {
          idempotencyKey: event.id,
        })
        await confirm({ transition: 'mark_captured', data: { stripe_id: r.id } })
      } catch (e) {
        if (e.code === 'card_declined') {
          await fail({ transition: 'mark_capture_failed', data: { reason: e.message } })
        } else {
          throw e // retry via outbox backoff
        }
      }
    },
  },
  inbound: {
    'payment_intent.succeeded': (event) => ({
      transition: 'mark_funded',
      data: { psp_reference: event.data.object.id, amount: event.data.object.amount },
    }),
  },
})

engine.adapters.register(stripeAdapter)
engine.outbox.startWorker({ intervalMs: 1_000 })
```

### Query API (read side)

Every actor type, account, and primitive is queryable with keyset pagination. No `OFFSET` is ever generated.

```ts
const c = engine.forTenant('chidori')

// Per-record
const trail = await c.transactions.trace(txnId)
const verify = await c.queries.verify(txnId, sha256Hasher)

// Per-actor
const page = await c.queries.actor(driver).transactions({
  type: 'DeliveryPayment',
  state: ['completed', 'refunded'],
  since: '2026-04-01',
  limit: 50,
})
const summary = await c.queries.actor(driver).summary({ since, until })
const trails = await c.queries.actor(driver).trails({ since, until, limit: 25 })

// Account-centric
const balance = await c.accounts.balance({ actor: driver, name: 'balance', currency: 'NGN' })
const past = await c.queries.account.balanceAt({ actor: driver, name: 'balance', currency: 'NGN' }, '2026-04-30T23:59:59Z')
const history = await c.queries.account.history({ actor: driver, name: 'balance', currency: 'NGN' }, {
  since, until, direction: 'C', limit: 100,
})
const stats = await c.queries.account.aggregate({ actor: driver, name: 'balance', currency: 'NGN' }, {
  since, until, metrics: ['count', 'sum_credit', 'sum_debit'],
})

// Generic findMany
const txns = await c.queries.transactions.findMany({
  where: { type: 'DeliveryPayment', state: { in: ['completed', 'refunded'] } },
  orderBy: { occurredAt: 'desc' },
  limit: 50,
})
const anomalies = await c.queries.anomalies.findMany({
  where: { severity: ['error', 'critical'], resolved: false },
  limit: 100,
})
```

### Performance hardening

- **Indexes** for every hot query path (no sequential scans on the hot path).
- **Hot-account sharding** — declare `{ shards: 16 }` on a high-traffic account and the engine routes postings to a random shard; balance reads sum across shards via a generated view.
- **Bulk write API** — `bulkTransition([...])` for backfills and batch settlement; same invariants, lock cost amortized.
- **Read-replica routing** — pass `readUrl` and `findMany`/`trace`/`balance`/`verify` route there; writes always hit primary.
- **Materialized projections** — declare `defineProjection('driver_activity', { source: 'txn_transitions', when: { actorType: 'Driver' }, columns: [...] })` and the engine maintains a denormalized `proj_driver_activity` table inside the same tx as the source write. Sub-millisecond actor-centric reads, no eventual consistency.
- **Monthly partitioning** — set `migration: { partitioning: 'monthly' }` and `txn_transitions` + `postings` are partitioned by `occurred_at`. `engine.partitions.ensureFor(date, { monthsAhead: 3 })` provisions partitions ahead of writes.

### Scheduled transitions

```ts
const sched = await engine.scheduler.create({
  tenantId: 'chidori',
  txnId: txn.record.id,
  name: 'release',
  runAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  by: marketplace,
  withKey: r.unlocked.release,
  idempotencyKey: 'auto-release:d9001',
})

// Worker mode (poll every minute)
engine.scheduler.startWorker({ intervalMs: 60_000 })

// Or one-shot
const r = await engine.scheduler.runDue({ tenantId: 'chidori' })

await engine.scheduler.cancel(sched.id, { tenantId: 'chidori' })
```

### Payload encryption at rest

Optional plug-in. Wire `payloadCrypto: { encrypt, decrypt, algorithm? }` on `createEngine` and every value bound for `txn_transitions.payload`, `outbox.payload`, and `txn_anomalies.expected/observed` lands wrapped in an `{ "$encrypted": "v1:<alg>:<base64>" }` envelope. The hash chain is computed over the **plaintext** canonical form, so a key rotation never invalidates `row_hash`. Read paths (transition results, `trace`, `findMany`, outbox dispatch) auto-decrypt; for raw rows pulled outside the engine API, call `engine.decryptPayload(row.payload)`. Default `undefined` = current behaviour, byte-for-byte plaintext.

```ts
const engine = createEngine({
  schema,
  connection: { url },
  payloadCrypto: {
    encrypt: (json) => kms.encrypt(json),
    decrypt: (b64) => kms.decrypt(b64),
    algorithm: 'aes-256-gcm', // tag stored in the envelope
  },
})
```

### FX rates (M16)

Tenant-scoped time-series of base/quote/rate tuples. Loki itself never moves money in FX terms — postings stay in minor units of a single currency — but the rate table sits alongside so cross-currency transitions can pin a quoted rate at write time, and the reconciler can verify the pin later.

```ts
await engine.fx.publish({
  tenantId: 'chidori',
  baseCurrency: 'USD',
  quoteCurrency: 'NGN',
  rate: '1500.0',
  source: 'cbn',
})
const rate = await engine.fx.lookup({ tenantId: 'chidori', baseCurrency: 'USD', quoteCurrency: 'NGN' })
const series = await engine.fx.history({ tenantId: 'chidori', baseCurrency: 'USD', quoteCurrency: 'NGN' })

// Reconciler check: a transition with `data.rate` + `data.baseCurrency` +
// `data.quoteCurrency` is verified against the published rate within
// tolerance (default 0.0001). Disagreements emit `fx_rate_drift`.
await engine.reconciler.runOnce({ tenantId: 'chidori', fxRateTolerance: 0.0001 })
```

### Holds and disputes (M17)

First-class storage tables with helper APIs. Schema-DSL primitives (`defineHold`, `defineDispute`) are a follow-up — for now operators wire holds and disputes manually around capability keys + the existing scheduler.

```ts
// Place a 5,000-NGN hold against a hold account
const hold = await engine.holds.place({
  tenantId: 'chidori',
  holdAccountId: holdAcct.id,
  amount: 5000n,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
})
await engine.holds.release({ id: hold.id }) // or expireDue() in a worker

// Open a dispute against a transition
const dispute = await engine.disputes.open({
  tenantId: 'chidori',
  originalTransitionId: r.transition.id,
  deadlineAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  reason: 'unauthorized charge',
})
await engine.disputes.resolve({ id: dispute.id, outcome: 'customer', resolution: 'refund issued' })
```

### Currency precision and split helpers

Postings always live in `bigint` minor units. The currency primitives are advisory — they help format and split totals consistently.

```ts
import { defineCurrency, defineCurrencyMap, formatMinor, splitAmount } from '@loki/core'

const currencies = defineCurrencyMap({
  NGN: { decimals: 2, rounding: 'banker' },
  BTC: { decimals: 8, rounding: 'truncate' },
})
formatMinor(150_000n, 'NGN', currencies) // "1500.00"
formatMinor(150_000n, 'BTC', currencies) // "0.00150000"

splitAmount(1000n, 3, 'banker')   // [334n, 333n, 333n] — sum preserved
splitAmount(1000n, 3, 'truncate') // [334n, 333n, 333n] — residual on first
splitAmount(1000n, 3, 'floor')    // [333n, 333n, 334n] — residual on tail
```

### Read-your-writes routing

When you've configured a read replica, set `readYourWrites: 'auto'` and Loki tracks the WAL LSN at the end of every primary write in an `AsyncLocalStorage` context. The next replica read in the same context probes the replica's `pg_last_wal_replay_lsn()`; if it's behind the captured write, the read transparently falls back to the primary. Default `'off'` (current behaviour).

```ts
const engine = createEngine({
  schema,
  connection: { url, readUrl, readYourWrites: 'auto' },
})
```

### Observability plug-ins

Counter / histogram / gauge interfaces match Prometheus; `Tracer.startSpan` matches OpenTelemetry. Without a config, the engine uses no-op shims so call sites compile to nothing.

```ts
import { createEngine, type MetricsAdapter, type Tracer } from '@loki/core'

const metrics: MetricsAdapter = makePromAdapter() // your bridge
const tracer: Tracer = otelTracer

const engine = createEngine({ schema, connection, metrics, tracer })
```

The pre-built instruments (`engine.instruments.*`) cover every transition (duration histogram, error counter), every reconciler pass (duration, anomalies-by-severity), every outbox dispatch (success/failure counters), and every scheduler fire.

### Logging (operational events)

A `Logger` plug-in for the engine's operational events (engine started, migration applied, reconciliation pass finished, outbox dispatch failed terminally). Same shape as `metrics` and `tracer` — a subset of pino / winston / bunyan. Without a logger, the engine is silent.

```ts
import { createEngine, consoleLogger } from '@loki/core'

const engine = createEngine({
  schema,
  connection,
  logger: consoleLogger({ level: 'info' }),
})

// Or wire your own (pino, winston, bunyan, …):
import pino from 'pino'
const log = pino()
createEngine({
  schema,
  connection,
  logger: {
    debug: (m, f) => log.debug(f, m),
    info:  (m, f) => log.info(f, m),
    warn:  (m, f) => log.warn(f, m),
    error: (m, f) => log.error(f instanceof Error ? { err: f } : f, m),
    child: (f) => /* wrap pino.child(f) */ engine.instruments.logger,
  },
})
```

### Schema evolution

Append-only history means schema changes don't rewrite old rows. Every record + transition carries its `schema_version`.

```ts
// Bump version + add an alias map for renames
export default defineSchema({
  tenant: Org,
  actors: [User, Driver, Company],
  transactions: [DeliveryPayment],
  version: 2,
  aliases: { 1: { actors: { Customer: 'User' } } },
})

// Classify changes between two versions
import { diffSchemas } from '@loki/core'
const diff = diffSchemas(oldSchema, newSchema)
// { counts: { additive, rename, restrictive, destructive }, changes: [...] }

// Find records that violate a newly-introduced invariant
const violators = await engine.admin.schema.findViolations({
  txnType: 'DeliveryPayment',
  transitionName: 'pay',
  predicate: (t) => Number((t.payload as any).amount?.$bigint ?? 0) < 1000,
})
```

---

## CLI

```sh
loki migrate apply               # apply pending migrations
loki migrate plan                # print up/down SQL
loki migrate rollback            # roll back the most recent migration
loki migrate status              # show applied vs pending
loki migrate enforce <name>      # find records violating a configured invariant

loki reconcile [--tenant <id>] [--no-quarantine]

loki tenant create <id> --name <name>
loki tenant list
loki tenant get <id>
loki tenant suspend <id>
loki tenant activate <id>
loki tenant delete <id>
loki tenant dashboard <id>       # per-tenant rollup: counts, anomalies, schema versions

loki schema versions [--tenant <id>]
loki schema diff --from <other-config-path>

loki anomalies list --tenant <id> [--severity warn|error|critical] [--unresolved] [--limit N]
loki anomalies resolve <id> --tenant <id> --by <name> --note <text>

loki trace <txnId> --tenant <id> [--verify]

loki dashboard [--port N] [--host H] [--auth bearer:$TOKEN | basic:user:argon2-hash]
               [--allowed-host <host:port> ...] [--trust-proxy-tls] [--trust-proxy-hops N]
               [--allow-prod] [--unsafe-host] [--allow-actions] [--open]
```

---

## Dashboard

A read-only HTTP dashboard ships with `@loki/cli`. Boots in one command, surfaces every tenant / actor / account / transaction / trace / anomaly / outbox / scheduler / hold / dispute / FX series that the engine writes — without ever performing a mutation. Two narrowly-bounded action endpoints (anomaly resolve, on-demand reconciler pass) are opt-in behind `--allow-actions` + per-subject grants + CSRF + idempotency.

```sh
# Dev default: binds 127.0.0.1:4488, no auth, no redaction
loki dashboard --open

# Prod-ish (behind a TLS-terminating reverse proxy):
LOKI_DASHBOARD_TOKEN=$(openssl rand -hex 32)
loki dashboard \
  --host 0.0.0.0 --unsafe-host \
  --allowed-host dashboard.internal:443 \
  --trust-proxy-tls \
  --auth bearer:$LOKI_DASHBOARD_TOKEN \
  --allow-prod
```

The dashboard is structurally read-only: a dedicated `ReadEngine` facade, a Postgres pool opened with `default_transaction_read_only=on`, and a recommended `ledger_readonly` role (migration creates it). A CI lint script (`scripts/check-dashboard-readonly.ts`) walks the dashboard subtree and fails the build on any forbidden import (write API, `eval`, outbound HTTP, etc.).

Defaults are dev-safe — the server refuses to start on non-loopback hosts, under `NODE_ENV=production`, or with `--allow-actions` unless an auth scheme + (for non-loopback) TLS in front are configured. DNS-rebinding is shut at the door via a Host-header allowlist; same-origin is enforced via `Sec-Fetch-Site`; every response carries a strict CSP, COOP/CORP, `Cache-Control: private, no-store`. See [packages/cli/DASHBOARD.md](packages/cli/DASHBOARD.md) for the full design + threat model.

```ts
// loki.config.ts
import schema from './ledger.schema'

export default {
  schema,
  connection: { url: process.env.DATABASE_URL },
  dashboard: {
    port: 4488,
    tenants: ['chidori'],
    auth: { kind: 'bearer', token: process.env.LOKI_DASHBOARD_TOKEN! },
    allowedHosts: ['dashboard.internal:443'],
    // Optional payload redactor — runs after engine.decryptPayload.
    redactPayload: (payload, ctx) => (ctx.kind === 'transition' ? safeProjection(payload) : payload),
  },
}
```

---

## Architecture at a glance

Loki is **Postgres-only**, no consensus protocol. The four invariants ride on five Postgres primitives: serializable isolation, row-level locks, `FOR UPDATE SKIP LOCKED`, uniqueness constraints, RLS. Cross-DB problems use sagas, not 2PC.

```
┌──────────────────────────────────────────────────────────────┐
│  Application code                                            │
│    engine.forTenant(id).transactions.transition({...})       │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Engine (one DB tx per state move)                           │
│    1. SELECT FOR UPDATE on affected accounts (sorted by id)  │
│    2. UPDATE txn_records (optimistic version bump)           │
│    3. INSERT txn_transitions (prev_hash, row_hash, checksum) │
│    4. INSERT N postings, validate balanced PER currency      │
│    5. INSERT key grants, UPDATE consumed keys                │
│    6. INSERT outbox row (if `emit` declared)                 │
│    7. Maintain materialized projections                      │
│    8. Fire beforeTransition / queue afterTransition hooks    │
└──────────────────────────────────────────────────────────────┘
        │                      │                       │
        ▼                      ▼                       ▼
┌─────────────────┐   ┌──────────────────┐   ┌─────────────────┐
│  RLS-scoped     │   │  Reconciler       │   │  Outbox worker  │
│  per-tenant     │   │  (watermarked)    │   │  (SKIP LOCKED)  │
│  queries        │   │  + hooks          │   │  → adapters     │
└─────────────────┘   └──────────────────┘   └─────────────────┘
```

For the full **API reference** — every export, every option, every CLI flag — see [docs.md](./docs.md). For the design rationale and original spec, see [project.md](./project.md).

---

## Repo layout

```
packages/
  core/             @loki/core           — schema DSL, engine, reconciler, scheduler, partitions
  client/           @loki/client         — typed client surface (re-exports from core)
  cli/              @loki/cli            — `loki migrate / reconcile / schema / tenant / anomalies / trace`
  adapter-sdk/      @loki/adapter-sdk    — defineAdapter() for PSP integration
  adapter-mocked/   @loki/adapter-mocked — deterministic in-memory PSP for tests
```

First-party PSP adapters (`@loki/adapter-stripe`, `-paystack`, `-flutterwave`, `-nibss`, `-plaid`) and reference schema packages (`@loki/schemas-subscription`, `-marketplace`, `-payout`, `-wallet`, `-card-payment`, `-fx`, `-logistics`) are intentionally **not** shipped in this repo — the adapter SDK and schema DSL are the primitives. Build your own; the patterns are in the integration tests under `packages/core/test/integration/`.

---

## Develop

```sh
pnpm install
pnpm test                 # unit tests + types
LOKI_INTEGRATION=1 pnpm vitest run packages/core/test/integration/   # integration (Testcontainers)
pnpm typecheck
pnpm lint
pnpm build
```

Integration tests pull `postgres:16-alpine` via Testcontainers (or set `LOKI_TEST_DB_URL` to point at an existing Postgres).

---

## Glossary

- **Transition** — one named, validated, atomic move between states. Carries actor, payload, postings, key effects, hash-chain links.
- **Posting** — one debit or credit on an account. Every transition has N postings; sum(D) = sum(C) per currency.
- **Capability key** — a token minted by `unlocks` and required by `needs`. In-process gating with the same atomic guarantees as the transition that minted it.
- **Outbox event** — a row dropped by `emit` for out-of-process listeners. Drained by `engine.outbox.startWorker`.
- **Trace** — the full ordered list of transitions on a record.
- **Anomaly** — a recorded inconsistency detected by reconciliation (balance drift, unbalanced postings, hash chain break, checksum mismatch, state mismatch, fabricated key).
- **Quarantine** — marking a record `compromised` so the engine refuses further transitions until cleared.
- **Reversal transition** — a balanced, recorded transition that undoes a previous one. Carries a `reverses` link.

---

## License

Apache-2.0.
