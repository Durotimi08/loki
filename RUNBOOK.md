# Runbook

What to do when things go wrong. Written for the on-call engineer responding to a Loki alert at 3 a.m.; keep it open in another tab while you triage.

If you're new to Loki, read the project README first — this document assumes you know what a transition, a reconciler pass, and an outbox row are.

---

## Reading reconciler alerts

`onAnomaly` and `onIntegrityViolation` hooks are how the reconciler tells you something went sideways. The fields you care about:

| field | what it tells you |
|---|---|
| `check` | the failed invariant — see table below |
| `severity` | `warn`, `error`, `critical`. `critical` triggers quarantine unless suppressed |
| `tenantId` / `txnId` | the blast radius — is one tenant affected, one record? |
| `expected` / `observed` | what the reconciler computed vs. what's stored |
| `context` | check-specific extras — e.g. `{ keyId, keyName }` for fabricated_key |

Check-by-check triage:

### `balance_drift` (severity: error)

`accounts.balance` no longer matches `sum(credits) - sum(debits)` from postings.

**What it means.** Someone wrote to `accounts.balance` outside the engine, OR a posting was inserted/deleted outside the engine. The postings are the source of truth — `balance` is just a cache.

**First moves.**
1. Check `engine.connection.sql` access logs — who has DML on `accounts`?
2. `runOnce({ repairBalanceDrift: true })` rebuilds the cache. Run this **only** after you've confirmed the postings are correct.
3. If multiple accounts are drifting, suspect a misconfigured runtime role — `loki_app` should only have `UPDATE (balance)` not full UPDATE.

**Don't do.** Don't UPDATE balance directly to "fix" it — that just makes the next sweep see the same drift.

### `unbalanced_postings` (severity: critical → quarantine)

A transition's postings no longer sum-to-zero per currency.

**What it means.** Someone DELETE-ed or INSERT-ed a row in `postings` outside the engine — the transition's `postings_checksum` would catch the deletion if it changed the row, but a sibling row insert breaks the invariant differently.

**First moves.**
1. The affected `txn_id` is quarantined; further transitions on it will throw `CompromisedRecordError`.
2. Recover the original postings from a backup or WAL replay.
3. If you can't recover: write a balanced reversal manually under admin role, then **clear the quarantine** with `engine.admin.records.uncompromise(...)` (intentional manual override).

**Don't do.** Don't INSERT a "balancing" row to make the math work — that obscures the audit trail.

### `hash_chain_break` (severity: critical → quarantine)

A transition row's `row_hash` doesn't match what the engine would recompute, or `prev_hash` doesn't match the predecessor's `row_hash`.

**What it means.** The strongest tamper signal we have. Either a row was edited in-place or one was inserted between two existing rows in a chain.

**First moves.**
1. The record is quarantined. Don't clear it until you understand what changed.
2. Pull the affected transition row + the chain neighbors. The `expected.row_hash` in the anomaly is what the engine recomputed; `observed.row_hash` is what's stored. Diff the row content against your audit log / backup.
3. If you find the rogue write (e.g. an admin running an UPDATE), revert from backup.
4. After restore, re-run the reconciler. The same alert should clear; if it doesn't, the chain is still inconsistent.

**Don't do.** Don't `DELETE` quarantined records — `txn_records.compromised = true` is intentional and the audit trail must persist.

### `checksum_mismatch` (severity: critical → quarantine)

Recomputed `postings_checksum` doesn't match what's stored on the transition.

**What it means.** Same threat model as `hash_chain_break` but specific to the postings of one transition.

**First moves.** Same as `unbalanced_postings`.

### `state_mismatch` (severity: error)

`txn_records.state` doesn't match the latest transition's `to_state`.

**What it means.** The cached state column drifted. This can happen if someone UPDATE-ed `state` directly, or if a buggy migration changed the source of truth.

**First moves.**
1. `runOnce({ repairStateMismatch: true })` bumps the cached state to the latest transition's `to_state`. Safe — transitions are the source of truth.
2. If the same record keeps drifting, check for a hook or trigger that writes to `txn_records.state` outside the engine.

### `fabricated_key` (severity: critical → quarantine, OR error if repaired)

A `txn_keys` row's `granted_by_transition_id` references a transition that doesn't exist.

**What it means.** Someone INSERT-ed a fake capability key. Either an admin bypassed the FK trigger, or a backup restore left dangling key rows.

**First moves.**
1. `runOnce({ repairFabricatedKeys: true })` flips the orphan key from `active` → `expired` and **skips** quarantine. This is safe because the key can't be legitimately consumed (no transition to mint it from).
2. If you don't repair, the affected record is quarantined — fine if you want to investigate before clearing.

### `fx_rate_drift` (severity: error)

A rate-pinned transition's `data.rate` either disagrees with the published `fx_rates` row beyond `fxRateTolerance`, or there's no published rate the verifier can compare against. The reconciler does NOT compare against the *current* rate — it looks up whichever rate had `fixed_at <= transition.occurred_at` (filtered by `data.rateSource` if the transition pinned one). So old transitions pinned at an old rate stay clean even after the rate changes.

**Read `observed.status` to discriminate the two failure modes:**

| `observed.status` | what happened |
|---|---|
| `undefined` (default) | classic drift — published rate exists but differs from the pinned rate beyond tolerance |
| `'no_rate_in_effect'` | no published rate matches `(tenant, base, quote, source, fixed_at <= occurred_at, expires_at > occurred_at)` |

**Drift case (the classic).**

1. Look at `expected.rate` (published) vs `observed.rate` (pinned). If the published rate is the right one, the transition's rate is wrong — drive a corrective transition.
2. If the transition's rate is right (you locked an off-table custom rate for a customer), republish the rate to `fx_rates` with the correct `fixed_at`, OR raise `fxRateTolerance` for this tenant.

**No-rate-in-effect case.**

1. Check the transition's `payload.rateSource` and `occurred_at`. The reconciler is filtering by source — a transition pinned to `cbn` is only compared against `cbn` rows.
2. Three common causes:
   - **Operator forgot to publish.** Publish the rate now with the correct `fixed_at` (≤ the transition's `occurred_at`).
   - **Coverage gap from `expires_at`.** The previous rate's `expires_at` was before the transition's `occurred_at` and the next rate's `fixed_at` was after. Publish a backfill row covering the gap.
   - **Source typo.** The transition pinned `rateSource: 'cbn'` but the rate was published as `'CBN'` (case mismatch, or trailing whitespace). Strings are matched exactly.
3. If you don't publish a backfill row, the anomaly stays in `txn_anomalies` until manually resolved — it's not auto-repairable.

---

## Quarantined records

A record is quarantined (`txn_records.compromised = true`) when a critical anomaly is recorded against it. The engine refuses further transitions on a quarantined record — every call throws `CompromisedRecordError`.

**Recovery checklist.**

1. Fetch the record's full trail: `engine.forTenant(tenantId).transactions.trace(recordId)`.
2. Compare against your audit log / backup. Identify what was tampered with.
3. Restore the row(s) from backup OR write a corrective admin-side patch.
4. Re-run the reconciler — confirm the anomaly clears.
5. Manually clear quarantine via `engine.admin.records.uncompromise(...)` (or directly via SQL as `ledger_admin`: `UPDATE txn_records SET compromised = false WHERE id = '...'`). The reconciler will NOT auto-clear quarantine — clearing it is an explicit operator decision.

**Never** delete a quarantined record. The audit trail is regulatorily significant; the row must persist even after recovery.

---

## `MigrationMismatchError`

Thrown by `engine.migrate()` when an applied migration's checksum doesn't match the plan the engine generated for the same `id`.

**What it means.** Either:

1. The schema changed and you forgot to bump `version` in `defineSchema(...)`.
2. The migration framework changed (engine upgrade) and the new checksum is the right one — you'll need to acknowledge the rewrite.
3. Someone hand-edited the engine tables and the migration ledger no longer matches reality.

**First moves.**
1. Diff the failing migration's `up` against the applied SQL stored in `_loki_migrations.up_sql`.
2. If the diff is the expected schema change, bump `defineSchema({ version })` and write a new migration plan instead of mutating the existing one.
3. If the diff is unexpected, treat it as a tamper signal — see "Quarantined records" above.

**Never** manually edit `_loki_migrations.checksum` to make the error go away. That breaks the integrity guarantee that the ledger represents the actual schema state.

---

## Migrating between tenancy modes

Three modes: `rls` (default, all tenants share one schema), `schema-per-tenant`, `db-per-tenant`. Migration in production is **disruptive** — schedule a maintenance window.

### RLS → schema-per-tenant

For each tenant `T`:

1. Create a new Postgres schema named `t_T` (or your prefix scheme).
2. Run `engine.migrate()` with the `tablePrefix` set to `t_T_` so the engine tables exist in the new schema.
3. Copy the tenant's data over: `INSERT INTO t_T.txn_records SELECT * FROM public.txn_records WHERE tenant_id = 'T'` (and similarly for every engine table).
4. Verify a `runOnce({ tenantId: 'T' })` against the new schema reports zero anomalies.
5. Switch the engine's `connectionFor(tenantId)` to return a `withSearchPath(base, 't_T')` for `T`.
6. After confirming the new schema is healthy, DELETE the rows from the shared schema (`DELETE FROM public.txn_records WHERE tenant_id = 'T'` etc.). **DO NOT** drop the rows until you've run the new schema for at least one full reconciler cycle in production.

### RLS → db-per-tenant

Same shape, but step 1 is `CREATE DATABASE` and step 5 returns an entirely separate `Connection`. Useful for the highest-isolation cases (regulator-mandated data residency, very large customers).

### Rollback

Keep the old data for at least one billing cycle. If something goes wrong, `connectionFor` reverts to `null` (RLS fallback) and you're back where you started.

---

## Outbox stuck / failed

`onOutboxFailureTerminal` fires when a row hits `maxAttempts`. Common causes:

- The PSP's idempotency key collided (unlikely — Loki uses the outbox row id).
- Network partition; recover by adjusting `maxAttempts` or extending `claimTtlMs` and re-running.
- The handler throws synchronously on every event — the worker can't make progress.

**Manual intervention.**

```sql
-- See what's stuck
SELECT id, event, attempts, last_error FROM outbox WHERE failed_at IS NOT NULL;

-- Reset for retry (only after fixing the underlying issue)
UPDATE outbox
   SET failed_at = NULL, attempts = 0, next_attempt_at = now()
 WHERE id IN (...);
```

The worker will pick the row up on the next tick.

---

## Health probe failure

`engine.health()` returns `ok: false`. Inspect the report:

| failure | next move |
|---|---|
| `primary.ok = false` | DB is unreachable. Check `psql $DATABASE_URL`, network, RDS / Cloud SQL status page. |
| `replica.ok = false` | replica is down or lagging beyond reach. Failover; consider `readYourWrites: 'off'` until restored. |
| `migrations.applied = false` | bootstrap migration hasn't run yet. Block traffic until `loki migrate apply` succeeds. |
| `replica.lagBytes > <threshold>` | replica is far behind. Investigate WAL replay slot, replication lag dashboard. |

---

## "I don't know what's wrong"

Default troubleshooting order:

1. Run `engine.health()`. Eliminate the boring causes.
2. Run `engine.reconciler.runOnce({ tenantId })`. Captures any active integrity issues.
3. Pull the affected record's trail (`engine.forTenant(tenantId).transactions.trace(id)`) and compare to your audit log.
4. Check `txn_anomalies` — there may be older unresolved anomalies that point at the same issue.
5. If you suspect a tamper, isolate the affected DB role and rotate credentials before further investigation.

When in doubt: **don't write to the engine tables manually**. The reconciler will catch a partial fix and quarantine the record. The right move is almost always a corrective transition under the typed API.
