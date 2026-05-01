import { type AnomalyDraft, recordAnomaly } from './anomalies.js'
import type { CanonicalValue } from './canonical.js'
import type { Connection, SqlTransaction } from './connection.js'
import { type Hasher, computePostingsChecksum, computeRowHash } from './hash.js'
import type { AnomalyEvent, HookRegistry, QuarantineEvent } from './hooks.js'

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
}

export type RunOnceResult = {
  readonly anomalies: readonly AnomalyEvent[]
  readonly quarantined: readonly string[]
  /** Account ids whose `balance` column the reconciler rebuilt this pass. */
  readonly repaired: readonly string[]
  /** Keys whose `expires_at` had passed and were flipped from `active` → `expired`. */
  readonly expiredKeys: number
}

export type StartOptions = {
  readonly intervalMs?: number
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
}

export function createReconciler(ctx: ReconcilerContext): Reconciler {
  return {
    async runOnce(options = {}) {
      const startedAt = new Date()
      const quarantine = options.quarantine ?? true
      const drafts: AnomalyDraft[] = []
      const integrityRecordIds: string[] = []

      const driftAccountIds = new Set<string>()
      let expiredKeys = 0
      await ctx.connection.asAdmin(async (tx) => {
        const tenantFilter = options.tenantId

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

        const driftIds = await checkBalanceDrift(tx, tenantFilter, drafts)
        for (const id of driftIds) driftAccountIds.add(id)
        await checkUnbalancedPostings(tx, tenantFilter, drafts)
        await checkPostingsChecksum(tx, tenantFilter, ctx.hasher, drafts)
        const integrityIds = await checkHashChain(tx, tenantFilter, ctx.hasher, drafts)
        integrityRecordIds.push(...integrityIds)
        await checkStateMismatch(tx, tenantFilter, drafts)
        await checkFabricatedKeys(tx, tenantFilter, drafts)
      })

      // Persist anomalies + quarantine + auto-repair in a second admin
      // tx so even partial check failures still get recorded.
      const anomalies: AnomalyEvent[] = []
      const quarantined = new Set<string>()
      const repaired = new Set<string>()
      await ctx.connection.asAdmin(async (tx) => {
        for (const d of drafts) {
          anomalies.push(await recordAnomaly(tx, d))
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
        if (quarantine) {
          // Quarantine triggers when a record has at least one
          // critical-severity anomaly attached.
          const recordIdsToQuarantine = new Set<string>()
          for (const a of anomalies) {
            if (a.severity === 'critical' && a.txnId) {
              recordIdsToQuarantine.add(a.txnId)
            }
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
      }
      await ctx.hooks.internals.fireReconciliationComplete({
        startedAt,
        finishedAt: new Date(),
        anomaliesFound: anomalies.length,
        quarantined: result.quarantined.length,
        ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        // Watermark-aware sweeps land later in this batch; until then
        // every pass is a full sweep.
        fullSweep: true,
      })
      return result
    },

    start(options = {}) {
      const interval = options.intervalMs ?? 60_000
      let stopped = false
      let nextResolve: ((r: RunOnceResult) => void) | null = null
      let nextReject: ((e: unknown) => void) | null = null

      const tick = async (): Promise<void> => {
        if (stopped) return
        try {
          const result = await this.runOnce(
            options.tenantId !== undefined ? { tenantId: options.tenantId } : {},
          )
          if (nextResolve) {
            nextResolve(result)
            nextResolve = null
            nextReject = null
          }
        } catch (e) {
          if (nextReject) {
            nextReject(e)
            nextResolve = null
            nextReject = null
          } else if (options.onError) {
            options.onError(e)
          }
        } finally {
          if (!stopped) {
            timer = setTimeout(tick, interval)
          }
        }
      }

      let timer: ReturnType<typeof setTimeout> = setTimeout(tick, interval)
      // First tick after one interval — callers wanting a deterministic
      // first run should `await reconciler.runOnce()` themselves.

      return {
        async stop() {
          stopped = true
          clearTimeout(timer)
        },
        nextPass() {
          return new Promise<RunOnceResult>((res, rej) => {
            nextResolve = res
            nextReject = rej
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
  const rows = tenantFilter
    ? await tx<Row[]>`
        select a.id, a.tenant_id, a.owner_actor_type, a.owner_actor_id, a.name,
               a.balance::text as cached,
               coalesce(
                 (select sum(case when p.direction = 'C' then p.amount else -p.amount end)
                  from "postings" p where p.account_id = a.id),
                 0
               )::text as expected
        from "accounts" a
        where a.tenant_id = ${tenantFilter}
      `
    : await tx<Row[]>`
        select a.id, a.tenant_id, a.owner_actor_type, a.owner_actor_id, a.name,
               a.balance::text as cached,
               coalesce(
                 (select sum(case when p.direction = 'C' then p.amount else -p.amount end)
                  from "postings" p where p.account_id = a.id),
                 0
               )::text as expected
        from "accounts" a
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
  drafts: AnomalyDraft[],
): Promise<void> {
  // A `txn_keys` row is fabricated when (a) its `granted_by_transition_id`
  // doesn't reference an existing transition, OR (b) the granting
  // transition exists but doesn't actually `unlock` this key name in
  // its declared payload — the `txn_transitions` row's `name` would
  // need to be a transition that mints the key. We catch (a) here at
  // the SQL level; (b) requires schema introspection and is left for
  // a later pass.
  type Row = {
    id: string
    tenant_id: string
    txn_id: string
    name: string
    granted_by_transition_id: string
  }
  const rows = tenantFilter
    ? await tx<Row[]>`
        select k.id, k.tenant_id, k.txn_id, k.name, k.granted_by_transition_id
        from "txn_keys" k
        where k.tenant_id = ${tenantFilter}
          and k.status = 'active'
          and not exists (
            select 1 from "txn_transitions" t where t.id = k.granted_by_transition_id
          )
      `
    : await tx<Row[]>`
        select k.id, k.tenant_id, k.txn_id, k.name, k.granted_by_transition_id
        from "txn_keys" k
        where k.status = 'active'
          and not exists (
            select 1 from "txn_transitions" t where t.id = k.granted_by_transition_id
          )
      `
  for (const row of rows) {
    drafts.push({
      tenantId: row.tenant_id,
      check: 'fabricated_key',
      txnId: row.txn_id,
      expected: { granted_by_transition_id: row.granted_by_transition_id, status: 'absent' },
      observed: { granted_by_transition_id: row.granted_by_transition_id, status: 'active' },
      context: { keyId: row.id, keyName: row.name },
    })
  }
}

async function checkUnbalancedPostings(
  tx: SqlTransaction,
  tenantFilter: string | undefined,
  drafts: AnomalyDraft[],
): Promise<void> {
  type Row = {
    transition_id: string
    tenant_id: string
    debits: string
    credits: string
  }
  const rows = tenantFilter
    ? await tx<Row[]>`
        select transition_id, tenant_id,
               coalesce(sum(case when direction='D' then amount else 0 end),0)::text as debits,
               coalesce(sum(case when direction='C' then amount else 0 end),0)::text as credits
        from "postings"
        where tenant_id = ${tenantFilter}
        group by transition_id, tenant_id
      `
    : await tx<Row[]>`
        select transition_id, tenant_id,
               coalesce(sum(case when direction='D' then amount else 0 end),0)::text as debits,
               coalesce(sum(case when direction='C' then amount else 0 end),0)::text as credits
        from "postings"
        group by transition_id, tenant_id
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
        expected: { debits: row.debits, credits: row.debits },
        observed: { debits: row.debits, credits: row.credits },
        context: { transitionId: row.transition_id },
      })
    }
  }
}

async function checkPostingsChecksum(
  tx: SqlTransaction,
  tenantFilter: string | undefined,
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
  const transitions = tenantFilter
    ? await tx<Row[]>`
        select id, tenant_id, txn_id, type, postings_checksum from "txn_transitions"
        where tenant_id = ${tenantFilter}
      `
    : await tx<Row[]>`
        select id, tenant_id, txn_id, type, postings_checksum from "txn_transitions"
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
  hasher: Hasher,
  drafts: AnomalyDraft[],
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
  const transitions = tenantFilter
    ? await tx<Row[]>`
        select * from "txn_transitions" where tenant_id = ${tenantFilter} order by txn_id, id
      `
    : await tx<Row[]>`
        select * from "txn_transitions" order by txn_id, id
      `

  const integrityRecordIds = new Set<string>()
  let prevByTxn: { txn_id: string; row_hash: Buffer } | null = null

  for (const t of transitions) {
    const expectedPrevHash = prevByTxn && prevByTxn.txn_id === t.txn_id ? prevByTxn.row_hash : null
    const storedPrev = t.prev_hash === null ? null : Buffer.from(t.prev_hash)
    const prevMismatch = !buffersEqual(storedPrev, expectedPrevHash)

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
      payload: (t.payload as CanonicalValue) ?? {},
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
  drafts: AnomalyDraft[],
): Promise<void> {
  type Row = {
    record_id: string
    tenant_id: string
    type: string
    cached_state: string
    latest_to_state: string | null
  }
  const rows = tenantFilter
    ? await tx<Row[]>`
        select r.id as record_id, r.tenant_id, r.type,
               r.state as cached_state,
               (select t.to_state from "txn_transitions" t
                where t.txn_id = r.id order by t.id desc limit 1) as latest_to_state
        from "txn_records" r
        where r.tenant_id = ${tenantFilter}
      `
    : await tx<Row[]>`
        select r.id as record_id, r.tenant_id, r.type,
               r.state as cached_state,
               (select t.to_state from "txn_transitions" t
                where t.txn_id = r.id order by t.id desc limit 1) as latest_to_state
        from "txn_records" r
      `

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
    }
  }
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.equals(b)
}
