import { type PayloadCrypto, decryptPayload } from '../primitives/payload-crypto.js'
import { type AnomalyDraft, recordAnomaly } from './anomalies.js'
import type { CanonicalValue } from './canonical.js'
import type { Connection, SqlTransaction } from './connection.js'
import { type Hasher, computePostingsChecksum, computeRowHash } from './hash.js'
import type { AnomalyEvent, HookRegistry, QuarantineEvent } from './hooks.js'
import { type EngineInstruments, buildInstruments } from './observability.js'

/**
 * The §5.2 reconciler. Periodically verifies the engine's invariants
 * against actual table state. Each failure is written to
 * `txn_anomalies` AND emitted through `onAnomaly`. Critical
 * inconsistencies — hash chain breaks, checksum mismatches —
 * additionally mark the affected record `compromised` so the engine
 * refuses further transitions until cleared.
 *
 * Five checks are implemented:
 *
 *   1. balance_drift       — `accounts.balance` vs the recomputed
 *                            sum from postings (credits minus debits).
 *   2. unbalanced_postings — sum(D) ≠ sum(C) on a transition.
 *   3. checksum_mismatch   — recomputed `postings_checksum` ≠ stored.
 *   4. hash_chain_break    — recomputed `row_hash` ≠ stored, or
 *                            `prev_hash` ≠ predecessor's `row_hash`.
 *   5. state_mismatch      — `txn_records.state` ≠ latest transition's
 *                            `to_state`.
 *
 * Reconciliation is scoped to a tenant when `tenantId` is supplied;
 * otherwise it sweeps every tenant under admin context.
 */

export type RunOnceOptions = {
  /** Limit the sweep to a specific tenant. Default: every tenant. */
  readonly tenantId?: string
  /** If true, marks records `compromised` on integrity-class anomalies. Default true. */
  readonly quarantine?: boolean
  /**
   * If true, recomputes `accounts.balance` from postings whenever a
   * `balance_drift` anomaly is detected. The anomaly is still recorded
   * and routed through `onAnomaly`, but the cached column is also
   * brought back in line — drift is the only "recoverable" anomaly
   * the engine can fix without guessing (postings are the source of
   * truth; balance is just a cache). Default `false`. (§5.3.4)
   */
  readonly repairBalanceDrift?: boolean
  /**
   * If true, repairs `state_mismatch` anomalies by bumping
   * `txn_records.state` to the latest transition's `to_state` (M10).
   * Honest scope: this is only safe because the source of truth is
   * the transitions table — the cached `state` column is just a
   * denorm. The anomaly is still recorded and routed through
   * `onAnomaly`. Default `false`.
   */
  readonly repairStateMismatch?: boolean
  /**
   * If true, flips `fabricated_key` keys from `active` to `expired`
   * (M10). A fabricated key references a `granted_by_transition_id`
   * that doesn't exist, so it can never be legitimately consumed —
   * expiring it removes it from the active set without inventing a
   * reversal we can't justify. Default `false`.
   */
  readonly repairFabricatedKeys?: boolean
  /**
   * Tolerance (relative, decimal) for rate-pinned transitions verified
   * against the FX table (M16). A transition with `data.rate` of
   * `4.5` and a published rate of `4.502` is `(0.002/4.5) ≈ 0.00044`
   * off; a `0.0005` tolerance accepts it, `0.0001` rejects it.
   * Default `0.0001` (one basis point). Pass `0` to require exact match.
   */
  readonly fxRateTolerance?: number
  /**
   * Force a full sweep even when a watermark exists. Default false:
   * transition-scoped checks only verify rows above the watermark,
   * which is O(Δ) per pass instead of O(N). The full-sweep option is
   * what you'd schedule nightly to catch drift on cold rows.
   */
  readonly fullSweep?: boolean
}

export const RECONCILER_STATE_TABLE = '_loki_reconciler_state'

export type RunOnceResult = {
  readonly anomalies: readonly AnomalyEvent[]
  readonly quarantined: readonly string[]
  /** Account ids whose `balance` column the reconciler rebuilt this pass. */
  readonly repaired: readonly string[]
  /** Keys whose `expires_at` had passed and were flipped from `active` → `expired`. */
  readonly expiredKeys: number
  /**
   * Record ids whose cached `state` was bumped to the latest transition's
   * `to_state` because of `state_mismatch` + `repairStateMismatch: true` (M10).
   */
  readonly stateRepaired: readonly string[]
  /**
   * Key ids that were flipped from `active` → `expired` because they
   * referenced a non-existent transition + `repairFabricatedKeys: true` (M10).
   */
  readonly fabricatedKeysExpired: readonly string[]
}

/**
 * When to run a reconciliation pass. The library doesn't import a cron
 * library; the four kinds below cover the common operational cadences
 * (and you can always call `runOnce()` from your own scheduler if you
 * need something more exotic).
 *
 *   - `continuous` — fire every `intervalMs`. The historical default.
 *   - `daily`      — fire once a day at `at` (HH:MM[:SS]).
 *   - `weekly`     — fire once a week on `dayOfWeek` (0=Sun … 6=Sat) at `at`.
 *   - `monthly`    — fire once a month on `dayOfMonth` at `at`.
 *                    Day 31 in a 30-day month fires on the last day.
 *
 * `tz` selects the time zone the wall-clock comparison uses. `'utc'`
 * is the safe default for distributed deployments; `'local'` uses the
 * host process's timezone.
 */
export type ReconcilerSchedule =
  | { readonly kind: 'continuous'; readonly intervalMs: number }
  | { readonly kind: 'daily'; readonly at: string; readonly tz?: 'local' | 'utc' }
  | {
      readonly kind: 'weekly'
      readonly dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6
      readonly at: string
      readonly tz?: 'local' | 'utc'
    }
  | {
      readonly kind: 'monthly'
      readonly dayOfMonth: number
      readonly at: string
      readonly tz?: 'local' | 'utc'
    }

export type StartOptions = {
  /** Legacy: `intervalMs: N` is shorthand for `schedule: { kind: 'continuous', intervalMs: N }`. */
  readonly intervalMs?: number
  /**
   * Schedule for incremental (watermarked) sweeps. Default:
   * `{ kind: 'continuous', intervalMs: 60_000 }`.
   */
  readonly schedule?: ReconcilerSchedule
  /**
   * Optional separate schedule for full sweeps (`fullSweep: true`).
   * Common pattern: continuous incremental + weekly full sweep on
   * Sunday at 02:00 to catch drift on cold rows.
   */
  readonly fullSweepSchedule?: ReconcilerSchedule
  readonly tenantId?: string
  readonly onError?: (e: unknown) => void
}

export type ReconcilerHandle = {
  readonly stop: () => Promise<void>
  /** Resolves on the next reconciliation pass for tests / orchestration. */
  readonly nextPass: () => Promise<RunOnceResult>
}

export type Reconciler = {
  /** Run a single reconciliation pass synchronously and return the report. */
  runOnce(options?: RunOnceOptions): Promise<RunOnceResult>
  /** Run continuously on an interval; returns a handle to stop. */
  start(options?: StartOptions): ReconcilerHandle
}

export type ReconcilerContext = {
  readonly connection: Connection
  readonly hasher: Hasher
  readonly hooks: HookRegistry
  /** Optional table prefix (M2). Default ''. */
  readonly tablePrefix?: string
  /**
   * Optional payload-crypto hook (M6). When set, the reconciler
   * decrypts each transition's stored envelope before recomputing
   * `row_hash` so the hash chain remains valid across encryption.
   */
  readonly payloadCrypto?: PayloadCrypto
  /** Observability instruments (Batch H). Defaults to no-op shims. */
  readonly instruments?: EngineInstruments
}

export function createReconciler(ctx: ReconcilerContext): Reconciler {
  const stateTable = `${ctx.tablePrefix ?? ''}${RECONCILER_STATE_TABLE}`
  const instruments = ctx.instruments ?? buildInstruments()
  return {
    async runOnce(options = {}) {
      const startedAt = new Date()
      const startTime = Date.now()
      const quarantine = options.quarantine ?? true
      const drafts: AnomalyDraft[] = []
      const integrityRecordIds: string[] = []

      const driftAccountIds = new Set<string>()
      const stateMismatchRecordIds = new Set<string>()
      const fabricatedKeyIds = new Set<string>()
      let expiredKeys = 0
      // Six checks share a single transition-id watermark axis. Tracking
      // them under different keys lets us advance them at different
      // rates if a check ever skips its turn (e.g. on an aborted pass).
      const checkKeys = ['transitions', 'drift', 'state', 'keys'] as const
      type CheckKey = (typeof checkKeys)[number]
      const watermarks: Record<CheckKey, string | null> = {
        transitions: null,
        drift: null,
        state: null,
        keys: null,
      }
      let watermarkAfter: string | null = null
      const fullSweep = options.fullSweep ?? false
      await ctx.connection.asAdmin(async (tx) => {
        const tenantFilter = options.tenantId
        const scope = tenantFilter ?? '*'

        await ensureReconcilerStateTable(tx, stateTable)
        if (!fullSweep) {
          for (const key of checkKeys) {
            watermarks[key] = await loadWatermark(tx, stateTable, watermarkKey(scope, key))
          }
        }

        // Janitor: flip stale active keys to `expired` before any check
        // runs so the rest of the sweep sees consistent state. This is
        // the right layer for the side-effect — the engine's transition
        // path can only refuse (its tx rolls back the flip).
        const expired = tenantFilter
          ? await tx<{ id: string }[]>`
              update "txn_keys"
              set status = 'expired'
              where tenant_id = ${tenantFilter}
                and status = 'active'
                and expires_at is not null
                and expires_at <= now()
              returning id
            `
          : await tx<{ id: string }[]>`
              update "txn_keys"
              set status = 'expired'
              where status = 'active'
                and expires_at is not null
                and expires_at <= now()
              returning id
            `
        expiredKeys = expired.length

        // Every check is now O(Δ): it only examines rows whose driving
        // ULID id is above the relevant watermark. Drift looks at the
        // posting-side watermark (postings inherit transition id);
        // state and key checks look at their own.
        const driftIds = await checkBalanceDrift(tx, tenantFilter, watermarks.drift, drafts)
        for (const id of driftIds) driftAccountIds.add(id)
        await checkUnbalancedPostings(tx, tenantFilter, watermarks.transitions, drafts)
        await checkPostingsChecksum(tx, tenantFilter, watermarks.transitions, ctx.hasher, drafts)
        const integrityIds = await checkHashChain(
          tx,
          tenantFilter,
          watermarks.transitions,
          ctx.hasher,
          drafts,
          ctx.payloadCrypto,
        )
        integrityRecordIds.push(...integrityIds)
        const stateIds = await checkStateMismatch(tx, tenantFilter, watermarks.state, drafts)
        for (const id of stateIds) stateMismatchRecordIds.add(id)
        const fabIds = await checkFabricatedKeys(tx, tenantFilter, watermarks.keys, drafts)
        for (const id of fabIds) fabricatedKeyIds.add(id)
        await checkFxRateDrift(
          tx,
          tenantFilter,
          watermarks.transitions,
          options.fxRateTolerance ?? 0.0001,
          drafts,
          ctx.payloadCrypto,
        )

        // Bump every watermark to the most recent transition id we've
        // observed. Postings, records, and keys all derive from
        // transitions, so a single high-water mark suffices.
        watermarkAfter = await loadHighestTransitionId(tx, tenantFilter)
        if (watermarkAfter) {
          for (const key of checkKeys) {
            await saveWatermark(tx, stateTable, watermarkKey(scope, key), watermarkAfter)
          }
        }
      })

      // Persist anomalies + quarantine + auto-repair in a second admin
      // tx so even partial check failures still get recorded.
      const anomalies: AnomalyEvent[] = []
      const quarantined = new Set<string>()
      const repaired = new Set<string>()
      const stateRepaired = new Set<string>()
      const fabricatedKeysExpired = new Set<string>()
      await ctx.connection.asAdmin(async (tx) => {
        for (const d of drafts) {
          anomalies.push(await recordAnomaly(tx, d, ctx.payloadCrypto))
        }
        if (options.repairBalanceDrift && driftAccountIds.size > 0) {
          for (const accountId of driftAccountIds) {
            const [row] = await tx<{ id: string }[]>`
              update "accounts"
              set balance = coalesce(
                (select sum(case when p.direction = 'C' then p.amount else -p.amount end)
                 from "postings" p where p.account_id = "accounts".id),
                0
              )
              where id = ${accountId}
              returning id
            `
            if (row) repaired.add(row.id)
          }
        }
        // M10: bump cached `txn_records.state` to the latest
        // transition's `to_state`. Source of truth is the transitions
        // table — the cached state column is just a denorm, so this is
        // a safe self-heal. Only touch records that aren't already
        // quarantined; a `compromised` record stays quarantined until
        // an operator clears it.
        if (options.repairStateMismatch && stateMismatchRecordIds.size > 0) {
          for (const recordId of stateMismatchRecordIds) {
            const [row] = await tx<{ id: string }[]>`
              update "txn_records" r
              set state = sub.to_state, updated_at = now()
              from (
                select to_state from "txn_transitions"
                where txn_id = ${recordId}
                order by id desc limit 1
              ) as sub
              where r.id = ${recordId}
                and r.compromised = false
                and r.state <> sub.to_state
              returning r.id
            `
            if (row) stateRepaired.add(row.id)
          }
        }
        // M10: flip `active` → `expired` on keys whose granting
        // transition doesn't exist. We can't reverse the transition
        // (we don't have one to reverse against), but we can stop the
        // key being legitimately consumable.
        if (options.repairFabricatedKeys && fabricatedKeyIds.size > 0) {
          for (const keyId of fabricatedKeyIds) {
            const [row] = await tx<{ id: string }[]>`
              update "txn_keys"
              set status = 'expired'
              where id = ${keyId} and status = 'active'
              returning id
            `
            if (row) fabricatedKeysExpired.add(row.id)
          }
        }
        if (quarantine) {
          // Quarantine triggers when a record has at least one
          // critical-severity anomaly attached.
          // M10: a `fabricated_key` anomaly that we've also repaired
          // (flipped active → expired) no longer warrants quarantine —
          // the underlying record is fine, only an orphan key was
          // expired. Hash-chain / checksum / unbalanced-postings
          // criticals still trigger because we cannot self-heal those.
          const recordIdsToQuarantine = new Set<string>()
          for (const a of anomalies) {
            if (a.severity !== 'critical' || !a.txnId) continue
            if (a.check === 'fabricated_key' && options.repairFabricatedKeys) continue
            recordIdsToQuarantine.add(a.txnId)
          }
          for (const recordId of integrityRecordIds) recordIdsToQuarantine.add(recordId)
          for (const recordId of recordIdsToQuarantine) {
            const [row] = await tx<{ id: string; type: string; tenant_id: string }[]>`
              update "txn_records"
              set compromised = true
              where id = ${recordId} and compromised = false
              returning id, type, tenant_id
            `
            if (row) quarantined.add(row.id)
          }
        }
      })

      // Hooks fire post-commit. Quarantine events match each anomaly
      // that triggered them so consumers can route by severity.
      for (const a of anomalies) {
        await ctx.hooks.internals.fireAnomaly(a)
        if (a.severity === 'critical') {
          await ctx.hooks.internals.fireIntegrityViolation(a)
        }
      }
      for (const id of quarantined) {
        // Pair each quarantined record with the most-critical anomaly
        // we recorded for it (or the first anomaly if multiple match).
        const reason = anomalies.find((a) => a.txnId === id) ?? anomalies[0]
        if (!reason) continue
        const event: QuarantineEvent = {
          tenantId: reason.tenantId,
          recordId: id,
          txnType: reason.txnType ?? 'unknown',
          reason,
        }
        await ctx.hooks.internals.fireQuarantine(event)
      }

      const result: RunOnceResult = {
        anomalies,
        quarantined: Array.from(quarantined),
        repaired: Array.from(repaired),
        expiredKeys,
        stateRepaired: Array.from(stateRepaired),
        fabricatedKeysExpired: Array.from(fabricatedKeysExpired),
      }
      // `fullSweep` reflects whether the pass actually scanned every
      // row — either because the option was set, or because no
      // watermarks existed yet. Matches the pre-batch-19 semantics so
      // ops dashboards keep their meaning.
      const everyWatermarkWasNull = checkKeys.every((k) => watermarks[k] === null)
      // Batch H: emit duration + per-severity anomaly counters.
      instruments.reconcilerDurationMs.observe(Date.now() - startTime, {
        full_sweep: fullSweep || everyWatermarkWasNull ? 'true' : 'false',
      })
      for (const a of anomalies) {
        instruments.reconcilerAnomalies.inc(1, { check: a.check, severity: a.severity })
      }
      await ctx.hooks.internals.fireReconciliationComplete({
        startedAt,
        finishedAt: new Date(),
        anomaliesFound: anomalies.length,
        quarantined: result.quarantined.length,
        ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        fullSweep: fullSweep || everyWatermarkWasNull,
      })
      return result
    },

    start(options = {}) {
      // Resolve schedule(s). `intervalMs` is shorthand for the
      // continuous variant (back-compat with the previous signature).
      const incrementalSchedule: ReconcilerSchedule =
        options.schedule ??
        (options.intervalMs !== undefined
          ? { kind: 'continuous', intervalMs: options.intervalMs }
          : { kind: 'continuous', intervalMs: 60_000 })
      const fullSweepSchedule = options.fullSweepSchedule

      let stopped = false
      // Every `nextPass()` call subscribes to the next pass via a
      // fresh waiter; the next fire resolves all queued waiters and
      // empties the list. Previously this was a single-slot
      // (resolve, reject) pair, so a second concurrent `nextPass`
      // overwrote the first and the first caller hung forever.
      type Waiter = { resolve: (r: RunOnceResult) => void; reject: (e: unknown) => void }
      const waiters: Waiter[] = []
      const timers = new Set<ReturnType<typeof setTimeout>>()

      const fire = async (fullSweep: boolean): Promise<void> => {
        if (stopped) return
        try {
          const result = await this.runOnce({
            ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
            ...(fullSweep ? { fullSweep: true } : {}),
          })
          if (waiters.length > 0) {
            const drained = waiters.splice(0)
            for (const w of drained) w.resolve(result)
          }
        } catch (e) {
          if (waiters.length > 0) {
            const drained = waiters.splice(0)
            for (const w of drained) w.reject(e)
          } else if (options.onError) {
            options.onError(e)
          }
        }
      }

      const scheduleNext = (schedule: ReconcilerSchedule, fullSweep: boolean): void => {
        if (stopped) return
        const delay = nextFireMs(schedule, new Date())
        const timer = setTimeout(async () => {
          timers.delete(timer)
          await fire(fullSweep)
          scheduleNext(schedule, fullSweep)
        }, delay)
        timers.add(timer)
      }

      scheduleNext(incrementalSchedule, false)
      if (fullSweepSchedule) scheduleNext(fullSweepSchedule, true)
      // First tick happens after one schedule interval — callers
      // wanting a deterministic first run should `await reconciler.runOnce()`.

      return {
        async stop() {
          stopped = true
          for (const t of timers) clearTimeout(t)
          timers.clear()
          // Reject every queued waiter so callers don't hang past
          // shutdown. Use a sentinel error class? — for now the
          // standard Error is enough; tests rely on `.message`.
          if (waiters.length > 0) {
            const drained = waiters.splice(0)
            for (const w of drained) w.reject(new Error('Reconciler stopped before next pass.'))
          }
        },
        nextPass() {
          return new Promise<RunOnceResult>((resolve, reject) => {
            waiters.push({ resolve, reject })
          })
        },
      }
    },
  }
}

// =============================================================================
// Individual checks
// =============================================================================

async function checkBalanceDrift(
  tx: SqlTransaction,
  tenantFilter: string | undefined,
  watermark: string | null,
  drafts: AnomalyDraft[],
): Promise<readonly string[]> {
  type Row = {
    id: string
    tenant_id: string
    owner_actor_type: string
    owner_actor_id: string
    name: string
    cached: string
    expected: string
  }
  // Watermarked drift only revisits accounts whose postings have moved
  // since the last sweep. Postings inherit their transition's ULID, so
  // we filter the candidate set to accounts referenced by postings
  // with `transition_id > watermark`.
  const tenantFrag = tenantFilter ? tx`and a.tenant_id = ${tenantFilter}` : tx``
  const wmFrag = watermark
    ? tx`and a.id in (
        select distinct p.account_id from "postings" p
        where p.transition_id > ${watermark}
      )`
    : tx``
  const rows = await tx<Row[]>`
    select a.id, a.tenant_id, a.owner_actor_type, a.owner_actor_id, a.name,
           a.balance::text as cached,
           coalesce(
             (select sum(case when p.direction = 'C' then p.amount else -p.amount end)
              from "postings" p where p.account_id = a.id),
             0
           )::text as expected
    from "accounts" a
    where 1=1 ${tenantFrag} ${wmFrag}
  `

  const drifted: string[] = []
  for (const row of rows) {
    if (row.cached !== row.expected) {
      drifted.push(row.id)
      drafts.push({
        tenantId: row.tenant_id,
        check: 'balance_drift',
        accountId: row.id,
        expected: row.expected,
        observed: row.cached,
        context: {
          ownerActorType: row.owner_actor_type,
          ownerActorId: row.owner_actor_id,
          name: row.name,
        },
      })
    }
  }
  return drifted
}

async function checkFabricatedKeys(
  tx: SqlTransaction,
  tenantFilter: string | undefined,
  watermark: string | null,
  drafts: AnomalyDraft[],
): Promise<readonly string[]> {
  // A `txn_keys` row is fabricated when (a) its `granted_by_transition_id`
  // doesn't reference an existing transition, OR (b) the granting
  // transition exists but doesn't actually `unlock` this key name in
  // its declared payload — the `txn_transitions` row's `name` would
  // need to be a transition that mints the key. We catch (a) here at
  // the SQL level; (b) requires schema introspection and is left for
  // a later pass.
  //
  // Watermarked: only re-check keys whose granting transition id is
  // above the previous watermark. `granted_by_transition_id` is a
  // ULID, so the comparison is sortable.
  type Row = {
    id: string
    tenant_id: string
    txn_id: string
    name: string
    granted_by_transition_id: string
  }
  const tenantFrag = tenantFilter ? tx`and k.tenant_id = ${tenantFilter}` : tx``
  const wmFrag = watermark ? tx`and k.granted_by_transition_id > ${watermark}` : tx``
  const rows = await tx<Row[]>`
    select k.id, k.tenant_id, k.txn_id, k.name, k.granted_by_transition_id
    from "txn_keys" k
    where k.status = 'active'
      and not exists (
        select 1 from "txn_transitions" t where t.id = k.granted_by_transition_id
      )
      ${tenantFrag}
      ${wmFrag}
  `
  const keyIds: string[] = []
  for (const row of rows) {
    drafts.push({
      tenantId: row.tenant_id,
      check: 'fabricated_key',
      txnId: row.txn_id,
      expected: { granted_by_transition_id: row.granted_by_transition_id, status: 'absent' },
      observed: { granted_by_transition_id: row.granted_by_transition_id, status: 'active' },
      context: { keyId: row.id, keyName: row.name },
    })
    keyIds.push(row.id)
  }
  return keyIds
}

async function checkUnbalancedPostings(
  tx: SqlTransaction,
  tenantFilter: string | undefined,
  watermark: string | null,
  drafts: AnomalyDraft[],
): Promise<void> {
  type Row = {
    transition_id: string
    tenant_id: string
    currency: string
    debits: string
    credits: string
  }
  // Watermark filters by transition id — postings inherit their
  // transition's monotone id (ULID), so anything with
  // transition_id > watermark is new since the last verified pass.
  // Multi-currency (M16): balance is enforced per currency, so we
  // join `accounts` to recover the leg currency and group by it.
  const tenantFrag = tenantFilter ? tx`and p.tenant_id = ${tenantFilter}` : tx``
  const wmFrag = watermark ? tx`and p.transition_id > ${watermark}` : tx``
  const rows = await tx<Row[]>`
    select p.transition_id, p.tenant_id, a.currency,
           coalesce(sum(case when p.direction='D' then p.amount else 0 end),0)::text as debits,
           coalesce(sum(case when p.direction='C' then p.amount else 0 end),0)::text as credits
    from "postings" p
    join "accounts" a on a.id = p.account_id
    where 1=1 ${tenantFrag} ${wmFrag}
    group by p.transition_id, p.tenant_id, a.currency
  `

  for (const row of rows) {
    if (row.debits !== row.credits) {
      // Resolve to the parent record so hooks can route by txnId.
      const [trans] = await tx<{ txn_id: string; type: string }[]>`
        select txn_id, type from "txn_transitions"
        where id = ${row.transition_id}
      `
      drafts.push({
        tenantId: row.tenant_id,
        check: 'unbalanced_postings',
        ...(trans ? { txnId: trans.txn_id, txnType: trans.type } : {}),
        // M5 fix: previously the `expected` block reported
        // `{ debits: row.debits, credits: row.debits }` — copying the
        // observed debits onto credits looked correct but obscured
        // the actual rule. The rule is sum(D) === sum(C); we report
        // it as a constraint, with the observed values for diagnosis.
        expected: { rule: 'sum(D) === sum(C)', currency: row.currency },
        observed: { debits: row.debits, credits: row.credits, currency: row.currency },
        context: { transitionId: row.transition_id, currency: row.currency },
      })
    }
  }
}

async function checkPostingsChecksum(
  tx: SqlTransaction,
  tenantFilter: string | undefined,
  watermark: string | null,
  hasher: Hasher,
  drafts: AnomalyDraft[],
): Promise<void> {
  type Row = {
    id: string
    tenant_id: string
    txn_id: string
    type: string
    postings_checksum: Buffer
  }
  const tenantFrag = tenantFilter ? tx`and tenant_id = ${tenantFilter}` : tx``
  const wmFrag = watermark ? tx`and id > ${watermark}` : tx``
  const transitions = await tx<Row[]>`
    select id, tenant_id, txn_id, type, postings_checksum from "txn_transitions"
    where 1=1 ${tenantFrag} ${wmFrag}
  `

  for (const t of transitions) {
    const postings = await tx<{ account_id: string; direction: string; amount: string }[]>`
      select account_id, direction, amount::text as amount from "postings"
      where transition_id = ${t.id}
    `
    const recomputed = computePostingsChecksum(
      hasher,
      postings.map((p) => ({
        account_id: p.account_id,
        direction: p.direction,
        amount: BigInt(p.amount),
      })),
    )
    if (!Buffer.from(t.postings_checksum).equals(recomputed)) {
      drafts.push({
        tenantId: t.tenant_id,
        check: 'checksum_mismatch',
        txnId: t.txn_id,
        txnType: t.type,
        expected: recomputed.toString('hex'),
        observed: Buffer.from(t.postings_checksum).toString('hex'),
        context: { transitionId: t.id },
      })
    }
  }
}

async function checkHashChain(
  tx: SqlTransaction,
  tenantFilter: string | undefined,
  watermark: string | null,
  hasher: Hasher,
  drafts: AnomalyDraft[],
  crypto: PayloadCrypto | undefined,
): Promise<readonly string[]> {
  type Row = {
    id: string
    tenant_id: string
    txn_id: string
    type: string
    from_state: string | null
    to_state: string
    name: string
    schema_version: number
    actor_type: string
    actor_id: string
    payload: Record<string, unknown>
    idempotency_key: string
    occurred_at: Date
    prev_hash: Buffer | null
    row_hash: Buffer
    reverses: string | null
  }
  const tenantFrag = tenantFilter ? tx`and tenant_id = ${tenantFilter}` : tx``
  const wmFrag = watermark ? tx`and id > ${watermark}` : tx``
  const transitions = await tx<Row[]>`
    select * from "txn_transitions" where 1=1 ${tenantFrag} ${wmFrag} order by txn_id, id
  `

  const integrityRecordIds = new Set<string>()
  let prevByTxn: { txn_id: string; row_hash: Buffer } | null = null
  // For watermarked sweeps, the predecessor of the first row in each
  // (txn_id) slice lives below the watermark; we look it up on demand.
  const predecessorsLoaded = new Set<string>()
  const loadPredecessor = async (txnId: string, beforeId: string): Promise<Buffer | null> => {
    const [pred] = await tx<{ row_hash: Buffer }[]>`
      select row_hash from "txn_transitions"
      where txn_id = ${txnId} and id < ${beforeId}
      order by id desc limit 1
    `
    return pred ? Buffer.from(pred.row_hash) : null
  }

  for (const t of transitions) {
    if (watermark && !predecessorsLoaded.has(t.txn_id)) {
      predecessorsLoaded.add(t.txn_id)
      const predHash = await loadPredecessor(t.txn_id, t.id)
      if (predHash) prevByTxn = { txn_id: t.txn_id, row_hash: predHash }
    }
    const expectedPrevHash = prevByTxn && prevByTxn.txn_id === t.txn_id ? prevByTxn.row_hash : null
    const storedPrev = t.prev_hash === null ? null : Buffer.from(t.prev_hash)
    const prevMismatch = !buffersEqual(storedPrev, expectedPrevHash)

    // Hashing is over the PLAINTEXT canonical form. Decrypt the
    // storage envelope here so a `payloadCrypto` deployment doesn't
    // trip `hash_chain_break` on every sweep.
    //
    // A corrupted envelope or a stale key would otherwise throw and
    // abort the entire reconciliation pass — one bad row would
    // halt every other check across every tenant. Catch the
    // failure, record it as a `hash_chain_break` anomaly with the
    // decryption error, and keep going.
    let decryptedPayload: unknown
    try {
      decryptedPayload = await decryptPayload(crypto, t.payload)
    } catch (e) {
      drafts.push({
        tenantId: t.tenant_id,
        check: 'hash_chain_break',
        txnId: t.txn_id,
        txnType: t.type,
        expected: { decryptable: true },
        observed: {
          decryptable: false,
          error: e instanceof Error ? e.message : String(e),
        },
        context: { transitionId: t.id },
      })
      integrityRecordIds.add(t.txn_id)
      // Move the per-txn pointer forward so the next row in the
      // same txn doesn't compare against a now-stale predecessor.
      prevByTxn = { txn_id: t.txn_id, row_hash: Buffer.from(t.row_hash) }
      continue
    }
    const content: CanonicalValue = {
      id: t.id,
      txn_id: t.txn_id,
      tenant_id: t.tenant_id,
      type: t.type,
      from_state: t.from_state,
      to_state: t.to_state,
      name: t.name,
      schema_version: t.schema_version,
      actor_type: t.actor_type,
      actor_id: t.actor_id,
      payload: (decryptedPayload as CanonicalValue) ?? {},
      idempotency_key: t.idempotency_key,
      occurred_at: t.occurred_at,
      reverses: t.reverses,
    }
    const recomputed = computeRowHash(hasher, content, expectedPrevHash)
    const stored = Buffer.from(t.row_hash)
    const rowMismatch = !stored.equals(recomputed)

    if (prevMismatch || rowMismatch) {
      drafts.push({
        tenantId: t.tenant_id,
        check: 'hash_chain_break',
        txnId: t.txn_id,
        txnType: t.type,
        expected: {
          row_hash: recomputed.toString('hex'),
          prev_hash: expectedPrevHash?.toString('hex') ?? null,
        },
        observed: {
          row_hash: stored.toString('hex'),
          prev_hash: storedPrev?.toString('hex') ?? null,
        },
        context: { transitionId: t.id },
      })
      integrityRecordIds.add(t.txn_id)
    }

    prevByTxn = { txn_id: t.txn_id, row_hash: stored }
  }

  return Array.from(integrityRecordIds)
}

async function checkStateMismatch(
  tx: SqlTransaction,
  tenantFilter: string | undefined,
  watermark: string | null,
  drafts: AnomalyDraft[],
): Promise<readonly string[]> {
  type Row = {
    record_id: string
    tenant_id: string
    type: string
    cached_state: string
    latest_to_state: string | null
  }
  // Watermarked: a record's cached state can only become stale after a
  // new transition lands on it. Restrict the candidate set to records
  // touched by transitions whose id > watermark.
  const tenantFrag = tenantFilter ? tx`and r.tenant_id = ${tenantFilter}` : tx``
  const wmFrag = watermark
    ? tx`and r.id in (
        select distinct t.txn_id from "txn_transitions" t
        where t.id > ${watermark}
      )`
    : tx``
  const rows = await tx<Row[]>`
    select r.id as record_id, r.tenant_id, r.type,
           r.state as cached_state,
           (select t.to_state from "txn_transitions" t
            where t.txn_id = r.id order by t.id desc limit 1) as latest_to_state
    from "txn_records" r
    where 1=1 ${tenantFrag} ${wmFrag}
  `

  const recordIds: string[] = []
  for (const row of rows) {
    if (row.latest_to_state !== null && row.cached_state !== row.latest_to_state) {
      drafts.push({
        tenantId: row.tenant_id,
        check: 'state_mismatch',
        txnId: row.record_id,
        txnType: row.type,
        expected: row.latest_to_state,
        observed: row.cached_state,
      })
      recordIds.push(row.record_id)
    }
  }
  return recordIds
}

/**
 * M16 — verify that rate-pinned transitions still agree with the FX
 * table within tolerance. A transition opts into this check by
 * carrying `rate` (decimal string) and `rateSource` (string) in its
 * payload. The reconciler compares against the most recent
 * `fx_rates` row for the matching (base, quote) pair fixed at or
 * before the transition's `occurred_at`.
 *
 * Conservative on purpose: if the transition doesn't declare both a
 * rate AND a base/quote pair (via `baseCurrency` + `quoteCurrency`),
 * the check skips it. We never invent a base/quote — operators that
 * want this check tag their transitions explicitly.
 */
async function checkFxRateDrift(
  tx: SqlTransaction,
  tenantFilter: string | undefined,
  watermark: string | null,
  tolerance: number,
  drafts: AnomalyDraft[],
  crypto: PayloadCrypto | undefined,
): Promise<void> {
  type Row = {
    id: string
    tenant_id: string
    txn_id: string
    type: string
    payload: unknown
    occurred_at: Date
  }
  const tenantFrag = tenantFilter ? tx`and tenant_id = ${tenantFilter}` : tx``
  const wmFrag = watermark ? tx`and id > ${watermark}` : tx``
  // Filter on existence of `rate` + `baseCurrency` + `quoteCurrency` in
  // payload. JSONB `?` operator catches both plaintext rows and
  // encrypted envelopes (envelopes have no top-level `rate` so they
  // skip — encrypted rate-pinned rows are decrypted below for the
  // detailed check, but the cheap pre-filter is for performance).
  const rows = await tx<Row[]>`
    select id, tenant_id, txn_id, type, payload, occurred_at
    from "txn_transitions"
    where 1=1 ${tenantFrag} ${wmFrag}
      and (
        (payload ? 'rate' and payload ? 'baseCurrency' and payload ? 'quoteCurrency')
        or payload ? '$encrypted'
      )
  `
  for (const t of rows) {
    // A corrupted encrypted payload would otherwise abort the whole
    // reconciliation pass; the hash-chain check above is the right
    // place to flag it as `hash_chain_break`. Here we just skip the
    // row — the FX check is advisory and shouldn't double-report.
    let payload: Record<string, unknown> | null
    try {
      payload = (await decryptPayload(crypto, t.payload)) as Record<string, unknown> | null
    } catch {
      continue
    }
    if (!payload) continue
    const declaredRate = payload['rate']
    const baseCurrency = payload['baseCurrency']
    const quoteCurrency = payload['quoteCurrency']
    if (
      typeof declaredRate !== 'string' ||
      typeof baseCurrency !== 'string' ||
      typeof quoteCurrency !== 'string'
    ) {
      continue
    }
    const declared = Number(declaredRate)
    if (!Number.isFinite(declared) || declared <= 0) continue
    // Source-aware lookup: when the transition pinned a specific feed
    // via `rateSource`, only compare against rows from that feed.
    // Without this, a multi-source FX setup yields false drifts —
    // the latest `fixed_at` across sources wins even if the
    // transition pinned a different source.
    const declaredSource = payload['rateSource']
    const sourceFilter = typeof declaredSource === 'string' ? declaredSource : null
    const sourceFrag = sourceFilter ? tx`and source = ${sourceFilter}` : tx``
    const [pub] = await tx<{ rate: string; source: string }[]>`
      select rate::text as rate, source from "fx_rates"
      where tenant_id = ${t.tenant_id}
        and base_currency = ${baseCurrency}
        and quote_currency = ${quoteCurrency}
        and fixed_at <= ${t.occurred_at}
        and (expires_at is null or expires_at > ${t.occurred_at})
        ${sourceFrag}
      order by fixed_at desc
      limit 1
    `
    if (!pub) {
      // No published rate was in effect at this transition's
      // `occurred_at` for the (base, quote, source) tuple. Two
      // operational causes:
      //   1. Operator forgot to publish (or expired) a rate.
      //   2. Operator published the rate with a `fixed_at` after
      //      the transition fired (clock skew or out-of-order
      //      bookkeeping).
      // In either case the transition's pin is unverifiable; the
      // reconciler is the right place to surface that — silent
      // skip would let an operational gap go undetected.
      drafts.push({
        tenantId: t.tenant_id,
        check: 'fx_rate_drift',
        txnId: t.txn_id,
        txnType: t.type,
        expected: {
          baseCurrency,
          quoteCurrency,
          ...(sourceFilter ? { source: sourceFilter } : {}),
          status: 'rate_published',
        },
        observed: {
          rate: declaredRate,
          source: declaredSource ?? null,
          baseCurrency,
          quoteCurrency,
          status: 'no_rate_in_effect',
        },
        context: { transitionId: t.id, occurredAt: t.occurred_at, reason: 'gap_or_unpublished' },
      })
      continue
    }
    const published = Number(pub.rate)
    if (!Number.isFinite(published) || published <= 0) continue
    const drift = Math.abs(declared - published) / published
    if (drift > tolerance) {
      drafts.push({
        tenantId: t.tenant_id,
        check: 'fx_rate_drift',
        txnId: t.txn_id,
        txnType: t.type,
        expected: { rate: pub.rate, source: pub.source, baseCurrency, quoteCurrency },
        observed: {
          rate: declaredRate,
          source: declaredSource ?? null,
          baseCurrency,
          quoteCurrency,
        },
        context: { transitionId: t.id, drift, tolerance },
      })
    }
  }
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.equals(b)
}

// =============================================================================
// Watermark state — `_loki_reconciler_state` stores the highest transition id
// the reconciler has verified per scope (`tenantId` or `'*'` for global).
// Subsequent passes only re-check transitions above the watermark, turning
// the per-pass cost from O(N) into O(Δ). The full-sweep escape hatch on
// `runOnce` is what to schedule nightly to catch drift on cold rows.
// =============================================================================

async function ensureReconcilerStateTable(tx: SqlTransaction, tableName: string): Promise<void> {
  await tx.unsafe(`
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      key text PRIMARY KEY,
      watermark text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

/**
 * Compose the storage key for a per-check watermark. Scope is either
 * the tenant id or `'*'` for cross-tenant sweeps; check is one of
 * `transitions` / `drift` / `state` / `keys`.
 */
function watermarkKey(scope: string, check: string): string {
  return `${scope}:${check}`
}

/**
 * Compute milliseconds until the next fire for a schedule, given
 * `now`. Pure function — exported for testability via the package
 * surface, but the reconciler is the only consumer.
 */
export function nextFireMs(schedule: ReconcilerSchedule, now: Date): number {
  switch (schedule.kind) {
    case 'continuous': {
      // Floor at 1ms so we never schedule a 0-delay tight loop.
      return Math.max(1, schedule.intervalMs)
    }
    case 'daily': {
      const next = nextDailyFire(schedule.at, schedule.tz ?? 'utc', now)
      return Math.max(1, next.getTime() - now.getTime())
    }
    case 'weekly': {
      const next = nextWeeklyFire(schedule.at, schedule.dayOfWeek, schedule.tz ?? 'utc', now)
      return Math.max(1, next.getTime() - now.getTime())
    }
    case 'monthly': {
      const next = nextMonthlyFire(schedule.at, schedule.dayOfMonth, schedule.tz ?? 'utc', now)
      return Math.max(1, next.getTime() - now.getTime())
    }
  }
}

function parseClock(at: string): { h: number; m: number; s: number } {
  const parts = at.split(':').map((p) => Number.parseInt(p, 10))
  const h = parts[0] ?? 0
  const m = parts[1] ?? 0
  const s = parts[2] ?? 0
  if (
    !Number.isFinite(h) ||
    !Number.isFinite(m) ||
    !Number.isFinite(s) ||
    h < 0 ||
    h > 23 ||
    m < 0 ||
    m > 59 ||
    s < 0 ||
    s > 59
  ) {
    throw new Error(`Invalid time-of-day "${at}". Use HH:MM or HH:MM:SS in 24-hour format.`)
  }
  return { h, m, s }
}

/** Build a Date from Y/M/D and a clock string, in the chosen timezone. */
function withClockOn(
  year: number,
  month: number,
  day: number,
  at: string,
  tz: 'local' | 'utc',
): Date {
  const { h, m, s } = parseClock(at)
  if (tz === 'utc') return new Date(Date.UTC(year, month, day, h, m, s, 0))
  return new Date(year, month, day, h, m, s, 0)
}

function nextDailyFire(at: string, tz: 'local' | 'utc', now: Date): Date {
  const Y = tz === 'utc' ? now.getUTCFullYear() : now.getFullYear()
  const M = tz === 'utc' ? now.getUTCMonth() : now.getMonth()
  const D = tz === 'utc' ? now.getUTCDate() : now.getDate()
  let target = withClockOn(Y, M, D, at, tz)
  if (target.getTime() <= now.getTime()) {
    // Already passed today — fire tomorrow.
    target = withClockOn(Y, M, D + 1, at, tz)
  }
  return target
}

function nextWeeklyFire(
  at: string,
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  tz: 'local' | 'utc',
  now: Date,
): Date {
  const today = tz === 'utc' ? now.getUTCDay() : now.getDay()
  const Y = tz === 'utc' ? now.getUTCFullYear() : now.getFullYear()
  const M = tz === 'utc' ? now.getUTCMonth() : now.getMonth()
  const D = tz === 'utc' ? now.getUTCDate() : now.getDate()
  let delta = (dayOfWeek - today + 7) % 7
  let target = withClockOn(Y, M, D + delta, at, tz)
  if (delta === 0 && target.getTime() <= now.getTime()) {
    // It's the right day but the clock has already passed — schedule
    // for the same day next week.
    delta = 7
    target = withClockOn(Y, M, D + delta, at, tz)
  }
  return target
}

function nextMonthlyFire(at: string, dayOfMonth: number, tz: 'local' | 'utc', now: Date): Date {
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
    throw new Error(`Invalid dayOfMonth ${dayOfMonth}. Must be an integer in [1, 31].`)
  }
  const Y = tz === 'utc' ? now.getUTCFullYear() : now.getFullYear()
  const M = tz === 'utc' ? now.getUTCMonth() : now.getMonth()
  // Clamp to the actual last day of the target month so day=31 in Feb
  // fires on Feb 28/29.
  const tryFor = (year: number, monthZero: number): Date => {
    const lastDay = new Date(Date.UTC(year, monthZero + 1, 0)).getUTCDate()
    const day = Math.min(dayOfMonth, lastDay)
    return withClockOn(year, monthZero, day, at, tz)
  }
  let target = tryFor(Y, M)
  if (target.getTime() <= now.getTime()) {
    // This month's slot has passed — slide to next month.
    const ny = M === 11 ? Y + 1 : Y
    const nm = (M + 1) % 12
    target = tryFor(ny, nm)
  }
  return target
}

async function loadWatermark(
  tx: SqlTransaction,
  tableName: string,
  key: string,
): Promise<string | null> {
  const [row] = await tx<{ watermark: string }[]>`
    select watermark from ${tx(tableName)} where key = ${key}
  `
  return row?.watermark ?? null
}

async function saveWatermark(
  tx: SqlTransaction,
  tableName: string,
  key: string,
  watermark: string,
): Promise<void> {
  await tx`
    insert into ${tx(tableName)} (key, watermark, updated_at)
    values (${key}, ${watermark}, now())
    on conflict (key) do update set
      watermark = excluded.watermark,
      updated_at = excluded.updated_at
    where excluded.watermark > ${tx(tableName)}.watermark
  `
}

async function loadHighestTransitionId(
  tx: SqlTransaction,
  tenantFilter: string | undefined,
): Promise<string | null> {
  const [row] = tenantFilter
    ? await tx<{ id: string | null }[]>`
        select max(id) as id from "txn_transitions" where tenant_id = ${tenantFilter}
      `
    : await tx<{ id: string | null }[]>`
        select max(id) as id from "txn_transitions"
      `
  return row?.id ?? null
}
