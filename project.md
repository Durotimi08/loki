# Project: Ledger (working name)

A schema-agnostic, plug-in transaction tracking and bookkeeping library — Prisma for money-movement records.

---

## 1. Mission

Ledger is to money-movement records what Prisma is to database access: you declare your transaction shapes, actors, accounts, and rules in a schema, and the package gives you a typed runtime that handles the bookkeeping correctly by construction.

The core engine never *moves* money in the real world. Adapters (§9) bridge to PSPs and banks. The engine is the system of record for *the records of money moving* — what state every transaction is in, who can move it forward, what postings make it balance, how the whole thing reconciles, how it self-heals when something has clearly gone wrong, and how multiple tenants stay isolated.

This is finance. Nothing is "out of scope" — every operational concern has an explicit place in the design.

## 2. What you stop writing yourself

When you adopt Ledger, you stop hand-rolling all of:

- Idempotency middleware
- Audit / event log tables
- State-transition guards
- Webhook outbox + delivery + retries
- Double-entry bookkeeping invariants
- Per-actor permission checks per transition
- Reconciliation queries
- Tamper detection on financial tables
- Concurrency control across distributed processes
- Tenant isolation policies and per-tenant scoping
- Anomaly alerting / escalation routing
- PSP webhook handlers and outbound retry workers
- Schema migration plans for evolving transaction shapes
- Per-actor and per-account query layers ("all of this driver's transactions")
- Cursor-based pagination, indexes, partitioning, read-replica routing
- Trace / breakdown views for support and ops

Application code shrinks to: *"drive this transition, here's the actor, here's the payload, here's the idempotency key."* Everything else is the package's job.

## 3. Core concepts

Six primitives — that's the whole package:

1. **Transaction type** — a named schema (`DeliveryPayment`, `Subscription`, `Escrow`). Has states, transitions, allowed actors.
2. **State** — where a transaction record currently is in its lifecycle.
3. **Transition** — a named, validated, typed move between states. Owns: actor permissions, payload schema, capability keys, postings.
4. **Actor** — a typed party that can drive a transition (`User`, `Driver`, `Company`, `System`).
5. **Account** — a balance-bearing entity owned by an actor (`User.wallet`, `Driver.balance`, `Company.revenue`, `Company.promo_pool`). Sub-accounts allowed.
6. **Posting** — one half of a debit/credit pair recorded against a transition. Every transition has N postings; sum(debits) must equal sum(credits).

Plus four derived concepts:

- **Capability key** — a token minted by `unlocks`. Future transitions consume it via `needs`. This gates progression in-process — no webhook required.
- **Outbox event** — a row dropped by `emit` for out-of-process listeners (webhooks, queues, adapters).
- **Tenant** — a top-level scope under which every actor, account, and record lives. First-class (§7).
- **Hook** — an in-process callback fired on lifecycle events, anomalies, or outbox failures. Developer-defined (§8).

## 4. The four invariants

Everything Ledger guarantees comes from four invariants enforced inside one DB transaction per state move:

1. **Idempotency** — `(txn_id, idempotency_key)` is unique. Replays return the original result. Never re-runs.
2. **State legality** — `from_state -> to_state` for the named transition must be declared. Illegal moves fail at compile time (typed) and runtime (engine).
3. **Capability gating** — if a transition declares `needs: X`, the engine verifies key X is active and unconsumed on the record.
4. **Balanced postings** — sum of debits == sum of credits across all postings on the transition.

If any invariant fails, nothing is written. Atomic or nothing.

These four hold *if* the engine is the only writer and there's only one writer at a time. §5 covers what happens when something else writes (tampering). §6 covers what happens when many writers race (distributed operation).

---

## 5. Integrity and self-correction

The four invariants assume the engine is the only writer to its tables. The moment someone runs `UPDATE postings SET amount = …` directly in `psql`, those invariants can be silently violated. Ledger treats the database as untrusted and continuously verifies its own state.

### 5.1 Tamper detection — defense in depth

Three layers, each independently sufficient to detect direct edits:

1. **Hash chain on transitions.** Every `txn_transitions` row stores `prev_hash` (the hash of the previous transition on the same `txn_id`) and `row_hash` (the hash of its own canonical content + `prev_hash`). The first transition's `prev_hash` is the genesis. Any direct edit, insert, or delete breaks the chain — verification is one SQL pass per record.

2. **Posting checksum per transition.** Every `txn_transitions` row stores `postings_checksum`, the hash of its sorted postings. Add, drop, or modify a posting and the checksum no longer matches its parent transition.

3. **Append-only DB roles.** Migrations create two roles. `ledger_app` is granted `INSERT` only on `txn_transitions` and `postings`. `ledger_admin` has full access and is used only by migrations and the reconciler. The application connects as `ledger_app`. Direct UPDATE/DELETE from the app is rejected at the DB level.

A bad actor with full DB access can still write — but they cannot make the chain or the checksums match without the engine. Tamper detection is **inevitable**, not preventable. The package's job is to make it loud.

### 5.2 Continuous reconciliation

A background reconciler runs invariant checks on a schedule (configurable; default: hot data every minute, full sweep hourly):

| Check                                                                                  | What it catches                                |
|----------------------------------------------------------------------------------------|------------------------------------------------|
| For every account: `balance == sum(postings.D) - sum(postings.C)`                      | Direct edits to balance or postings            |
| For every transition: `sum(postings.D) == sum(postings.C)`                             | Unbalanced postings                            |
| For every transition: hash chain valid against previous on same `txn_id`               | Transition rows edited or inserted             |
| For every transition: `postings_checksum` matches recomputed checksum                  | Postings edited, inserted, or deleted          |
| For every record: `state` matches `to_state` of its latest transition                  | State row edited                               |
| For every active key: `granted_by_transition_id` exists and granting transition valid  | Key rows fabricated                            |

Failed checks write a row to `txn_anomalies` with full context, **and fire the `onAnomaly` hook** (§8.2) so developers can route, log, escalate, or page however they choose.

### 5.3 Self-correction — with care

"Self-correcting" in finance means *containing damage*, not *guessing the truth*. When an anomaly is detected, the package follows a strict sequence:

1. **Quarantine.** The affected `txn_record` is marked `compromised`. The engine refuses further transitions on it until cleared. The `onQuarantine` hook fires.

2. **Reverse if reversible.** If the original signal is recoverable from the chain (an edited row whose original payload is recoverable from `row_hash` plus the audit log of *intended* writes), the engine emits a **reversal transition** — itself a normal, balanced, recorded transition with a `reverses` field pointing to the bad transition. The audit history shows both: the tamper, and the correction.

3. **Halt if not reversible.** If the original cannot be reconstructed (e.g. postings deleted, no signed copy available), the record stays quarantined and the `onAnomaly` hook fires with severity `critical`. Auto-correction here would be guessing — and guessing about money is how money disappears.

4. **Re-derive cached balances.** The `balance` column on accounts is always recomputable from postings. Reconciliation can rebuild it in one statement: `UPDATE accounts SET balance = (SELECT COALESCE(SUM(...), 0) FROM postings WHERE account_id = …)`.

The principle: **the package is transparent and noisy about inconsistency, not clever about hiding it.** Every correction is itself a recorded, balanced, audited transition. Nothing the package does is hidden.

---

## 6. Distributed operation

Ledger assumes multiple application processes — services, workers, replicas — all writing to the same Postgres concurrently. The shared DB is the coordination point. **The package never invents its own consensus layer.**

### 6.1 Concurrency model

- **Per-record optimistic locking.** `txn_records` carries a `version` column. Every transition does `UPDATE … WHERE id = ? AND version = ?` and bumps version. If 0 rows are updated, another writer raced; the caller retries with the same idempotency key. The retry either succeeds cleanly or hits the unique-key path and returns the prior result.

- **Per-account row locks for postings.** When writing postings, the engine `SELECT … FOR UPDATE` on the affected `accounts` rows in a deterministic order (by account id) to prevent deadlocks. Locks are released at end of the DB transaction.

- **Hot-account sharding.** Accounts hammered by every transaction (`company.revenue`, `company.escrow`) become serialization bottlenecks under load. Schema can declare shards:

  ```
  account Company.revenue { shards: 16 }
  ```

  Postings are routed to a random shard at write time. Balance reads sum across shards via a generated view. Bottleneck removed without consumer code changes.

### 6.2 Idempotency under races

`UNIQUE (txn_id, idempotency_key)` is the entire story. Two processes calling `transition(..., idempotencyKey: 'X')` simultaneously:

1. Both attempt the INSERT inside their own DB transaction.
2. One commits; the other gets a UNIQUE violation.
3. The loser re-reads the existing transition row by `(txn_id, idempotency_key)` and returns the same result the winner produced.

The caller is unaware. The result is correct. No external lock service needed.

### 6.3 Capability key races

Two processes try to consume the same key concurrently:

1. Both `SELECT … FOR UPDATE` on the `txn_keys` row.
2. One wins the lock, marks the key `consumed`, commits.
3. The other reads the now-consumed key, fails with `KeyAlreadyConsumed`.

Validate-and-consume happens inside the same DB transaction as the rest of the state move. Atomic.

### 6.4 Outbox delivery at scale

Many worker processes can deliver from the outbox concurrently:

```sql
SELECT * FROM outbox
WHERE delivered_at IS NULL AND next_attempt_at <= now()
ORDER BY id
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

`SKIP LOCKED` is the magic — workers grab disjoint batches without coordinating. On failure: backoff with jitter, increment `attempts`, reschedule. Crashed workers release locks; another picks up the work. Terminal failure (retries exhausted) fires the `onOutboxFailureTerminal` hook.

### 6.5 Cross-service sagas

Some flows span services (e.g. ride-completion: payment service → driver-payout service → notification service). The capability-key primitive supports this:

- Each service performs its leg as a transition that **consumes** a key from the prior leg and **unlocks** a key for the next.
- If a downstream leg fails, a compensating transition is driven on the upstream record — itself a balanced, audited reversal.
- No distributed transaction coordinator required. The DB is the source of truth; sagas are sequences of normal transitions.

### 6.6 Ordering and clocks

- **`occurred_at`** is wall-clock — useful for display, never for ordering logic.
- **Ordering is by `id`** (ULID, monotonically increasing per process). Reconciliation, hash chain, and outbox delivery all sort by id, not timestamp.
- **No reliance on synchronized clocks** anywhere in the package.

### 6.7 Cross-database flows

Multiple Postgres instances? Use sagas. Ledger does not invent 2PC or a Raft cluster. Each DB is its own ledger boundary; coordination across boundaries goes through the same capability-key + reversal-transition pattern as cross-service flows. Document the boundaries explicitly so operators know where atomicity ends.

---

## 7. Multi-tenancy

Ledger is **multi-tenant by default**. Every actor, account, transaction, posting, key, transition, anomaly, outbox event, and hook subscription is scoped to a `tenant_id`. Tenants are first-class — declared in the schema, enforced at the engine, and locked down at the database via Postgres Row-Level Security policies generated by the migrations.

### 7.1 The tenant primitive

```
tenant Org {
  id:   string
  name: string
}
```

Every other primitive is implicitly tenant-scoped. The runtime client carries a tenant context:

```ts
const tenantClient = ledger.forTenant(orgId)
await tenantClient.deliveryPayment.create({ ... })   // only sees orgId's records
```

A query that escapes the tenant context (e.g. raw SQL forgetting the filter) is rejected by the database, not silently leaked.

### 7.2 Three deployment modes

| Mode                  | Isolation         | Operational cost       | Use when                          |
|-----------------------|-------------------|------------------------|-----------------------------------|
| **DB-per-tenant**     | Strongest         | N migrations, N pools  | Few enterprise tenants            |
| **Schema-per-tenant** | Strong            | One DB, N schemas      | Medium tenant count               |
| **Row-level (RLS)**   | Strong (DB-enforced) | One shared DB        | High tenant count (SaaS for SMBs) |

The library supports all three. Mode is configured at deployment, not in application code. A tenant can be migrated between modes (e.g. graduate from row-level to dedicated DB as it grows) using the same migration-transition primitive.

### 7.3 Row-level mode — RLS by default

The most operationally efficient mode is row-level, but only when isolation is enforced *below* the application. Ledger's migrations create RLS policies on every table:

```sql
CREATE POLICY tenant_isolation ON txn_records
  USING (tenant_id = current_setting('ledger.tenant_id'));
```

Each request sets `ledger.tenant_id` at connection time via a session GUC. A query without the GUC set is rejected. The same pattern Supabase, AWS RDS Multi-Tenant, and Postgres production deployments rely on — defense in depth, with the DB as the final wall.

### 7.4 Tenant operations

| Operation                                                | What happens                                                  |
|----------------------------------------------------------|---------------------------------------------------------------|
| `ledger.tenant.create({ id, name })`                     | Provisions schema/RLS policies/connection contexts.           |
| `ledger.tenant.export(id)`                               | Snapshot for migration or compliance (GDPR portability).      |
| `ledger.tenant.delete(id, { mode: 'cascade' \| 'archive' })` | Removes or seals all rows. Itself a recorded audit event.     |
| `ledger.tenant.relocate(id, target)`                     | Move tenant from row-level to its own schema/DB.              |
| `ledger.tenant.suspend(id)`                              | Engine refuses new transitions; existing records stay readable.|

### 7.5 Per-tenant observability

- **Anomalies** scope per tenant — an anomaly in tenant A never affects tenant B's quarantines, alerts, or reconciliation reports.
- **Outbox** rows carry `tenant_id`. Filtering, routing, signing, retry policy — anything touching the wire — is the consumer's worker code, not the library's.
- **Hooks** can filter by `tenantId` — escalate one tenant's anomalies through PagerDuty, another's into Slack.
- **Reports** (balance, anomaly count, transition volume) compute per-tenant totals.

### 7.6 What this gives you

- **Mistakes can't leak.** RLS blocks any query that doesn't set the tenant context.
- **Tenant deletion is a real operation** — compliance asks (GDPR, contract termination) have a built-in answer.
- **Per-tenant scaling.** Hot tenants graduate to dedicated DBs without an application rewrite. The runtime client already abstracts the connection.
- **Per-tenant pricing/observability.** Operators see exactly what one tenant is doing, separate from the rest.

---

## 8. Hooks and extensibility

Some events demand custom developer behavior — alerting on anomalies, gating transitions on business rules the schema can't express, integrating with external monitoring or audit systems. Ledger exposes a typed, in-process hook system for these.

### 8.1 Hook taxonomy

| Hook                       | Fires when                                                        | Can abort?  | Sync/async |
|----------------------------|-------------------------------------------------------------------|-------------|------------|
| `beforeTransition`         | After validation, before DB commit                                | Yes (throw aborts) | Sync only |
| `afterTransition`          | After DB commit                                                   | No          | Async OK   |
| `onAnomaly`                | Reconciler detects any inconsistency                              | No          | Async OK   |
| `onIntegrityViolation`     | Hash chain or checksum mismatch (subset of `onAnomaly`, severity = critical) | No | Async OK |
| `onQuarantine`             | A record is marked `compromised`                                  | No          | Async OK   |
| `onReversal`               | A reversal transition is emitted                                  | No          | Async OK   |
| `onOutboxFailureTerminal`  | An outbox event exhausts its retry budget                         | No          | Async OK   |
| `onReconciliationComplete` | A reconciliation pass finishes (per record or full sweep)         | No          | Async OK   |
| `onSchemaMigration`        | A migration plan is applied                                       | No          | Sync OK    |
| `onTenantLifecycle`        | Tenant created / suspended / deleted / relocated                  | No          | Async OK   |
| `onHookFailure`            | Another hook threw                                                | No          | Async OK   |

Filters are composable across all hooks: `severity`, `check`, `tenantId`, `txnType`, custom predicate.

### 8.2 Anomaly hooks — the marquee case

```ts
// Critical anomalies: page on-call.
ledger.onAnomaly(
  { severity: 'critical' },
  async (anomaly) => {
    await pagerduty.trigger({
      title:    `Ledger critical anomaly: ${anomaly.check}`,
      severity: 'P1',
      details:  anomaly.observed,
    })
    await slack.post('#payments-alerts', formatAnomaly(anomaly))
    metrics.increment('ledger.anomaly.critical', { check: anomaly.check })
  }
)

// Balance drift: route to Sentry for diagnosis.
ledger.onAnomaly({ check: 'balance_drift' }, async (anomaly) => {
  await sentry.capture({ tags: { ledger: true }, extra: anomaly })
})

// Per-tenant escalation: ACME has its own incident system.
ledger.onAnomaly({ tenantId: 'org-acme' }, async (anomaly) => {
  await acmeIncidentApi.create({
    severity: anomaly.severity,
    summary:  anomaly.check,
    payload:  anomaly,
  })
})

// Custom predicate: only the ones touching merchant accounts.
ledger.onAnomaly(
  (a) => a.context.account?.owner_actor_type === 'Merchant',
  async (a) => { await merchantOpsAlert(a) }
)
```

Multiple handlers may register; **they all fire**. Errors thrown inside a hook are caught and routed to `onHookFailure` — they never block the engine.

### 8.3 Lifecycle hooks for business rules

Sometimes a rule can't be expressed in the schema (e.g. "users in Nigeria can only top up between 6am and midnight WAT"). `beforeTransition` is the place:

```ts
ledger.deliveryPayment.beforeTransition('pay', async ({ actor, data, tenantId }) => {
  if (tenantId === 'org-ng' && !withinBusinessHours()) {
    throw new RejectTransition('outside business hours')
  }
})
```

A throw aborts the transition. The DB tx never commits. The caller receives a typed `RejectTransition` error.

### 8.4 The `Anomaly` payload — what your hook receives

```ts
type Anomaly = {
  id:          string
  detected_at: timestamp
  tenant_id:   string
  check:       'balance_drift' | 'unbalanced_postings' | 'hash_chain_break' |
               'checksum_mismatch' | 'state_mismatch' | 'fabricated_key'
  severity:    'warn' | 'error' | 'critical'
  txn_id?:     string
  txn_type?:   string
  account_id?: string
  expected:    unknown                             // e.g. computed balance
  observed:    unknown                             // e.g. stored balance
  context:     {
    record?:      TxnRecord                        // full row snapshots
    transitions?: TxnTransition[]
    postings?:    Posting[]
    account?:     Account
  }
}
```

Hooks get enough context to make routing decisions without re-querying the DB.

### 8.5 What hooks are NOT

- **Not webhooks.** They run in-process, in the same node that drove the event. Use `emit` + outbox for cross-process delivery.
- **Not the place to silently mutate state.** If you need a state change in response, call `ledger.x.transition(...)` from inside the hook — it goes through the same engine validation as any other call.
- **Not retried automatically** (except `beforeTransition`, which aborts the transition on throw). Async hooks fire once; failures are routed to `onHookFailure`.
- **Not allowed to block the engine.** `afterTransition`, `onAnomaly`, etc. run on a hook worker pool; if they're slow, transitions don't slow down.

---

## 9. Provider adapters and reference schemas

Ledger does not call Stripe or Paystack from the engine. But the boundary between *"Ledger records a captured payment"* and *"Stripe captures the payment"* is real — and consumers shouldn't have to wire that boundary themselves. Ledger ships an **adapter framework** that solves it cleanly.

### 9.1 The adapter contract

An adapter is a small package that implements two flows:

**Outbound (Ledger → provider).** A transition writes an outbox row with a typed intent (e.g. `intent: stripe.capture`, `payload: { amount, currency, payment_method }`). An adapter worker drains the outbox using `FOR UPDATE SKIP LOCKED`, calls the PSP API with a deterministic idempotency key, then drives a follow-up Ledger transition (`mark_captured` / `mark_capture_failed`). **The actual PSP call happens after the DB commits** — that's how the dual-write problem is avoided.

**Inbound (provider → Ledger).** The adapter exposes an HTTP endpoint that receives PSP webhooks, verifies signatures, and maps each event to a Ledger transition declaratively (`stripe.payment_intent.succeeded → mark_funded`).

The core engine never blocks on a PSP. The four invariants and the integrity guarantees still hold even if Stripe is down for an hour.

### 9.2 Why this isn't "just calling the PSP from a transition"

The classic dual-write problem: a single code path that both updates the DB and calls Stripe can have one succeed while the other fails. With the outbox-mediated adapter pattern, the only thing inside the DB transaction is the *intent*. The actual external call happens after commit. PSPs all support idempotency keys, so a worker retry after a crash is safe.

### 9.3 First-party adapters

Shipped as separate packages (versioned independently from the core):

- `@ledger/adapter-stripe`
- `@ledger/adapter-paystack`
- `@ledger/adapter-flutterwave`
- `@ledger/adapter-paystack-mobile-money`
- `@ledger/adapter-bank-nibss` — NIP / NIBSS Instant Payment (Nigeria)
- `@ledger/adapter-plaid`
- `@ledger/adapter-mocked` — deterministic simulated provider for tests

### 9.4 Building your own — the adapter SDK

```ts
import { defineAdapter } from '@ledger/adapter-sdk'

export const stripeAdapter = defineAdapter({
  name: 'stripe',
  outbound: {
    'stripe.capture': async (intent, { confirm, fail }) => {
      try {
        const r = await stripe.paymentIntents.capture(intent.payload.id, {
          idempotencyKey: intent.idempotency_key,
        })
        await confirm({ transition: 'mark_captured', data: { stripe_id: r.id } })
      } catch (e) {
        if (e.code === 'card_declined') {
          await fail({ transition: 'mark_capture_failed', data: { reason: e.message } })
        } else {
          throw e   // retry via outbox backoff
        }
      }
    },
  },
  inbound: {
    'payment_intent.succeeded': (event) => ({
      transition: 'mark_funded',
      data: {
        psp_reference: event.data.object.id,
        amount:        event.data.object.amount,
      },
    }),
  },
})

ledger.registerAdapter(stripeAdapter)
```

A PSP integration is ~100 lines of code. Adapters are testable in isolation and composable.

### 9.5 Reference schema library

Ledger ships a library of common transaction shapes consumers can either use directly or copy-and-modify. They're **not** built into the engine — they're versioned starter schemas:

- `@ledger/schemas-subscription` — recurring billing (trial / active / past_due / cancelled).
- `@ledger/schemas-marketplace` — escrow + release + dispute primitives.
- `@ledger/schemas-payout` — batch driver/seller payouts with retry semantics.
- `@ledger/schemas-wallet` — top-up / withdrawal / internal-transfer flows.
- `@ledger/schemas-card-payment` — authorize / capture / void / refund flow with PSP-agnostic state machine.
- `@ledger/schemas-fx` — multi-currency conversion with rate-locking.
- `@ledger/schemas-logistics` — Chidori's delivery payment flow with driver/company splits.

Consumers `import` these into their schema file and extend with their own actors and accounts. The engine doesn't care; they're just schema fragments.

---

## 10. Schema DSL

Consumers write a single schema file. (Surface — external file vs in-code builder — is an open question; the snippets below use a TypeScript-flavored DSL for clarity.)

```
// === Tenant ===

tenant Org { id: string, name: string }

// === Actors ===

actor User {
  id:       string
  email:    string
  accounts: { wallet: Account }
}

actor Driver {
  id:       string
  name:     string
  accounts: { balance: Account }
}

actor Company {
  id:       string
  accounts: {
    revenue:     Account { shards: 16 }
    promo_pool:  Account
    escrow:      Account { shards: 8 }
    chargebacks: Account
  }
}

actor System {}              // for cron-driven and adapter-driven transitions

// === Transactions ===

transaction DeliveryPayment {
  initial:  pending
  terminal: [completed, failed, refunded]

  transition pay: pending -> completed
    by:       User
    requires: { amount: number, driver_share: number, company_share: number }
    postings:
      debit  user.wallet            amount
      credit driver.balance         driver_share
      credit company.revenue        company_share
    invariant: driver_share + company_share == amount
    unlocks:   [refund]
    emit:      "delivery.paid"

  transition pay_with_promo: pending -> completed
    by:       User
    requires: { amount, driver_share, company_share, promo }
    postings:
      debit  user.wallet            amount - promo
      debit  company.promo_pool     promo
      credit driver.balance         driver_share
      credit company.revenue        company_share
    invariant: driver_share + company_share == amount
    unlocks:   [refund]
    emit:      "delivery.paid"

  transition cancel: pending -> failed
    by: User | Company
    emit: "delivery.cancelled"

  transition refund: completed -> refunded
    by:       Company
    needs:    refund
    requires: { reason: string }
    postings: invert(transition: pay | pay_with_promo)
    emit:     "delivery.refunded"
}
```

### DSL elements

| Clause      | Meaning                                                                                 |
|-------------|-----------------------------------------------------------------------------------------|
| `initial`   | The state every new record starts in.                                                   |
| `terminal`  | States from which no further transitions are legal.                                     |
| `by`        | Which actor types may drive this transition. Unions allowed.                            |
| `requires`  | Typed payload schema. Validated on call.                                                |
| `postings`  | The double-entry leg list. Engine validates `sum(D) == sum(C)`.                         |
| `invariant` | Additional business rules beyond posting balance.                                       |
| `unlocks`   | Names of capability keys minted on success.                                             |
| `needs`     | Capability key required to perform this transition.                                     |
| `emit`      | Outbox event name. Optional. Drops a row for webhook/queue/adapter consumers.           |
| `shards`    | (Account modifier.) Number of internal shard sub-accounts for hot-account scaling.      |

## 11. Runtime client and query API

Generated typed client (Prisma-style). The read API is as expressive as the write API — every actor, account, and transaction type gets typed query methods generated from the schema. All list endpoints use **keyset pagination** with rich filters.

### 11.1 Tenant-scoped client

```ts
import { ledger } from './ledger.generated'

const client = ledger.forTenant('chidori')   // session GUC set automatically
```

### 11.2 Writes

```ts
// Create
const txn = await client.deliveryPayment.create({
  by: user,
  idempotencyKey: 'delivery-9001:create',
})

// Drive a transition
const r = await client.deliveryPayment.transition(txn.id, 'pay', {
  by:             user,
  idempotencyKey: 'delivery-9001:pay',
  data:           { amount: 1500, driver_share: 500, company_share: 1000 },
})

// Replays return r unchanged. No side effects.
await client.deliveryPayment.transition(txn.id, 'pay', { /* same args */ })

// Use an unlocked key
await client.deliveryPayment.transition(txn.id, 'refund', {
  by:             company,
  withKey:        r.unlocked.refund,
  idempotencyKey: 'delivery-9001:refund',
  data:           { reason: 'driver no-show' },
})
```

### 11.3 Per-record reads

```ts
const trail   = await client.deliveryPayment.trace(txnId)        // full life of one record
const report  = await client.deliveryPayment.verify(txnId)       // on-demand integrity check
const current = await client.deliveryPayment.get(txnId)          // current state, active keys, latest payload
```

### 11.4 Per-actor queries — generated methods

Every actor type gets a typed query namespace generated from the schema. This is the marquee read surface — direct match for the mental model "show me this driver's transactions."

```ts
// All transactions involving a specific driver
const page = await client.driver(driverId).transactions({
  type:       'DeliveryPayment',                  // optional
  state:      ['completed', 'refunded'],          // optional, single value or array
  since:      '2026-04-01',
  until:      '2026-05-01',
  limit:       50,
  cursor:      prev?.nextCursor,                  // keyset pagination
  orderBy:    'occurredAt:desc',                  // default
})
// → { items: TxnRecord[], nextCursor: string | null }

// All trails for a driver in a window (each item is a full trace)
const trails = await client.driver(driverId).trails({ since, until, limit: 25 })

// Aggregate summary
const summary = await client.driver(driverId).summary({ since, until })
// → { transitions, total_credited, total_debited, by_state, by_type }

// Same shape for every actor type
const userTopUps     = await client.user(userId).transactions({ type: 'WalletTopUp', state: 'funded', limit: 100 })
const companyRevenue = await client.company(companyId).summary({ since, until })
```

### 11.5 Account-centric queries

```ts
// Postings on a specific account
const movements = await client.account.history(driver.balance, {
  since,
  until,
  direction: 'C',                                 // optional: 'D' | 'C'
  amount:    { gte: 1000 },                       // optional range
  limit:      100,
  cursor,
})

// Current balance — O(1), reads the cache
const live = await client.account.balance(driver.balance)

// Point-in-time balance (replays postings up to a timestamp)
const past = await client.account.balanceAt(driver.balance, '2026-04-30T23:59:59Z')

// All accounts owned by an actor
const accs = await client.user(userId).accounts()

// Aggregate over an account (sum, count, etc.)
const stats = await client.account.aggregate(driver.balance, {
  since,
  until,
  metrics: ['count', 'sum_credit', 'sum_debit'],
})
```

### 11.6 Generic queries — Prisma-style

For ad-hoc filtering, the generic surface mirrors Prisma's `findMany`:

```ts
const txns = await client.transactions.findMany({
  where: {
    type:       'DeliveryPayment',
    state:      { in: ['completed', 'refunded'] },
    actor:      { type: 'Driver', id: driverId },
    amount:     { gte: 1000 },
    occurredAt: { gte: '2026-04-01', lt: '2026-05-01' },
  },
  orderBy: { occurredAt: 'desc' },
  limit:    50,
  cursor,
})

const transitions = await client.transitions.findMany({
  where: { name: 'refund', actor: { type: 'Company' } },
  limit: 100,
  cursor,
})

const anomalies = await client.anomalies.findMany({
  where: { severity: { in: ['error', 'critical'] }, resolved_at: null },
  limit: 100,
  cursor,
})

const postings = await client.postings.findMany({
  where: { account_id: driver.balance.id, amount: { gte: 500 } },
  limit: 200,
  cursor,
})
```

Every filter compiles to an index-covered query (§12.2). The package refuses to generate sequential scans on the hot path.

### 11.7 Pagination — keyset only, no OFFSET

Every list endpoint uses **keyset (cursor) pagination**. `OFFSET N` is never generated — it becomes prohibitively slow on large tables. The cursor is an opaque string encoding the last seen `(occurred_at, id)` tuple.

```ts
let cursor: string | undefined
do {
  const page = await client.driver(id).transactions({ limit: 1000, cursor })
  for (const t of page.items) processOne(t)
  cursor = page.nextCursor
} while (cursor)
```

Iteration over millions of records: O(N) total work, O(1) memory, constant per-page latency.

### 11.8 Subscriptions and hooks

```ts
client.deliveryPayment.on('completed', async ({ record, transition, unlocked }) => { ... })  // in-process
ledger.onAnomaly({ severity: 'critical' }, async (a) => pagerduty.trigger(a))                // cross-cutting
```

Out-of-process delivery (webhooks, queues) is a consumer concern: drain
the outbox with `engine.outbox.startWorker({ handler })` and do
whatever HTTP / signing / retry / dead-lettering your platform needs.
The library's job ends at exposing the events.

(Full hook surface in §8.)

---

## 12. Performance

Ledger is designed for top-of-line speed under realistic financial load — high-frequency writes (thousands of transitions per second per tenant), millions of postings per account, low-millisecond read latency on hot paths. Performance is a hard property, not an afterthought.

### 12.1 Performance budget per operation (p99)

| Operation                                 | Target       |
|-------------------------------------------|--------------|
| `transition()` — single state move        | < 10 ms      |
| `account.balance()` — cached read         | < 1 ms       |
| `transactions.findMany()` first page      | < 20 ms      |
| `account.history()` first page            | < 20 ms      |
| `trace(txnId)` — single record            | < 5 ms       |
| Per-record reconciliation (incremental)   | < 1 ms       |
| Outbox worker per-item dispatch overhead  | < 2 ms       |

If a query path can't meet its budget, it's not shipped until it can.

### 12.2 Indexes — every query path is covered

Migrations create the following indexes by default. No sequential scans on the hot path.

| Table             | Index                                                                            | Purpose                  |
|-------------------|----------------------------------------------------------------------------------|--------------------------|
| `txn_records`     | `(tenant_id, type, state, updated_at DESC)`                                      | List by type/state       |
| `txn_records`     | `(tenant_id, created_by_actor_type, created_by_actor_id, updated_at DESC)`       | List by creating actor   |
| `txn_transitions` | `(tenant_id, txn_id, id ASC)`                                                    | Trace one record         |
| `txn_transitions` | `(tenant_id, actor_type, actor_id, occurred_at DESC, id DESC)`                   | Per-actor query          |
| `txn_transitions` | `(tenant_id, txn_id, idempotency_key)` UNIQUE                                    | Idempotency              |
| `postings`        | `(tenant_id, account_id, occurred_at DESC, id DESC)`                             | Account history          |
| `postings`        | `(tenant_id, transition_id)`                                                     | Postings of a transition |
| `txn_keys`        | `(tenant_id, txn_id, status)` partial WHERE status = 'active'                    | Active key lookup        |
| `outbox`          | `(tenant_id, next_attempt_at, id)` partial WHERE delivered_at IS NULL            | Worker drain             |
| `txn_anomalies`   | `(tenant_id, severity, detected_at DESC)`                                        | Dashboards / hook routing|

### 12.3 Partitioning

`txn_transitions` and `postings` are partitioned by `occurred_at` monthly (with `tenant_id` as a leading partition key in row-level multi-tenant deployments). Effects:

- Cold partitions move to cheaper storage or archive cleanly.
- Reconciliation can scope to recent partitions (incremental verification).
- Tenant deletion is partition pruning, not row-by-row scan.
- VACUUM cost stays bounded.

### 12.4 Hot-path caching — already designed in

- **`accounts.balance` is the cache.** Every `transition()` updates it inside the same DB tx. Reads are O(1), no aggregation.
- **`txn_records.active_keys` (jsonb)** denormalizes capability-key lookups — no join on the hot path.
- **Compiled schemas.** Schema parsing happens at startup; runtime requests hit prepared statements only.

### 12.5 Reconciliation — incremental, watermarked

Full-table reconciliation on every sweep would not scale. Instead:

- Reconciler tracks a per-table watermark (last verified `id`).
- Each sweep verifies only rows since the watermark.
- A periodic full sweep (default: nightly) catches drift on cold rows.
- Hash chain verification is incremental — only the tail since the last verified `row_hash`.

Cost is O(Δ) per sweep, not O(N). At 1k transitions/sec, a 1-minute sweep verifies ~60k rows — small.

### 12.6 Read-replica routing

Read-only queries (`findMany`, `trace`, `history`, `balance`, summaries, dashboards) route to replicas via a configurable read-replica pool. Writes always hit primary. The runtime client picks the connection per operation; the consumer doesn't manage it.

For row-level multi-tenant deployments, replicas serve all tenants. For DB-per-tenant, replicas are per-tenant.

### 12.7 Bulk write API

For high-throughput ingestion (backfills, daily settlement, batch payouts):

```ts
await client.deliveryPayment.bulkTransition([
  { txnId, name: 'pay', by, idempotencyKey, data },
  { txnId, name: 'pay', by, idempotencyKey, data },
  // ... up to batchSize
], { batchSize: 1000 })
```

Same engine, same invariants, same hooks, same hash chain — but round-trip and locking cost amortized across the batch. Throughput target: ~10k transitions/sec per single-DB deployment.

### 12.8 Hooks and adapters never block the engine

- `beforeTransition` runs synchronously in the DB tx — must return fast (target: < 1 ms; engine kills runaway hooks).
- `afterTransition`, `onAnomaly`, etc. run on a hook worker pool, async, never blocking the transition.
- Adapter PSP calls happen *after* DB commit, drained from the outbox by separate workers. Engine throughput is independent of PSP latency.

### 12.9 Materialized projections (optional, high-traffic actors)

When actor-centric queries dominate (driver dashboards refreshing every second), projections give sub-millisecond reads:

```
projection driver_activity {
  source:      txn_transitions
  scope:       (tenant_id, actor_id) when actor_type = 'Driver'
  columns:     [transition_id, txn_id, txn_type, name, amount, occurred_at, state]
  maintained:  synchronously                 // same DB tx as source write
}
```

Maintained inside the writer's DB tx — no eventual consistency, no projection lag. Opt-in; most workloads are fine with the default indexes.

### 12.10 Connection pooling and prepared statements

The runtime client manages a connection pool with prepared statements for every transition type. Per-request overhead: parse-once, bind-and-execute on every call. Combined with RLS-set GUCs, this gives the engine a tight inner loop on the hot path.

---

## 13. Storage model

Ledger owns these tables in the consumer's Postgres and supplies its own migrations.

### `tenants`
`id` text PK · `name` text · `mode` enum(db | schema | row) · `state` enum(active | suspended | deleted) · `created_at`.

### `txn_records`
`id` uuid · `tenant_id` FK · `type` text · `state` text · `version` int · `active_keys` jsonb · `created_by_actor_type` text · `created_by_actor_id` text · `compromised` bool · `schema_version` int · `created_at`, `updated_at`.

### `txn_transitions`
`id` uuid (ULID) · `tenant_id` FK · `txn_id` FK · `from_state` text · `to_state` text · `name` text · `schema_version` int · `actor_type` text · `actor_id` text · `payload` jsonb · `idempotency_key` text · `trace_id` text · `prev_hash` bytea · `row_hash` bytea · `postings_checksum` bytea · `reverses` FK nullable · `occurred_at` timestamptz.

`UNIQUE (tenant_id, txn_id, idempotency_key)`.

### `txn_keys`
`id` uuid · `tenant_id` FK · `txn_id` FK · `name` text · `granted_by_transition_id` FK · `consumed_by_transition_id` FK nullable · `expires_at` nullable · `status` enum(active | consumed | expired).

### `accounts`
`id` uuid · `tenant_id` FK · `owner_actor_type` text · `owner_actor_id` text · `name` text · `parent_account_id` uuid nullable · `shard_index` int nullable · `currency` text · `balance` numeric · `created_at`.

`UNIQUE (tenant_id, owner_actor_type, owner_actor_id, name, currency, shard_index)`.

### `postings`
`id` uuid · `tenant_id` FK · `transition_id` FK · `account_id` FK · `amount` numeric · `direction` enum(D | C) · `occurred_at` timestamptz.

Append-only.

### `outbox`
`id` uuid · `tenant_id` FK · `txn_id` FK · `transition_id` FK · `event` text · `intent` text nullable · `payload` jsonb · `delivered_at` nullable · `attempts` int · `next_attempt_at` timestamptz · `last_error` text nullable.

`intent` carries the adapter outbound directive (e.g. `stripe.capture`).

### `txn_anomalies`
`id` uuid · `tenant_id` FK · `detected_at` timestamptz · `check_name` text · `txn_id` FK nullable · `account_id` FK nullable · `expected` jsonb · `observed` jsonb · `severity` enum(warn | error | critical) · `resolved_at` nullable · `resolved_by` text nullable · `resolution` text nullable.

### Database roles and RLS

Migrations create:

- `ledger_app` — `INSERT` only on `txn_transitions`, `postings`, `txn_anomalies`, `outbox`; constrained `UPDATE` only on `txn_records`, `accounts.balance`, `txn_keys.status`, `outbox.delivered_at`. No DELETE anywhere.
- `ledger_admin` — full access. Migrations and reconciler only.

Plus RLS policies on every table keyed off `current_setting('ledger.tenant_id')`.

### Write atomicity

Every transition is one DB transaction:

1. `SELECT … FOR UPDATE` on affected `accounts` rows (sorted by id).
2. `UPDATE txn_records SET state, active_keys, version = version + 1, updated_at = now() WHERE id = ? AND version = ? AND compromised = false AND tenant_id = ?`.
3. `INSERT txn_transitions` with computed `prev_hash`, `row_hash`, `postings_checksum`.
4. `INSERT N postings` (validated balanced before commit).
5. `INSERT` key grants, `UPDATE` consumed keys.
6. `INSERT outbox` row (if `emit` declared).
7. Fire `beforeTransition` hooks (pre-commit) and queue `afterTransition` hooks (post-commit).

All seven land or none do.

---

## 14. Schema evolution

Append-only history is the package's defining property: you never edit a transition row. So schema changes have to be expressed in a way that doesn't *require* editing history. The mechanism is **per-record schema versioning** plus a strong preference for **additive changes**.

### 14.1 The principle

Every `txn_record` and every `txn_transitions` row carries a `schema_version`. This is the version of the transaction type's definition that was active when the row was written. The engine keeps every prior schema version registered, so old records remain readable, queryable, and traceable forever — under their original semantics.

When the schema changes, you do **not** rewrite old rows. You bump `schema_version`. New records use the new version; old records keep their old version. Both coexist forever.

### 14.2 Change classification

Four kinds of change. Each has a different cost.

**Additive — free.** Adding a new field to a transition payload, a new state, a new transition, a new account type, a new actor type. Old records don't reference the new thing. Migration: bump `schema_version`, deploy. No data touched.

**Rename — almost free.** Renaming a field, state, transition, account, or actor. The engine stores an alias map per schema version. Old records read with original names; new records with new ones. The runtime client can expose both during a deprecation window.

**Restrictive — sometimes free, sometimes not.** Tightening a constraint — adding a new `invariant`, narrowing the actor union, requiring a previously optional field. Existing rows that already violate the new rule are left alone. Future writes are checked against the new rule. Retroactive enforcement requires forced reversal transitions, written by `ledger migrate --enforce <invariant>`.

**Destructive — most expensive.** Removing a field, state, or transition. The package never deletes — it deprecates. Removed elements stay readable for old records; new records cannot use them. To *evict* live records from a deprecated state, write a migration transition that moves them — itself a balanced, recorded transition. Same for currency changes on accounts.

The engine refuses to deploy a schema change that would orphan live records.

### 14.3 Tooling

- `ledger schema diff` — classifies each change, warns on destructive.
- `ledger schema migrate --plan` — shows the migration plan.
- `ledger schema migrate --apply` — executes, recording migration transitions where needed.
- `ledger schema versions` — lists live schema versions and record counts per version.

---

## 15. Use case examples

### 15.1 Logistics delivery (Chidori's primary case)

User pays 1500 for a delivery. Driver gets 500. Company keeps 1000.

```ts
const client = ledger.forTenant('chidori')

await client.account.create({ owner: user,    name: 'wallet',  currency: 'NGN' })
await client.account.create({ owner: driver,  name: 'balance', currency: 'NGN' })
await client.account.create({ owner: company, name: 'revenue', currency: 'NGN' })

const txn = await client.deliveryPayment.create({ by: user, idempotencyKey: 'd9001:create' })
const r   = await client.deliveryPayment.transition(txn.id, 'pay', {
  by:             user,
  idempotencyKey: 'd9001:pay',
  data:           { amount: 1500, driver_share: 500, company_share: 1000 },
})
```

Postings: debit `user.wallet` 1500; credit `driver.balance` 500; credit `company.revenue` 1000. Balanced. Audit trail captures actor, payload, timestamp, trace ID. The `refund` key is now active.

### 15.2 Delivery with a promo discount

```ts
await client.companyTransfer.transition(setupId, 'fund_promo', {
  by:   company,
  data: { from: company.revenue, to: company.promo_pool, amount: 1_000_000 },
})

await client.deliveryPayment.transition(txn.id, 'pay_with_promo', {
  by:             user,
  idempotencyKey: 'd9002:pay',
  data: { amount: 1500, driver_share: 500, company_share: 1000, promo: 200 },
})
```

Postings: debit `user.wallet` 1300; debit `company.promo_pool` 200; credit `driver.balance` 500; credit `company.revenue` 1000. Balanced. **Discounts are never phantom money — they always come from a real pre-funded account.**

### 15.3 Refund

```ts
await client.deliveryPayment.transition(txn.id, 'refund', {
  by:             company,
  withKey:        r.unlocked.refund,
  idempotencyKey: 'd9001:refund',
  data:           { reason: 'driver no-show' },
})
```

Engine inverts the original `pay` postings. The `refund` key is consumed; a second refund is impossible by construction.

### 15.4 Subscription with monthly renewals

```
transaction Subscription {
  initial:  trialing
  terminal: [cancelled, expired]

  transition activate: trialing -> active
    by: User
    postings:
      debit  user.wallet      monthly_price
      credit company.revenue  monthly_price
    unlocks: [renew, cancel]

  transition renew: active -> active
    by: System
    needs: renew
    postings:
      debit  user.wallet      monthly_price
      credit company.revenue  monthly_price
    unlocks: [renew, cancel]      // re-mints itself

  transition cancel: active -> cancelled
    by: User
    needs: cancel
}
```

A scheduler calls `renew` once a month. Each renewal re-mints fresh keys.

### 15.5 Marketplace escrow

```
transaction Escrow {
  initial:  held
  terminal: [released, refunded]

  transition hold: <none> -> held
    by: User
    postings:
      debit  user.wallet     amount
      credit company.escrow  amount
    unlocks: [release, refund]

  transition release: held -> released
    by: System
    needs: release
    postings:
      debit  company.escrow  amount
      credit seller.balance  amount

  transition refund: held -> refunded
    by: User | Company
    needs: refund
    postings:
      debit  company.escrow  amount
      credit user.wallet     amount
}
```

Money sits in `company.escrow` until released or refunded. Real ledger account, real balance, real audit.

### 15.6 Wallet top-up via Stripe adapter

```ts
// Schema declares a transition with an outbound intent
transaction WalletTopUp {
  transition request: initiated -> awaiting_psp
    by: User
    requires: { amount, payment_method_id }
    emit: "stripe.capture"   // adapter routes this

  transition mark_funded: awaiting_psp -> funded
    by: System (via stripe adapter)
    requires: { psp_reference, amount }
    postings:
      debit  company.psp_clearing  amount
      credit user.wallet           amount
}

// Application code
await client.walletTopUp.transition(txnId, 'request', {
  by: user, idempotencyKey: 't:1', data: { amount: 5000, payment_method_id: 'pm_x' },
})
// Adapter worker picks it up, calls Stripe with idempotency_key, drives mark_funded on success.
// User's wallet is credited only after Stripe confirms.
```

### 15.7 Tamper detection in action

A support engineer "fixes" a stuck record:

```sql
UPDATE postings SET amount = 0 WHERE id = '...';
```

Within the next reconciler sweep:

1. `postings_checksum` mismatch detected. Anomaly written.
2. `accounts.balance` drift detected. Anomaly written.
3. Affected `txn_record` marked `compromised`.
4. `onAnomaly` and `onQuarantine` hooks fire — paging, Slack, custom escalation, all under developer control.
5. If recoverable, a reversal transition is emitted automatically. Audit shows tamper + correction.
6. If not, the record stays quarantined for human review.

### 15.8 Anomaly hook routing

```ts
// Critical anomalies page on-call
ledger.onAnomaly({ severity: 'critical' }, async (a) => {
  await pagerduty.trigger({ severity: 'P1', details: a })
})

// Per-tenant: ACME wants its own incident system
ledger.onAnomaly({ tenantId: 'org-acme' }, async (a) => {
  await acmeIncidentApi.create(a)
})

// Diagnostic: send all balance drifts to Sentry
ledger.onAnomaly({ check: 'balance_drift' }, async (a) => {
  await sentry.capture(a)
})

// Custom predicate: flag ones touching merchant accounts
ledger.onAnomaly(
  (a) => a.context.account?.owner_actor_type === 'Merchant',
  async (a) => merchantOpsAlert(a),
)
```

All four handlers fire on a matching anomaly. None blocks the engine.

### 15.9 Driver dashboard — query API in action

Render a driver's last 30 days of paid deliveries, total earnings, and a paginated activity feed. All calls are index-covered and route to read replicas.

```ts
const client = ledger.forTenant('chidori')
const driverId = 'drv_42'

// Header: aggregate summary
const summary = await client.driver(driverId).summary({
  since: '2026-04-01',
  until: '2026-05-01',
})
// { transitions: 312, total_credited: 156_000, total_debited: 0,
//   by_state: { completed: 290, refunded: 22 }, by_type: { DeliveryPayment: 312 } }

// Live wallet/balance — O(1)
const balance = await client.account.balance(driverBalanceAcc)

// Activity feed — keyset paginated, p99 < 20ms
const page1 = await client.driver(driverId).transactions({
  type:   'DeliveryPayment',
  state:  ['completed', 'refunded'],
  since:  '2026-04-01',
  until:  '2026-05-01',
  limit:   25,
})
const page2 = await client.driver(driverId).transactions({
  cursor: page1.nextCursor,
  limit:  25,
})

// Drill into one delivery: full trail
const trail = await client.deliveryPayment.trace(page1.items[0].id)

// Earnings statement: only credits, sorted desc
const credits = await client.account.history(driverBalanceAcc, {
  since:    '2026-04-01',
  until:    '2026-05-01',
  direction: 'C',
  limit:     100,
})
```

For a heavy dashboard refreshing every second, declare a `driver_activity` projection (§12.9) and the per-actor query becomes sub-millisecond — same API, just faster underneath.

---

## 16. Design rationale

### Why double-entry, not a "transfer" API?

A transfer API hides the second leg. With explicit postings, every transition makes both legs visible. You can never accidentally credit a driver without an equivalent debit. Reconciliation reduces to one query: do account balances match the sum of their postings?

### Why capability keys instead of just webhooks?

Webhooks describe what happened. Keys describe what's *now allowed*. Webhooks for out-of-process; keys for in-process gating with the same atomic guarantees as the transition that minted them.

### Why is `accounts.balance` denormalized?

O(1) reads for hot paths. Postings remain the source of truth — balance is a cache, recomputable. Drift between cache and posting sum is itself a detectable bug, surfaced by the reconciler and routed through `onAnomaly`.

### Why hash chains and append-only roles?

A library that only enforces invariants when its API is used has a giant blind spot: anything that touches the DB outside the API. Hash chains + DB role restrictions push enforcement *below* the application layer. Tamper detection becomes inevitable.

### Why detect-and-quarantine instead of auto-fix?

Auto-fixing an inconsistency of unknown origin is guessing about money. The package only auto-corrects when the original signal is recoverable from a trusted source. Otherwise: halt and fire the hook.

### Why are anomaly hooks in-process and not webhooks?

Anomaly response is operational: paging, on-call routing, custom incident systems. These are application code, not external integrations. Hooks let developers express that code with full type safety and zero infrastructure. Webhooks (via outbox) remain available for cross-process broadcast.

### Why first-class multi-tenancy?

Most financial products serve multiple customers. Adding tenant scoping after the fact means every query has to be retrofitted. Building it in from day one — including RLS at the DB level — means a forgotten filter is a database error, not a leak.

### Why outbox-mediated adapters instead of in-transition PSP calls?

The dual-write problem. An in-transition PSP call can succeed at Stripe and fail at the DB, or vice versa. The outbox pattern guarantees that the DB commit is the source of truth and the external call is its consequence. PSP idempotency keys make worker retries safe.

### Why one DB transaction for everything inside a transition?

If state, postings, keys, hash chain, and outbox could disagree, the package is broken. One DB tx is the only way the four invariants hold.

### Why Postgres-only, no consensus protocol?

Postgres gives us serializable isolation, row-level locks, `FOR UPDATE SKIP LOCKED`, uniqueness constraints, and RLS. Those five primitives are enough to build a correct distributed multi-tenant ledger when every participant talks to the same DB. Cross-DB problems get sagas, not 2PC.

---

## 17. Boundaries

There are no out-of-scope features in this design. Every operational concern has an explicit place: adapters for PSP integration, hooks for observability and business rules, the reference schema library for common patterns, multi-tenancy as a first-class concept, sagas for cross-service flows, migration transitions for schema evolution.

What follows are *boundaries* — places where Ledger ends and the consumer's code begins. They are stable.

- **Ledger is not a PSP.** It does not hold a license to move money. Adapters bridge to PSPs; they're the only thing in the system that touches the real world.
- **Ledger is not a domain ORM.** It doesn't define what a "subscription" or "marketplace order" is. Reference schemas exist as starting points; consumers own their domain.
- **Ledger is not a cross-database coordinator.** When you need atomicity across separate DBs, use sagas. The package does not attempt 2PC or invent a consensus protocol.
- **Ledger is not a workflow engine.** Capability keys gate progression, but the package is not Temporal/Inngest. If your "workflow" is mostly non-financial state with timeouts and human approval steps, use a workflow engine and have it drive Ledger transitions.
- **Ledger does not own your identity system.** Actors are typed records the consumer creates and references. Auth and identity are upstream concerns.

---

## 18. Roadmap

Each milestone is independently shippable. `tenant_id` and `schema_version` columns are present from M1 even when their full machinery lands later — this avoids an irreversible migration cost.

| Milestone | Scope                                                                                                 |
|-----------|-------------------------------------------------------------------------------------------------------|
| M1        | State + idempotency. Schema DSL, transitions, idempotency keys, audit table, runtime client. `tenant_id` / `schema_version` stamped from day one. **All performance-critical indexes and keyset pagination are baked in from M1 — speed is not a later milestone.** |
| M2        | Accounts + postings. Double-entry, balanced-transition enforcement, account history, balance cache (O(1) reads). |
| M3        | Capability keys. `unlocks`, `needs`, expiration, single-use enforcement.                              |
| M4        | **Multi-tenancy enforcement.** RLS policies, tenant client, `tenant.create / delete / suspend / relocate`, per-tenant outbox + reconciliation. |
| M5        | **Query API.** Per-actor generated methods (`client.driver(id).transactions(...)`), generic `findMany`, `account.history`, `account.balanceAt`, `summary`, all keyset-paginated. |
| M6        | Outbox + webhooks. Event emission, retry worker, signed delivery.                                     |
| M7        | **Integrity.** Hash chains, posting checksums, append-only DB roles, reconciler with watermarks, anomalies table, quarantine. |
| M8        | **Hooks framework.** `beforeTransition`, `afterTransition`, `onAnomaly`, `onQuarantine`, `onOutboxFailureTerminal`, etc. Filters + composable handlers. |
| M9        | Distributed operation. Optimistic record versioning, account row locking, hot-account sharding, saga support. |
| M10       | Self-correction. Reversal transitions, automated repair of recoverable anomalies, drift auto-repair. |
| M11       | Schema evolution tooling. Alias maps, schema-diff classifier, migration-transition CLI, eviction planner. |
| M12       | **Adapter SDK + first-party adapters.** Stripe, Paystack, Flutterwave, NIBSS, Plaid, Mocked.          |
| M13       | **Reference schema library.** Subscription, marketplace, payout, wallet, card-payment, FX, logistics. |
| M14       | General tooling. Reconciliation reports, trace inspector, anomaly dashboard, tenant dashboard.        |
| M15       | **Performance hardening.** Partitioning, read-replica routing, materialized projections, bulk write API, prepared-statement pooling. |
| M16       | Multi-currency. Per-account currency, FX postings, rate-aware reconciliation.                         |
| M17       | Holds, scheduled transitions, dispute primitives. Built on existing primitives.                       |

M1–M3 are the minimum viable kernel. M4 + M5 + M7 + M8 + M9 are non-negotiable for production financial use. Performance is a property of the system from M1 (budgets, indexes, pagination, balance cache); M15 is hardening for high-traffic deployments — partitioning, replicas, projections.

---

## 19. Open questions before M1

- **DSL surface** — external file (`ledger.schema`) parsed at build time, or in-code builder API (`defineTransaction(...)`)? Prisma went file-based; Drizzle went in-code.
- **Storage** — Postgres-only for v1, or pluggable adapter? Recommendation: Postgres-only; add adapters when a real consumer demands it.
- **Type generation** — codegen step, runtime types, or TS plugin?
- **Currency precision** — integer minor units (kobo / cents) as `bigint`. No floats anywhere.
- **Soft deletes** — recommendation: none. Append-only.
- **Hash function** — SHA-256 default. Consider BLAKE3 if reconciliation is a bottleneck.
- **Reconciler placement** — in-process worker shipped with the library, or external CLI binary the consumer schedules?
- **Default tenancy mode** — row-level with RLS (most flexible) or schema-per-tenant (simpler ops)?
- **Hook execution pool** — single shared worker or per-hook isolation? Affects blast radius of slow hooks.
- **Adapter packaging** — first-party adapters in the same repo or separate? Affects release cadence.
- **Name** — "Ledger" is a working title. Other candidates welcome.

---

## 20. Glossary

- **Transaction (record)** — one instance of a transaction type. Has an id, a tenant, a current state, and a history of transitions.
- **Transition** — one named, validated move between states. Carries actor, payload, postings, key effects, hash chain links.
- **Posting** — one debit or credit on an account, recorded against a transition.
- **Account** — a balance-bearing entity owned by an actor. Has a currency and a parent (for sub-accounts and shards).
- **Actor** — a typed party that can drive a transition.
- **Tenant** — top-level scope; every actor, account, and record belongs to exactly one tenant. First-class.
- **Capability key** — a token minted by one transition and required by another. Gates progression in-process.
- **Outbox event** — a row dropped for out-of-process listeners (webhooks, queues, adapters).
- **Adapter** — a small package bridging Ledger to a PSP/bank. Outbound flow drains intents from the outbox; inbound flow maps provider webhooks to transitions.
- **Reference schema** — a starter schema fragment shipped by the package (subscription, marketplace, payout, etc.). Optional; consumers can copy and modify.
- **Hook** — an in-process callback fired on a lifecycle, anomaly, or outbox-failure event. Developer-defined, type-safe, composable.
- **Trace** — the full ordered list of transitions on a record, with actors, payloads, postings, timestamps.
- **Reconciliation** — the periodic check that the engine's invariants still hold against the actual table state.
- **Anomaly** — a recorded inconsistency detected by reconciliation. Tracked in `txn_anomalies` and routed through `onAnomaly`.
- **Quarantine** — marking a record `compromised` so the engine refuses further transitions until it's cleared.
- **Reversal transition** — a recorded, balanced transition that undoes a previous one. Carries a `reverses` link.
- **Saga** — a sequence of transitions (often across services) coordinated via capability keys, with compensating reversals on failure.
- **Hash chain** — the per-record linking of `txn_transitions` rows via `prev_hash` + `row_hash`. Breaks on tampering.
- **Hot-account sharding** — splitting a high-traffic account into N internal shard rows to remove serialization bottlenecks.
- **Schema version** — number stamped on every record and transition indicating which version of the transaction type's definition was active when it was written.
- **Alias map** — per-version table of old-name → new-name pairs that lets the engine read records written under earlier schemas without rewriting them.
- **Migration transition** — a normal, balanced, recorded transition whose purpose is to evict a record from a deprecated state, currency, or shape.
- **RLS (Row-Level Security)** — Postgres feature used to enforce tenant isolation at the database, below the application layer.
- **Intent** — typed outbound directive in an outbox row (e.g. `stripe.capture`) that an adapter worker drains and acts on.
- **Keyset pagination** — cursor-based pagination using `(occurred_at, id)` as the seek key. The package never generates `OFFSET`-based queries; cursors are opaque strings.
- **Projection** — an opt-in denormalized table maintained inside the writer's DB transaction for sub-millisecond actor-centric reads. No eventual consistency.
- **Watermark** — a per-table `id` cursor remembered by the reconciler so each sweep verifies only rows since the last sweep — incremental, O(Δ) cost.
- **Partition** — Postgres declarative partitioning of `txn_transitions` and `postings` by `occurred_at` (and `tenant_id` in row-level multi-tenant deployments) to bound VACUUM cost and enable cheap archival.x