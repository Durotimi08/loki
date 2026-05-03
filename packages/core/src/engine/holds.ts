import type { Connection } from './connection.js'
import { LokiError } from './errors.js'

/**
 * First-class holds — M17 (Batch E).
 *
 * A hold reserves funds against a "hold account" without finalising a
 * money-movement record. Common use case: card auths that pre-authorise
 * up to a limit, then capture or release later.
 *
 * Honest scope: this batch ships the storage table + the helper API
 * only. The schema-DSL primitive (`defineHold`) that would let
 * operators wire holds into typed transitions is a follow-up — for
 * now, callers compose holds with capability keys and the existing
 * scheduler manually.
 *
 * Postings: a `placed` hold debits the source account and credits the
 * hold account. `release` reverses that. `expire` is what the
 * scheduler applies when `expires_at` passes — same effect as
 * `release` from the funds perspective. `captured` is opaque to the
 * engine; consumers move it onto a normal transition.
 */

export type HoldStatus = 'placed' | 'released' | 'expired' | 'captured'

export type Hold = {
  readonly id: string
  readonly tenantId: string
  readonly txnId: string | null
  readonly holdAccountId: string
  readonly amount: bigint
  readonly status: HoldStatus
  readonly expiresAt: Date | null
  readonly releasedByTransitionId: string | null
  readonly placedAt: Date
  readonly releasedAt: Date | null
}

export type PlaceHoldInput = {
  readonly tenantId: string
  readonly holdAccountId: string
  readonly amount: bigint
  /** Optional record this hold is associated with (mirror of an in-flight purchase). */
  readonly txnId?: string
  readonly expiresAt?: Date
}

export type ReleaseHoldInput = {
  readonly id: string
  /** Released as a result of a follow-up transition; recorded for audit. */
  readonly releasedByTransitionId?: string
}

export type ExpireHoldsResult = {
  readonly expired: readonly string[]
}

export type HoldsOps = {
  /** Insert a hold row in `placed` status. */
  place(input: PlaceHoldInput): Promise<Hold>
  /** Move `placed` → `released`. Idempotent: returns the existing row when already released. */
  release(input: ReleaseHoldInput): Promise<Hold>
  /**
   * Flip every `placed` hold whose `expires_at` has passed to `expired`.
   * Returns the affected hold ids. Run from a scheduler tick.
   */
  expireDue(now?: Date): Promise<ExpireHoldsResult>
  /** Read a single hold. */
  get(id: string): Promise<Hold | null>
  /** List holds for a tenant, optionally filtered by status. */
  list(args: { tenantId: string; status?: HoldStatus; limit?: number }): Promise<readonly Hold[]>
}

export function buildHoldsOps(connection: Connection): HoldsOps {
  return {
    async place(input) {
      if (input.amount <= 0n) {
        throw new LokiError(`Hold amount must be positive, got ${input.amount}.`)
      }
      return connection.asAdmin(async (tx) => {
        const [row] = await tx<Record<string, unknown>[]>`
          insert into "txn_holds" (
            tenant_id, txn_id, hold_account_id, amount, status, expires_at
          ) values (
            ${input.tenantId},
            ${input.txnId ?? null},
            ${input.holdAccountId},
            ${input.amount.toString()},
            'placed',
            ${input.expiresAt ?? null}
          )
          returning id, tenant_id, txn_id, hold_account_id,
                    amount::text as amount, status, expires_at,
                    released_by_transition_id, placed_at, released_at
        `
        if (!row) throw new LokiError('Failed to insert txn_holds row.')
        return mapHold(row)
      })
    },

    async release(input) {
      return connection.asAdmin(async (tx) => {
        const [row] = await tx<Record<string, unknown>[]>`
          update "txn_holds"
          set status = 'released',
              released_by_transition_id = ${input.releasedByTransitionId ?? null},
              released_at = now()
          where id = ${input.id} and status = 'placed'
          returning id, tenant_id, txn_id, hold_account_id,
                    amount::text as amount, status, expires_at,
                    released_by_transition_id, placed_at, released_at
        `
        if (row) return mapHold(row)
        // Not in `placed` — return the row as-is (idempotent).
        const [existing] = await tx<Record<string, unknown>[]>`
          select id, tenant_id, txn_id, hold_account_id,
                 amount::text as amount, status, expires_at,
                 released_by_transition_id, placed_at, released_at
          from "txn_holds" where id = ${input.id}
        `
        if (!existing) throw new LokiError(`Hold ${input.id} not found.`)
        return mapHold(existing)
      })
    },

    async expireDue(now = new Date()) {
      return connection.asAdmin(async (tx) => {
        const rows = await tx<{ id: string }[]>`
          update "txn_holds"
          set status = 'expired', released_at = ${now}
          where status = 'placed'
            and expires_at is not null
            and expires_at <= ${now}
          returning id
        `
        return { expired: rows.map((r) => r.id) }
      })
    },

    async get(id) {
      return connection.asAdmin(async (tx) => {
        const [row] = await tx<Record<string, unknown>[]>`
          select id, tenant_id, txn_id, hold_account_id,
                 amount::text as amount, status, expires_at,
                 released_by_transition_id, placed_at, released_at
          from "txn_holds" where id = ${id}
        `
        return row ? mapHold(row) : null
      })
    },

    async list(args) {
      const limit = Math.min(1000, Math.max(1, args.limit ?? 100))
      return connection.asAdmin(async (tx) => {
        const statusFrag = args.status ? tx`and status = ${args.status}` : tx``
        const rows = await tx<Record<string, unknown>[]>`
          select id, tenant_id, txn_id, hold_account_id,
                 amount::text as amount, status, expires_at,
                 released_by_transition_id, placed_at, released_at
          from "txn_holds"
          where tenant_id = ${args.tenantId}
            ${statusFrag}
          order by placed_at desc
          limit ${limit}
        `
        return rows.map(mapHold)
      })
    },
  }
}

function mapHold(row: Record<string, unknown>): Hold {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    txnId: (row['txn_id'] as string | null) ?? null,
    holdAccountId: row['hold_account_id'] as string,
    amount: BigInt(row['amount'] as string),
    status: row['status'] as HoldStatus,
    expiresAt: (row['expires_at'] as Date | null) ?? null,
    releasedByTransitionId: (row['released_by_transition_id'] as string | null) ?? null,
    placedAt: row['placed_at'] as Date,
    releasedAt: (row['released_at'] as Date | null) ?? null,
  }
}
