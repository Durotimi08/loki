import type { Connection } from './connection.js'
import { LokiError } from './errors.js'

/**
 * First-class disputes — M17 (Batch E).
 *
 * A dispute opens against a specific transition (a charge, a payout)
 * and resolves either way: customer-favourable (refund / chargeback)
 * or merchant-favourable (no-op). Deadlines are tracked so the
 * existing scheduler can auto-close opens that don't get resolved in
 * time.
 *
 * Honest scope: the storage table + the helper API only. The
 * `defineDispute` schema-DSL primitive that would emit a typed
 * resolution transition is a follow-up — for now, callers wire the
 * resolution by invoking `engine.disputes.resolve()` and (if a refund
 * is required) running their declared refund transition manually.
 */

export type DisputeStatus = 'open' | 'resolved_customer' | 'resolved_merchant' | 'expired'

export type Dispute = {
  readonly id: string
  readonly tenantId: string
  readonly originalTransitionId: string
  readonly status: DisputeStatus
  readonly openedAt: Date
  readonly deadlineAt: Date | null
  readonly resolvedAt: Date | null
  readonly resolution: string | null
  readonly reason: string | null
}

export type OpenDisputeInput = {
  readonly tenantId: string
  readonly originalTransitionId: string
  readonly deadlineAt?: Date
  readonly reason?: string
}

export type ResolveDisputeInput = {
  readonly id: string
  /**
   * `customer` = customer wins (refund issued elsewhere). `merchant` =
   * merchant wins (no-op). The engine doesn't drive the refund
   * transition itself — operators wire that via their declared
   * transitions; this just stamps the dispute closed.
   */
  readonly outcome: 'customer' | 'merchant'
  readonly resolution?: string
}

export type ExpireDisputesResult = {
  readonly expired: readonly string[]
}

export type DisputesOps = {
  open(input: OpenDisputeInput): Promise<Dispute>
  resolve(input: ResolveDisputeInput): Promise<Dispute>
  /** Flip every `open` dispute past its deadline to `expired`. */
  expireDue(now?: Date): Promise<ExpireDisputesResult>
  get(id: string): Promise<Dispute | null>
  list(args: {
    tenantId: string
    status?: DisputeStatus
    limit?: number
  }): Promise<readonly Dispute[]>
}

export function buildDisputesOps(connection: Connection): DisputesOps {
  return {
    async open(input) {
      return connection.asAdmin(async (tx) => {
        const [row] = await tx<Record<string, unknown>[]>`
          insert into "txn_disputes" (
            tenant_id, original_transition_id, status, deadline_at, reason
          ) values (
            ${input.tenantId},
            ${input.originalTransitionId},
            'open',
            ${input.deadlineAt ?? null},
            ${input.reason ?? null}
          )
          returning id, tenant_id, original_transition_id, status,
                    opened_at, deadline_at, resolved_at, resolution, reason
        `
        if (!row) throw new LokiError('Failed to insert txn_disputes row.')
        return mapDispute(row)
      })
    },

    async resolve(input) {
      const newStatus: DisputeStatus =
        input.outcome === 'customer' ? 'resolved_customer' : 'resolved_merchant'
      return connection.asAdmin(async (tx) => {
        const [row] = await tx<Record<string, unknown>[]>`
          update "txn_disputes"
          set status = ${newStatus},
              resolved_at = now(),
              resolution = ${input.resolution ?? null}
          where id = ${input.id} and status = 'open'
          returning id, tenant_id, original_transition_id, status,
                    opened_at, deadline_at, resolved_at, resolution, reason
        `
        if (row) return mapDispute(row)
        const [existing] = await tx<Record<string, unknown>[]>`
          select id, tenant_id, original_transition_id, status,
                 opened_at, deadline_at, resolved_at, resolution, reason
          from "txn_disputes" where id = ${input.id}
        `
        if (!existing) throw new LokiError(`Dispute ${input.id} not found.`)
        return mapDispute(existing)
      })
    },

    async expireDue(now = new Date()) {
      return connection.asAdmin(async (tx) => {
        const rows = await tx<{ id: string }[]>`
          update "txn_disputes"
          set status = 'expired', resolved_at = ${now}
          where status = 'open'
            and deadline_at is not null
            and deadline_at <= ${now}
          returning id
        `
        return { expired: rows.map((r) => r.id) }
      })
    },

    async get(id) {
      return connection.asAdmin(async (tx) => {
        const [row] = await tx<Record<string, unknown>[]>`
          select id, tenant_id, original_transition_id, status,
                 opened_at, deadline_at, resolved_at, resolution, reason
          from "txn_disputes" where id = ${id}
        `
        return row ? mapDispute(row) : null
      })
    },

    async list(args) {
      const limit = Math.min(1000, Math.max(1, args.limit ?? 100))
      return connection.asAdmin(async (tx) => {
        const statusFrag = args.status ? tx`and status = ${args.status}` : tx``
        const rows = await tx<Record<string, unknown>[]>`
          select id, tenant_id, original_transition_id, status,
                 opened_at, deadline_at, resolved_at, resolution, reason
          from "txn_disputes"
          where tenant_id = ${args.tenantId}
            ${statusFrag}
          order by opened_at desc
          limit ${limit}
        `
        return rows.map(mapDispute)
      })
    },
  }
}

function mapDispute(row: Record<string, unknown>): Dispute {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    originalTransitionId: row['original_transition_id'] as string,
    status: row['status'] as DisputeStatus,
    openedAt: row['opened_at'] as Date,
    deadlineAt: (row['deadline_at'] as Date | null) ?? null,
    resolvedAt: (row['resolved_at'] as Date | null) ?? null,
    resolution: (row['resolution'] as string | null) ?? null,
    reason: (row['reason'] as string | null) ?? null,
  }
}
