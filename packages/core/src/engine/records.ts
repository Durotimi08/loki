import { type PayloadCrypto, decryptPayload, encryptPayload } from '../primitives/payload-crypto.js'
import { ulid } from '../primitives/ulid.js'
import type { ActorDef, SchemaDef, TransactionDef } from '../schema/types.js'
import type { AccountInstanceRef, PostingDraft } from '../schema/types.js'
import { lookupAccountDecl } from './accounts.js'
import type { CanonicalValue } from './canonical.js'
import type { Connection, SqlTransaction } from './connection.js'
import {
  ActorNotPermittedError,
  CompromisedRecordError,
  ConcurrencyConflictError,
  IllegalStateTransitionError,
  InvalidPostingError,
  KeyAlreadyConsumedError,
  LokiError,
  OverdraftError,
  RejectTransition,
  UnbalancedPostingsError,
  UnknownTransitionError,
} from './errors.js'
import { type Hasher, computePostingsChecksum, computeRowHash } from './hash.js'
import type { HookRegistry } from './hooks.js'
import { type EngineInstruments, buildInstruments } from './observability.js'
import type {
  AccountIdentity,
  ActorRef,
  CreateRecordInput,
  CreateRecordResult,
  Posting,
  TransitionInputArgs,
  TransitionResult,
  TxnRecord,
  TxnTransition,
} from './types.js'

/**
 * Per-tenant record + transition operations. Implements the 7-step
 * write atomicity from §13:
 *
 *   1. Idempotency probe (early exit on replay).
 *   2. SELECT … FOR UPDATE on the affected `txn_records` row to lock state.
 *   3. SELECT … FOR UPDATE on accounts touched by postings, sorted by id.
 *   4. INSERT a `txn_transitions` row with hash chain + posting checksum.
 *   5. INSERT N postings (validated balanced before commit).
 *   6. UPDATE per-account balance cache.
 *   7. Mint `unlocks` keys, mark `needs` key consumed.
 *   8. UPDATE `txn_records` (state, version, active_keys, updated_at).
 *   9. INSERT outbox row when `emit` is declared.
 *
 * Steps 2 and 3 use deterministic ordering by id to avoid deadlocks.
 */

export type RecordOps = {
  create(input: CreateRecordInput): Promise<CreateRecordResult>
  transition(input: TransitionInputArgs): Promise<TransitionResult>
  /**
   * Drive many transitions sequentially. The engine still wraps each
   * transition in its own DB tx — bulk semantics here are about
   * amortizing client-side overhead and giving callers a single
   * `Promise.allSettled`-style result, not relaxing atomicity. Failed
   * transitions surface as `{ ok: false, error }` entries so the
   * caller can decide whether to retry or escalate without one bad
   * row taking down the whole batch.
   */
  bulkTransition(
    inputs: readonly TransitionInputArgs[],
    options?: { readonly batchSize?: number; readonly stopOnError?: boolean },
  ): Promise<readonly BulkTransitionItem[]>
  get(id: string): Promise<TxnRecord | null>
  trace(id: string): Promise<readonly TxnTransition[]>
}

export type BulkTransitionItem =
  | { readonly ok: true; readonly index: number; readonly result: TransitionResult }
  | { readonly ok: false; readonly index: number; readonly error: Error }

export type RecordOpsContext = {
  readonly schema: SchemaDef
  readonly tenantId: string
  readonly connection: Connection
  readonly hasher: Hasher
  readonly hooks: HookRegistry
  /**
   * Override how the engine picks a shard when posting to a sharded
   * account (M7). Returns an integer in `[0, n)`. Default: `Math.random`
   * — fine for distribution, deterministic in tests if you swap in a
   * seeded variant or `() => 0`. Must NOT depend on `tenantId` or
   * `accountId` to avoid hot-account contention; the whole point of
   * sharding is to spread writers across N rows.
   */
  readonly shardPicker?: (n: number) => number
  /** Wall-clock for test injection. Default `() => new Date()`. */
  readonly clock?: () => Date
  /**
   * Optional payload encryption hook (M6). When set, every value
   * written into `txn_transitions.payload` and `outbox.payload` is
   * wrapped in an `{ "$encrypted": ... }` envelope. The hash chain is
   * still computed over the PLAINTEXT canonical form so a key rotation
   * never invalidates `row_hash`. On read, the engine auto-decrypts.
   */
  readonly payloadCrypto?: PayloadCrypto
  /** Observability instruments (Batch H). Defaults to no-op shims. */
  readonly instruments?: EngineInstruments
}

const GENESIS_NAME = '_init'
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value)
}

export function buildRecordOps(ctx: RecordOpsContext): RecordOps {
  const { schema, tenantId, connection, hasher, hooks } = ctx
  const clock = ctx.clock ?? (() => new Date())
  const crypto = ctx.payloadCrypto

  return {
    async create(input) {
      const txn = lookupTransaction(schema, input.type)
      validateActorPermitted(
        txn,
        GENESIS_NAME,
        [actorTypeOf(input.by)],
        input.by,
        /*genesis=*/ true,
      )
      const participants = input.participants ?? {}
      validateParticipants(txn, participants)

      const result = await connection.withTenant(tenantId, async (tx) => {
        // Idempotency probe — look up an existing genesis transition
        // matching this tenant + key.
        const existing = await findExistingTransition(tx, tenantId, input.idempotencyKey)
        if (existing) {
          const record = await loadRecord(tx, tenantId, existing.txn_id)
          if (!record) {
            throw new LokiError(
              `Idempotent replay found genesis transition ${existing.id} but record ${existing.txn_id} is missing.`,
            )
          }
          return { record, replayed: true, transitionId: existing.id }
        }

        // Race-safe genesis insert (§6.2). The partial unique index
        // `(tenant_id, idempotency_key) WHERE name = '_init'` serialises
        // concurrent create() calls. We wrap BOTH the record insert
        // and the transition insert in one savepoint so the loser's
        // orphan record rolls back along with the failed transition.
        const transitionId = ulid()
        const occurredAt = clock()
        let recordId: string | null = null
        let raceConflict = false
        try {
          await tx.savepoint(async (sp) => {
            recordId = await insertRecord(sp, tenantId, txn, input.by, participants, schema.version)
            const content: CanonicalValue = {
              id: transitionId,
              txn_id: recordId,
              tenant_id: tenantId,
              type: txn.name,
              from_state: null,
              to_state: txn.initial,
              name: GENESIS_NAME,
              schema_version: schema.version,
              actor_type: input.by.type,
              actor_id: input.by.id,
              payload: {},
              idempotency_key: input.idempotencyKey,
              occurred_at: occurredAt,
              reverses: null,
            }
            const rowHash = computeRowHash(hasher, content, null)
            const postingsChecksum = computePostingsChecksum(hasher, [])
            const storagePayload = crypto ? await encryptPayload(crypto, {}) : {}
            await sp`
              insert into "txn_transitions" (
                id, tenant_id, txn_id, type, from_state, to_state, name,
                schema_version, actor_type, actor_id, payload,
                idempotency_key, trace_id, prev_hash, row_hash,
                postings_checksum, reverses, occurred_at
              ) values (
                ${transitionId}, ${tenantId}, ${recordId}, ${txn.name}, ${null},
                ${txn.initial}, ${GENESIS_NAME}, ${schema.version}, ${input.by.type}, ${input.by.id},
                ${sp.json(storagePayload as never)}, ${input.idempotencyKey}, ${input.traceId ?? null},
                ${null}, ${rowHash}, ${postingsChecksum}, ${null}, ${occurredAt}
              )
            `
          })
        } catch (e) {
          if (!isPgUniqueViolation(e)) throw e
          raceConflict = true
        }
        if (raceConflict) {
          const winner = await findExistingTransition(tx, tenantId, input.idempotencyKey)
          if (!winner) {
            throw new LokiError(
              `Idempotency key "${input.idempotencyKey}" hit a unique violation but no existing row was found.`,
            )
          }
          const winnerRecord = await loadRecord(tx, tenantId, winner.txn_id)
          if (!winnerRecord) {
            throw new LokiError(
              `Idempotent replay found genesis transition ${winner.id} but record ${winner.txn_id} is missing.`,
            )
          }
          return { record: winnerRecord, replayed: true, transitionId: winner.id }
        }
        if (recordId === null) {
          throw new LokiError('Record id was not assigned during create().')
        }

        await writeProjections(tx, schema, {
          id: transitionId,
          tenant_id: tenantId,
          txn_id: recordId,
          type: txn.name,
          name: GENESIS_NAME,
          from_state: null,
          to_state: txn.initial,
          actor_type: input.by.type,
          actor_id: input.by.id,
          schema_version: schema.version,
          occurred_at: occurredAt,
        })

        const record = await loadRecord(tx, tenantId, recordId)
        if (!record) throw new LokiError('Record vanished mid-transaction.')
        return { record, replayed: false, transitionId }
      })

      // Fire afterTransition for the synthetic _init genesis. The
      // post-commit invocation lets webhooks/log fan-out latch onto
      // record creation through the same hook surface as regular
      // transitions.
      if (!result.replayed) {
        const trail = await connection.withTenant(tenantId, (tx) =>
          loadTransition(tx, tenantId, result.transitionId),
        )
        if (trail) {
          await hooks.internals.fireAfterTransition({
            tenantId,
            record: result.record,
            transition: trail,
            txnType: result.record.type,
            transitionName: GENESIS_NAME,
            unlocked: {},
          })
        }
      }

      return { record: result.record, replayed: result.replayed }
    },

    async bulkTransition(inputs, options = {}) {
      const stopOnError = options.stopOnError ?? false
      const batchSize = options.batchSize ?? 100
      const results: BulkTransitionItem[] = []
      for (let i = 0; i < inputs.length; i += batchSize) {
        const slice = inputs.slice(i, i + batchSize)
        for (let j = 0; j < slice.length; j++) {
          const idx = i + j
          const input = slice[j] as TransitionInputArgs
          try {
            const result = await runTransition(ctx, input)
            results.push({ ok: true, index: idx, result })
          } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e))
            results.push({ ok: false, index: idx, error })
            if (stopOnError) return results
          }
        }
      }
      return results
    },

    async transition(input) {
      return runTransition(ctx, input)
    },

    async get(id) {
      return connection.withTenant(tenantId, async (tx) => loadRecord(tx, tenantId, id))
    },

    async trace(id) {
      return connection.withTenant(tenantId, async (tx) => {
        const rows = await tx<Record<string, unknown>[]>`
          select * from "txn_transitions"
          where tenant_id = ${tenantId} and txn_id = ${id}
          order by id asc
        `
        const mapped = rows.map(mapTransition)
        if (!crypto) return mapped
        const out: TxnTransition[] = []
        for (const t of mapped) {
          const decrypted = await decryptPayload(crypto, t.payload)
          out.push({ ...t, payload: (decrypted as Record<string, unknown>) ?? {} })
        }
        return out
      })
    },
  }
}

// =============================================================================
// The transition write
// =============================================================================

async function runTransition(
  ctx: RecordOpsContext,
  input: TransitionInputArgs,
): Promise<TransitionResult> {
  const instruments = ctx.instruments ?? buildInstruments()
  const startTime = Date.now()
  try {
    const result = await runTransitionInner(ctx, input)
    instruments.transitionDurationMs.observe(Date.now() - startTime, {
      type: input.id ? 'transition' : 'unknown',
      name: input.name,
    })
    return result
  } catch (e) {
    instruments.transitionErrors.inc(1, {
      name: input.name,
      error: e instanceof Error ? e.constructor.name : 'Unknown',
    })
    throw e
  }
}

async function runTransitionInner(
  ctx: RecordOpsContext,
  input: TransitionInputArgs,
): Promise<TransitionResult> {
  const { schema, tenantId, connection, hasher, hooks } = ctx
  const crypto = ctx.payloadCrypto
  const clock = ctx.clock ?? (() => new Date())

  const result = await connection.withTenant(tenantId, async (tx) => {
    // ---- 1. Idempotency probe ---------------------------------------------
    const existing = await findExistingTransition(tx, tenantId, input.idempotencyKey)
    if (existing && existing.txn_id === input.id) {
      return await replayTransition(tx, tenantId, existing.id, crypto)
    }
    if (existing) {
      throw new LokiError(
        `Idempotency key "${input.idempotencyKey}" was already used on a different record.`,
      )
    }

    // ---- 2. Lock the record + load its definition -------------------------
    const record = await lockRecord(tx, tenantId, input.id)
    if (!record) {
      throw new LokiError(`Record ${input.id} not found in tenant ${tenantId}.`)
    }
    if (record.compromised) {
      throw new CompromisedRecordError(record.id)
    }

    // ---- 2a. Re-probe after the lock (§6.2 race) --------------------------
    // We blocked on `lockRecord`; the lock holder may have just inserted a
    // transition with this exact idempotency key on this record and
    // committed. Re-checking before state validation lets the loser
    // converge to the winner's outcome instead of failing the (now
    // moved-on) state check.
    const winnerAfterLock = await findExistingTransition(tx, tenantId, input.idempotencyKey)
    if (winnerAfterLock && winnerAfterLock.txn_id === record.id) {
      return await replayTransition(tx, tenantId, winnerAfterLock.id, crypto)
    }
    if (winnerAfterLock) {
      throw new LokiError(
        `Idempotency key "${input.idempotencyKey}" was already used on a different record.`,
      )
    }

    const txnDef = lookupTransaction(schema, record.type)
    const transitionDef = txnDef.transitions[input.name]
    if (!transitionDef) {
      throw new UnknownTransitionError(record.type, input.name)
    }

    // ---- 3. Validate state legality + actor permission --------------------
    const allowedFroms = transitionDef.from.filter((s): s is string => s !== '__none__')
    if (!allowedFroms.includes(record.state)) {
      throw new IllegalStateTransitionError({
        transactionType: record.type,
        transitionName: input.name,
        currentState: record.state,
        allowedFromStates: allowedFroms,
      })
    }
    validateActorPermitted(
      txnDef,
      input.name,
      transitionDef.by.map((a: ActorDef) => a.name),
      input.by,
      /*genesis=*/ false,
    )

    // ---- 4. Validate `needs` key (lock the row) ---------------------------
    if (transitionDef.needs) {
      const keyName = transitionDef.needs
      if (input.withKey === undefined || !isUuid(input.withKey)) {
        throw new KeyAlreadyConsumedError(record.id, keyName)
      }
      const [keyRow] = await tx<Record<string, unknown>[]>`
        select * from "txn_keys"
        where tenant_id = ${tenantId} and id = ${input.withKey}
        for update
      `
      if (!keyRow || keyRow['status'] !== 'active' || keyRow['name'] !== keyName) {
        throw new KeyAlreadyConsumedError(record.id, keyName)
      }
      // Honour `expires_at`. The reconciler is the janitor that flips
      // stale rows to `status = 'expired'` (any side-effect inside this
      // tx would be rolled back when we throw); here we only refuse.
      const expiresAt = keyRow['expires_at'] as Date | null
      if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
        throw new KeyAlreadyConsumedError(record.id, keyName)
      }
    }

    // ---- 5. Build participant handles + compute postings ------------------
    const transitionId = ulid()
    const occurredAt = clock()
    const data = input.data ?? {}
    const participantHandles = await buildParticipantHandles(
      tx,
      tenantId,
      record.participants,
      schema,
    )
    // Postings come from one of two sources:
    //   - a user-supplied function (regular transitions)
    //   - an `invert:<name>` reference (reversal transitions): load
    //     the original transition's postings and flip every direction
    const postingsResolution = await resolvePostingsForTransition({
      schema,
      transitionDef,
      tx,
      tenantId,
      record,
      data,
      participantHandles,
      occurredAt,
      transitionId,
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      ...(ctx.shardPicker !== undefined ? { shardPicker: ctx.shardPicker } : {}),
    })
    const resolvedPostings = postingsResolution.postings
    const reverses = postingsResolution.reversesTransitionId

    // H3: a transition that declares `postings` MUST resolve at least
    // one. State-only transitions don't declare it; if a function was
    // supplied and returned `[]`, that's almost always a bug — the
    // author meant to return debits/credits and forgot. `assertBalanced`
    // would silently pass `[]`, so we backstop here.
    if (transitionDef.postings !== undefined && resolvedPostings.length === 0) {
      throw new InvalidPostingError(
        'transition declared `postings` but resolved to an empty list',
        { txnType: record.type, transition: input.name },
      )
    }

    // ---- 6. Lock affected accounts (deterministic id order) ---------------
    await lockAccountsInOrder(
      tx,
      tenantId,
      resolvedPostings.map((p) => p.accountId),
    )
    assertBalanced(resolvedPostings)

    if (transitionDef.invariant) {
      const invCtx = {
        data,
        participants: participantHandles,
        tenantId,
        traceId: input.traceId ?? '',
        transitionId,
        occurredAt,
      }
      const ok = await transitionDef.invariant(invCtx as never)
      if (!ok) {
        throw new RejectTransition(`invariant on ${record.type}.${input.name} returned false`)
      }
    }

    // ---- 6.5. beforeTransition hook (pre-commit) -------------------------
    // Fires after all validation but before any writes — a throw here
    // rolls back the entire tx with no side effects on the DB. This is
    // the application's last chance to abort cleanly.
    await hooks.internals.fireBeforeTransition({
      tenantId,
      record,
      txnType: record.type,
      transitionName: input.name,
      actor: input.by,
      data,
      idempotencyKey: input.idempotencyKey,
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
    })

    // ---- 7. Compute hash chain --------------------------------------------
    const prevHash = await loadLatestRowHash(tx, tenantId, record.id)
    // Hash the JSON-storage form of the payload — same form the
    // reconciler reads back from `txn_transitions.payload`. Hashing the
    // raw bigint object would diverge from the recomputation and
    // produce false `hash_chain_break` anomalies.
    const content: CanonicalValue = {
      id: transitionId,
      txn_id: record.id,
      tenant_id: tenantId,
      type: record.type,
      from_state: record.state,
      to_state: transitionDef.to,
      name: input.name,
      // Each transition row carries the schema version active *when
      // it was written* (§14). Old records keep their original version;
      // new transitions on them get today's. The reconciler reads
      // both shapes through the alias map.
      schema_version: schema.version,
      actor_type: input.by.type,
      actor_id: input.by.id,
      payload: jsonifyForStorage(data) as CanonicalValue,
      idempotency_key: input.idempotencyKey,
      occurred_at: occurredAt,
      reverses,
    }
    const rowHash = computeRowHash(hasher, content, prevHash)
    const postingsChecksum = computePostingsChecksum(
      hasher,
      resolvedPostings.map((p) => ({
        account_id: p.accountId,
        direction: p.direction,
        amount: p.amount,
      })),
    )

    // M6: encrypt the JSON-storage form AFTER the hash has been
    // computed over plaintext. Storage holds an envelope; the hash
    // chain still verifies because the reconciler decrypts before
    // recomputing.
    const jsonifiedPayload = jsonifyForStorage(data)
    const storageTransitionPayload = crypto
      ? await encryptPayload(crypto, jsonifiedPayload)
      : jsonifiedPayload

    // ---- 8. INSERT transition + postings + balance update -----------------
    // §6.2 idempotency under races: the probe at step 1 doesn't hold a
    // lock on `(tenant_id, idempotency_key)`. Two writers that miss
    // simultaneously will both reach this INSERT; one wins, the other
    // hits the unique index. Wrap in a savepoint so the loser can
    // recover and replay the winner's outcome inside the same tx.
    let raceConflict = false
    try {
      await tx.savepoint(async (sp) => {
        await sp`
          insert into "txn_transitions" (
            id, tenant_id, txn_id, type, from_state, to_state, name,
            schema_version, actor_type, actor_id, payload,
            idempotency_key, trace_id, prev_hash, row_hash,
            postings_checksum, reverses, occurred_at
          ) values (
            ${transitionId}, ${tenantId}, ${record.id}, ${record.type}, ${record.state},
            ${transitionDef.to}, ${input.name}, ${schema.version},
            ${input.by.type}, ${input.by.id}, ${sp.json(storageTransitionPayload as never)},
            ${input.idempotencyKey}, ${input.traceId ?? null},
            ${prevHash}, ${rowHash}, ${postingsChecksum}, ${reverses}, ${occurredAt}
          )
        `
      })
    } catch (e) {
      if (!isPgUniqueViolation(e)) throw e
      raceConflict = true
    }
    if (raceConflict) {
      const winner = await findExistingTransition(tx, tenantId, input.idempotencyKey)
      if (winner && winner.txn_id === record.id) {
        return await replayTransition(tx, tenantId, winner.id, crypto)
      }
      throw new LokiError(
        `Idempotency key "${input.idempotencyKey}" was already used on a different record.`,
      )
    }

    await writeProjections(tx, schema, {
      id: transitionId,
      tenant_id: tenantId,
      txn_id: record.id,
      type: record.type,
      name: input.name,
      from_state: record.state,
      to_state: transitionDef.to,
      actor_type: input.by.type,
      actor_id: input.by.id,
      schema_version: schema.version,
      occurred_at: occurredAt,
    })

    const insertedPostings: Posting[] = []
    for (const p of resolvedPostings) {
      const [row] = await tx<Record<string, unknown>[]>`
        insert into "postings" (tenant_id, transition_id, account_id, amount, direction, occurred_at)
        values (${tenantId}, ${transitionId}, ${p.accountId}, ${p.amount.toString()}, ${p.direction}, ${occurredAt})
        returning *
      `
      if (row) insertedPostings.push(mapPosting(row))
    }

    // M1 overdraft enforcement. Sum per-account net deltas first so a
    // transition with both a debit and a credit on the same account
    // (rare but legal) is checked against the net effect, not each
    // half. Reversal transitions (`invert:`) bypass — the whole point
    // of a reversal is to refund, and the reversal author is taking
    // responsibility for the resulting state.
    const isReversal = reverses !== null
    const netByAccount = new Map<string, bigint>()
    for (const p of resolvedPostings) {
      const delta = p.direction === 'C' ? p.amount : -p.amount
      netByAccount.set(p.accountId, (netByAccount.get(p.accountId) ?? 0n) + delta)
    }
    // Posting-level overdraft flag was carried up from `resolveDrafts`
    // (and rehydrated for reversals via the source row's account def).
    const overdraftByAccount = new Map<string, boolean>()
    for (const p of resolvedPostings) {
      // If multiple postings hit the same account, the policy is the
      // same (it's a property of the account, not the posting), but
      // record from the first.
      if (!overdraftByAccount.has(p.accountId)) {
        overdraftByAccount.set(p.accountId, p.allowOverdraft)
      }
    }
    for (const [accountId, delta] of netByAccount) {
      // Loki accounts represent "what does this actor have right now" —
      // money INTO the account is a credit, money OUT is a debit.
      const allowOverdraft = overdraftByAccount.get(accountId) ?? true
      const enforce = !isReversal && !allowOverdraft && delta < 0n
      if (enforce) {
        // Guarded update — returns 0 rows when the new balance would
        // go negative. We then surface the precise violation by
        // re-reading the current balance.
        const updated = await tx<{ balance: string }[]>`
          update "accounts"
          set balance = balance + ${delta.toString()}::numeric
          where tenant_id = ${tenantId}
            and id = ${accountId}
            and balance + ${delta.toString()}::numeric >= 0
          returning balance::text as balance
        `
        if (updated.length === 0) {
          const [current] = await tx<
            {
              balance: string
              name: string
              owner_actor_type: string
              owner_actor_id: string
              currency: string
            }[]
          >`
            select balance::text as balance, name, owner_actor_type, owner_actor_id, currency
            from "accounts" where tenant_id = ${tenantId} and id = ${accountId}
          `
          if (!current) {
            throw new LokiError(`Overdraft check could not find account ${accountId}.`)
          }
          throw new OverdraftError({
            accountId,
            accountName: current.name,
            actorType: current.owner_actor_type,
            actorId: current.owner_actor_id,
            currency: current.currency,
            currentBalance: BigInt(current.balance),
            attemptedDelta: delta,
          })
        }
      } else {
        await tx`
          update "accounts"
          set balance = balance + ${delta.toString()}::numeric
          where tenant_id = ${tenantId} and id = ${accountId}
        `
      }
    }

    // ---- 9. Keys: consume `needs`, mint `unlocks` ------------------------
    const consumedKeyId = transitionDef.needs && input.withKey ? input.withKey : null
    if (consumedKeyId) {
      await tx`
        update "txn_keys"
        set status = 'consumed', consumed_by_transition_id = ${transitionId}
        where tenant_id = ${tenantId} and id = ${consumedKeyId}
      `
    }

    const unlockedMap: Record<string, string> = {}
    for (const spec of transitionDef.unlocks) {
      const keyName = typeof spec === 'string' ? spec : spec.name
      const ttlMs = typeof spec === 'string' ? null : spec.ttlMs
      const expiresAt = ttlMs !== null ? new Date(occurredAt.getTime() + ttlMs) : null
      const [row] = await tx<Record<string, unknown>[]>`
        insert into "txn_keys" (
          tenant_id, txn_id, name, granted_by_transition_id, status, expires_at
        ) values (
          ${tenantId}, ${record.id}, ${keyName}, ${transitionId}, 'active', ${expiresAt}
        ) returning id
      `
      if (row) unlockedMap[keyName] = row['id'] as string
    }

    // Active key set on the record reflects the new minted keys minus
    // the consumed one.
    const activeKeysSet = new Set(record.activeKeys)
    if (transitionDef.needs) activeKeysSet.delete(transitionDef.needs)
    for (const spec of transitionDef.unlocks) {
      activeKeysSet.add(typeof spec === 'string' ? spec : spec.name)
    }
    const activeKeys = Array.from(activeKeysSet)

    // ---- 10. Bump record state + version ---------------------------------
    const [recordRow] = await tx<Record<string, unknown>[]>`
      update "txn_records"
      set state = ${transitionDef.to},
          active_keys = ${tx.json(activeKeys)},
          version = version + 1,
          updated_at = ${occurredAt}
      where tenant_id = ${tenantId}
        and id = ${record.id}
        and version = ${record.version}
        and compromised = false
      returning *
    `
    if (!recordRow) {
      throw new ConcurrencyConflictError(record.id, 1)
    }

    // ---- 11. Outbox -------------------------------------------------------
    // A row is emitted when either `emit` or `intent` is declared. The
    // `event` column carries the past-tense fan-out name; `intent`
    // carries the adapter-routing directive. Either may be NULL.
    if (transitionDef.emit || transitionDef.intent) {
      const eventName = transitionDef.emit ?? transitionDef.intent ?? null
      // M6: outbox payloads share the transition's encryption envelope.
      // The same `jsonifiedPayload` is reused so the two columns hold
      // byte-identical plaintext (or byte-identical ciphertext under
      // crypto with a deterministic IV; either way the round-trip is
      // sound — adapters call `engine.decryptPayload(event.payload)` for
      // raw rows or use the auto-decrypted form via `OutboxEvent`).
      const storageOutboxPayload = crypto
        ? await encryptPayload(crypto, jsonifiedPayload)
        : jsonifiedPayload
      await tx`
        insert into "outbox" (
          tenant_id, txn_id, transition_id, event, intent, payload
        ) values (
          ${tenantId},
          ${record.id},
          ${transitionId},
          ${eventName},
          ${transitionDef.intent ?? null},
          ${tx.json(storageOutboxPayload as never)}
        )
      `
    }

    // ---- Return -----------------------------------------------------------
    const newRecord = mapRecord(recordRow)
    const newTransition = await loadTransition(tx, tenantId, transitionId)
    if (!newTransition) {
      throw new LokiError('Inserted transition not retrievable.')
    }
    const decryptedTransition = crypto
      ? {
          ...newTransition,
          payload:
            ((await decryptPayload(crypto, newTransition.payload)) as Record<string, unknown>) ??
            {},
        }
      : newTransition
    return {
      record: newRecord,
      transition: decryptedTransition,
      postings: insertedPostings,
      unlocked: unlockedMap,
      replayed: false,
    }
  })

  // afterTransition fires once the DB tx has committed. Errors are
  // isolated and routed to onHookFailure so a slow webhook never
  // affects the engine's response time.
  if (!result.replayed) {
    await hooks.internals.fireAfterTransition({
      tenantId,
      record: result.record,
      transition: result.transition,
      txnType: result.record.type,
      transitionName: result.transition.name,
      unlocked: result.unlocked,
    })
    if (result.transition.reverses !== null) {
      await hooks.internals.fireReversal({
        tenantId,
        recordId: result.record.id,
        txnType: result.record.type,
        reverseTransitionId: result.transition.id,
        reversedTransitionId: result.transition.reverses,
        transitionName: result.transition.name,
        automated: false,
      })
    }
  }

  return result
}

// =============================================================================
// Replay
// =============================================================================

async function replayTransition(
  tx: SqlTransaction,
  tenantId: string,
  transitionId: string,
  crypto?: PayloadCrypto,
): Promise<TransitionResult> {
  const transition = await loadTransition(tx, tenantId, transitionId)
  if (!transition) {
    throw new LokiError(`Replay: transition ${transitionId} not found.`)
  }
  const record = await loadRecord(tx, tenantId, transition.txnId)
  if (!record) {
    throw new LokiError(`Replay: record ${transition.txnId} not found.`)
  }
  const postingsRows = await tx<Record<string, unknown>[]>`
    select * from "postings"
    where tenant_id = ${tenantId} and transition_id = ${transitionId}
  `
  const unlockedRows = await tx<Record<string, unknown>[]>`
    select id, name from "txn_keys"
    where tenant_id = ${tenantId}
      and granted_by_transition_id = ${transitionId}
  `
  const unlocked: Record<string, string> = {}
  for (const r of unlockedRows) unlocked[r['name'] as string] = r['id'] as string
  const decrypted = crypto
    ? {
        ...transition,
        payload:
          ((await decryptPayload(crypto, transition.payload)) as Record<string, unknown>) ?? {},
      }
    : transition
  return {
    record,
    transition: decrypted,
    postings: postingsRows.map(mapPosting),
    unlocked,
    replayed: true,
  }
}

// =============================================================================
// Helpers
// =============================================================================

function lookupTransaction(schema: SchemaDef, type: string): TransactionDef {
  const txn = schema.meta.transactionsByName.get(type)
  if (!txn) {
    throw new LokiError(`Schema has no transaction type "${type}".`)
  }
  return txn
}

function actorTypeOf(actor: ActorRef): string {
  return actor.type
}

function validateActorPermitted(
  txn: TransactionDef,
  transitionName: string,
  permittedActorTypes: readonly string[],
  by: ActorRef,
  genesis: boolean,
): void {
  if (genesis) return // Engine's `_init` doesn't constrain by-clauses.
  if (permittedActorTypes.length === 0) return // Open transition.
  if (!permittedActorTypes.includes(by.type)) {
    throw new ActorNotPermittedError({
      transactionType: txn.name,
      transitionName,
      actorType: by.type,
      permitted: permittedActorTypes,
    })
  }
}

function validateParticipants(
  txn: TransactionDef,
  participants: Readonly<Record<string, ActorRef>>,
): void {
  for (const [slot, actor] of Object.entries(participants)) {
    const declared = (txn.participants as Record<string, ActorDef>)[slot]
    if (!declared) {
      throw new LokiError(`Transaction "${txn.name}" has no participant slot "${slot}".`)
    }
    if (declared.name !== actor.type) {
      throw new LokiError(
        `Participant "${slot}" expects actor type "${declared.name}" but got "${actor.type}".`,
      )
    }
  }
}

async function findExistingTransition(
  tx: SqlTransaction,
  tenantId: string,
  idempotencyKey: string,
): Promise<{ id: string; txn_id: string } | null> {
  const [row] = await tx<{ id: string; txn_id: string }[]>`
    select id, txn_id from "txn_transitions"
    where tenant_id = ${tenantId} and idempotency_key = ${idempotencyKey}
    limit 1
  `
  return row ?? null
}

/**
 * Postgres unique-violation detection. The 23505 SQLSTATE bubbles up
 * verbatim from postgres.js inside an open tx; outside a tx the
 * connection wrapper repackages it under `.cause`. Either way we
 * recognise the unique-violation we raise on `(tenant_id, txn_id,
 * idempotency_key)` so the engine can reconverge to the winner.
 */
function isPgUniqueViolation(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false
  const direct = (e as { code?: unknown }).code
  if (direct === '23505') return true
  const cause = (e as { cause?: unknown }).cause
  if (cause && typeof cause === 'object' && (cause as { code?: unknown }).code === '23505') {
    return true
  }
  return false
}

async function lockRecord(
  tx: SqlTransaction,
  tenantId: string,
  id: string,
): Promise<TxnRecord | null> {
  const [row] = await tx<Record<string, unknown>[]>`
    select * from "txn_records"
    where tenant_id = ${tenantId} and id = ${id}
    for update
  `
  return row ? mapRecord(row) : null
}

async function loadRecord(
  tx: SqlTransaction,
  tenantId: string,
  id: string,
): Promise<TxnRecord | null> {
  const [row] = await tx<Record<string, unknown>[]>`
    select * from "txn_records"
    where tenant_id = ${tenantId} and id = ${id}
  `
  return row ? mapRecord(row) : null
}

async function loadTransition(
  tx: SqlTransaction,
  tenantId: string,
  id: string,
): Promise<TxnTransition | null> {
  const [row] = await tx<Record<string, unknown>[]>`
    select * from "txn_transitions"
    where tenant_id = ${tenantId} and id = ${id}
  `
  return row ? mapTransition(row) : null
}

async function insertRecord(
  tx: SqlTransaction,
  tenantId: string,
  txn: TransactionDef,
  by: ActorRef,
  participants: Readonly<Record<string, ActorRef>>,
  schemaVersion: number,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into "txn_records" (
      tenant_id, type, state, version, active_keys, participants,
      schema_version, created_by_actor_type, created_by_actor_id
    ) values (
      ${tenantId}, ${txn.name}, ${txn.initial}, 0, ${tx.json([])},
      ${tx.json(participants as never)},
      ${schemaVersion}, ${by.type}, ${by.id}
    ) returning id
  `
  if (!row) throw new LokiError('Record insert returned no row.')
  return row.id
}

async function loadLatestRowHash(
  tx: SqlTransaction,
  tenantId: string,
  txnId: string,
): Promise<Buffer | null> {
  const [row] = await tx<{ row_hash: Buffer }[]>`
    select row_hash from "txn_transitions"
    where tenant_id = ${tenantId} and txn_id = ${txnId}
    order by id desc
    limit 1
  `
  return row?.row_hash ?? null
}

async function buildParticipantHandles(
  _tx: SqlTransaction,
  _tenantId: string,
  participants: Readonly<Record<string, ActorRef>>,
  schema: SchemaDef,
): Promise<Readonly<Record<string, ParticipantHandle>>> {
  const handles: Record<string, ParticipantHandle> = {}
  for (const [slot, actor] of Object.entries(participants)) {
    const actorDef = schema.meta.actorsByName.get(actor.type)
    const accounts: Record<string, AccountInstanceRef> = {}
    if (actorDef) {
      for (const accountName of Object.keys(actorDef.accounts)) {
        const decl = lookupAccountDecl(schema, actor.type, accountName)
        accounts[accountName] = {
          _kind: 'accountInstance',
          actorType: actor.type,
          actorId: actor.id,
          accountName,
          currency: decl.currency,
        }
      }
    }
    handles[slot] = { id: actor.id, ...accounts }
  }
  return handles
}

type ParticipantHandle = {
  readonly id: string
  readonly [key: string]: AccountInstanceRef | string
}

type ResolvedPosting = {
  readonly accountId: string
  readonly direction: 'D' | 'C'
  readonly amount: bigint
  /** Account currency. Drives per-currency balance enforcement (M16). */
  readonly currency: string
  /** Whether the schema allows the balance on this account to go negative (M1). */
  readonly allowOverdraft: boolean
}

type PostingsResolution = {
  readonly postings: readonly ResolvedPosting[]
  /**
   * For reversal transitions (`invert:<name>` postings), the id of
   * the original transition this one undoes — written to the
   * `txn_transitions.reverses` column.
   */
  readonly reversesTransitionId: string | null
}

type ResolveTransitionPostingsArgs = {
  readonly schema: SchemaDef
  readonly transitionDef: { postings?: unknown }
  readonly tx: SqlTransaction
  readonly tenantId: string
  readonly record: TxnRecord
  readonly data: Record<string, unknown>
  readonly participantHandles: Readonly<Record<string, ParticipantHandle>>
  readonly occurredAt: Date
  readonly transitionId: string
  readonly traceId?: string
  readonly shardPicker?: (n: number) => number
}

/**
 * Compute the postings list for a transition, regardless of whether
 * the schema supplies a function or an `invert:<name>` reference.
 *
 *   - Function form: invoke the user fn → drafts → resolve account
 *     refs to account ids → posting list.
 *   - Invert form: locate the latest transition on this record whose
 *     name matches one of the targets, load its postings (which
 *     already carry account ids), and flip every direction. Returns
 *     the original transition's id as `reversesTransitionId` so the
 *     engine writes the `reverses` link.
 */
async function resolvePostingsForTransition(
  args: ResolveTransitionPostingsArgs,
): Promise<PostingsResolution> {
  const { transitionDef, tx, tenantId, record, data, participantHandles } = args
  const fn = transitionDef.postings

  if (fn === undefined) {
    return { postings: [], reversesTransitionId: null }
  }

  if (typeof fn === 'string') {
    return resolveInvertReference(tx, args.schema, tenantId, record, fn)
  }

  const ctx = {
    data,
    participants: participantHandles as never,
    tenantId,
    traceId: args.traceId ?? '',
    transitionId: args.transitionId,
    occurredAt: args.occurredAt,
  }
  const drafts = (fn as (c: typeof ctx) => readonly PostingDraft[])(ctx)
  const postings = await resolveDrafts(tx, args.schema, tenantId, drafts, args.shardPicker)
  return { postings, reversesTransitionId: null }
}

async function resolveDrafts(
  tx: SqlTransaction,
  schema: SchemaDef,
  tenantId: string,
  drafts: readonly PostingDraft[],
  shardPicker?: (n: number) => number,
): Promise<readonly ResolvedPosting[]> {
  const out: ResolvedPosting[] = []
  for (const d of drafts) {
    const ref = d.account
    if (d.amount < 0n) {
      throw new InvalidPostingError('posting amount must be ≥ 0', {
        direction: d.direction,
        account: `${ref.actorType}:${ref.actorId}.${ref.accountName}`,
        amount: d.amount.toString(),
      })
    }
    // Hot-account sharding (§6.1): for accounts declared with
    // `shards: N`, the engine picks a shard pseudorandomly at write
    // time. Reads sum across shards; the cache stays correct because
    // every leg of the same posting only updates one shard. shard 0
    // is the only shard for unsharded accounts, so the random pick
    // collapses to it.
    const ids = await tx<{ id: string }[]>`
      select id from "accounts"
      where tenant_id = ${tenantId}
        and owner_actor_type = ${ref.actorType}
        and owner_actor_id = ${ref.actorId}
        and name = ${ref.accountName}
        and currency = ${ref.currency}
    `
    if (ids.length === 0) {
      throw new LokiError(
        `Posting target account ${ref.actorType}:${ref.actorId}.${ref.accountName} (${ref.currency}) does not exist; provision it via accounts.create() first.`,
      )
    }
    const pickIdx = shardPicker
      ? Math.max(0, Math.min(ids.length - 1, Math.floor(shardPicker(ids.length))))
      : Math.floor(Math.random() * ids.length)
    const pick = ids[pickIdx] as { id: string }
    // Carry the schema's overdraft policy for the M1 enforcement
    // pass. Defaults to `true` if the actor or account isn't found
    // — that branch shouldn't happen because the SQL above already
    // confirmed the row exists.
    const accountDef = lookupAccountDecl(schema, ref.actorType, ref.accountName)
    out.push({
      accountId: pick.id,
      direction: d.direction,
      amount: d.amount,
      currency: ref.currency,
      allowOverdraft: accountDef?.allowOverdraft ?? true,
    })
  }
  return out
}

const INVERT_PREFIX = 'invert:'

async function resolveInvertReference(
  tx: SqlTransaction,
  schema: SchemaDef,
  tenantId: string,
  record: TxnRecord,
  spec: string,
): Promise<PostingsResolution> {
  if (!spec.startsWith(INVERT_PREFIX)) {
    throw new LokiError(`Unknown postings reference "${spec}".`)
  }
  const targets = spec
    .slice(INVERT_PREFIX.length)
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (targets.length === 0) {
    throw new LokiError(`Empty invert target list in "${spec}".`)
  }

  // Find the latest transition on this record whose name is one of the
  // declared targets. ULIDs are sortable strings so DESC by id gives us
  // the most recent.
  const [original] = await tx<{ id: string }[]>`
    select id from "txn_transitions"
    where tenant_id = ${tenantId}
      and txn_id = ${record.id}
      and name = any(${targets})
      and reverses is null
    order by id desc
    limit 1
  `
  if (!original) {
    throw new LokiError(
      `Reversal transition cannot find a non-reversed prior transition on record ${record.id} matching ${JSON.stringify(targets)}.`,
    )
  }

  // Join accounts to recover the per-leg currency — drives M16's
  // per-currency balance assertion on the inverted set.
  const rows = await tx<
    { account_id: string; direction: 'D' | 'C'; amount: string; currency: string }[]
  >`
    select p.account_id, p.direction, p.amount::text as amount, a.currency
    from "postings" p
    join "accounts" a on a.id = p.account_id
    where p.transition_id = ${original.id} and p.tenant_id = ${tenantId}
  `
  if (rows.length === 0) {
    throw new LokiError(`Original transition ${original.id} has no postings to invert.`)
  }
  // Reversals bypass overdraft enforcement at the call site (M1), but
  // we still populate `allowOverdraft` faithfully from the schema so
  // anyone reading the resolved structure sees consistent metadata.
  // The lookup falls back to `true` for accounts whose actor type
  // isn't currently in the schema (e.g. mid-rename across versions).
  const inverted: ResolvedPosting[] = []
  for (const r of rows) {
    const [account] = await tx<{ owner_actor_type: string; name: string }[]>`
      select owner_actor_type, name from "accounts" where id = ${r.account_id}
    `
    const def = account ? lookupAccountDecl(schema, account.owner_actor_type, account.name) : null
    inverted.push({
      accountId: r.account_id,
      direction: r.direction === 'D' ? ('C' as const) : ('D' as const),
      amount: BigInt(r.amount),
      currency: r.currency,
      allowOverdraft: def?.allowOverdraft ?? true,
    })
  }
  return { postings: inverted, reversesTransitionId: original.id }
}

async function lockAccountsInOrder(
  tx: SqlTransaction,
  tenantId: string,
  ids: readonly string[],
): Promise<void> {
  const unique = Array.from(new Set(ids)).sort()
  if (unique.length === 0) return
  // Pre-sorted ids ensures consistent lock order across processes — the
  // §6.1 deadlock-avoidance contract.
  // Postgres OID for `uuid` is 2950. Tagged with `tx.array(_, 2950)` so
  // postgres.js sends a uuid[] rather than text[], avoiding a lateral
  // cast on every lock acquisition.
  const UUID_OID = 2950
  await tx`
    select id from "accounts"
    where tenant_id = ${tenantId} and id = any(${tx.array(unique, UUID_OID)})
    order by id
    for update
  `
}

/**
 * Enforces sum(D) === sum(C) per currency (§M16 multi-currency).
 * An FX transition has multiple currencies, each balanced on its own;
 * the cross-currency relationship lives in the payload (rate metadata).
 */
function assertBalanced(postings: readonly ResolvedPosting[]): void {
  const byCurrency = new Map<string, { debits: bigint; credits: bigint }>()
  for (const p of postings) {
    const slot = byCurrency.get(p.currency) ?? { debits: 0n, credits: 0n }
    if (p.direction === 'D') slot.debits += p.amount
    else slot.credits += p.amount
    byCurrency.set(p.currency, slot)
  }
  for (const [currency, { debits, credits }] of byCurrency) {
    if (debits !== credits) throw new UnbalancedPostingsError(debits, credits, currency)
  }
}

// =============================================================================
// Row mappers
// =============================================================================

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

export function mapTransition(row: Record<string, unknown>): TxnTransition {
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

/**
 * Convert a payload that may contain non-JSON-native values to a
 * JSON-safe representation that round-trips through Postgres JSONB
 * AND yields the same canonical bytes as the original value when fed
 * back through `canonicalize`.
 *
 * Encodings:
 *   - `bigint` → `{ "$bigint": "<digits>" }`
 *   - `Date`   → ISO-8601 string (matches `canonicalize`'s Date output)
 *   - `Buffer` / `Uint8Array` → hex string (matches the canonicalize
 *     `$bytes` envelope for hash inputs that read this back).
 *
 * H1 fix: previously a `Date` in payload produced `{}` (because
 * `Object.keys(date)` is empty) which silently diverged from the
 * write-time hash. Reconciliation read `{}` back, recomputed a
 * different `row_hash`, and reported a false `hash_chain_break` on
 * every sweep.
 */
export function jsonifyForStorage(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return { $bigint: value.toString() }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new LokiError('Invalid Date in payload — cannot store in jsonb.')
    }
    return value.toISOString()
  }
  if (Array.isArray(value)) return value.map(jsonifyForStorage)
  if (value instanceof Uint8Array) {
    // Wrap in the same envelope `canonicalize` emits for byte values
    // so the round-trip through JSONB rehashes to the same bytes.
    return { $bytes: Buffer.from(value).toString('hex') }
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) out[k] = jsonifyForStorage(v[k])
    return out
  }
  return value
}

function mapPosting(row: Record<string, unknown>): Posting {
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

type ProjectionSourceRow = {
  readonly id: string
  readonly tenant_id: string
  readonly txn_id: string
  readonly type: string
  readonly name: string
  readonly from_state: string | null
  readonly to_state: string
  readonly actor_type: string
  readonly actor_id: string
  readonly schema_version: number
  readonly occurred_at: Date
}

/**
 * Materialized-projection write-path (§12.9). Called inside the same
 * transition tx as the source `txn_transitions` insert — the
 * projection cannot lag because nothing commits without it. Skipped
 * silently when the schema declares no projections, so the cost is a
 * cheap loop check, not a per-write round-trip.
 */
async function writeProjections(
  tx: SqlTransaction,
  schema: SchemaDef,
  source: ProjectionSourceRow,
): Promise<void> {
  if (schema.projections.length === 0) return
  for (const projection of schema.projections) {
    if (projection.when?.actorType && projection.when.actorType !== source.actor_type) {
      continue
    }
    const cols = projection.columns
    const values = cols.map((c) => source[c as keyof ProjectionSourceRow] ?? null)
    const colList = cols.map((c) => `"${c}"`).join(', ')
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
    const tableName = `proj_${projection.name}`
    await tx.unsafe(
      `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
      values as never,
    )
  }
}

export type { AccountIdentity }
