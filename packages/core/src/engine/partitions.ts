import { ident } from '../db/sql.js'
import type { Connection, SqlTransaction } from './connection.js'
import { LokiError } from './errors.js'

/**
 * Monthly-partition management for `txn_transitions` and `postings`
 * (§12.3). The migrator creates parent tables with `PARTITION BY
 * RANGE (occurred_at)` plus a default partition; concrete monthly
 * partitions are provisioned on demand via `ensureFor`.
 *
 * The default partition is a safety net — it will accept any row, but
 * Postgres can't add new constrained partitions overlapping rows
 * already in `_default`. Operators are expected to call
 * `engine.partitions.ensureFor(date, monthsAhead)` ahead of writes.
 */
export type PartitionTable = 'txn_transitions' | 'postings'

export type EnsuredPartition = {
  readonly table: PartitionTable
  readonly partitionName: string
  readonly fromInclusive: string // YYYY-MM-01
  readonly toExclusive: string
  readonly created: boolean
}

export type EnsureForOptions = {
  /** How many months ahead of the target date to provision. Default 0. */
  readonly monthsAhead?: number
  /** Optional table prefix; defaults to '' (matches `MigrationOptions.tablePrefix`). */
  readonly tablePrefix?: string
}

export type PartitionsOps = {
  /**
   * Create monthly partitions covering `[date, date + monthsAhead]`.
   * Returns one descriptor per (table × month). Idempotent: existing
   * partitions are reported with `created: false`.
   */
  ensureFor(date: Date, options?: EnsureForOptions): Promise<readonly EnsuredPartition[]>
  /**
   * List all monthly partitions currently attached to a parent table.
   */
  list(
    table: PartitionTable,
    options?: { tablePrefix?: string },
  ): Promise<readonly { partitionName: string; bounds: string }[]>
}

// H6: identical regex to db/types.ts SAFE_IDENTIFIER_PREFIX. Empty
// string is allowed (no prefix); otherwise the prefix must be a SQL
// identifier safely composable into a table name.
const SAFE_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*)?$/

function assertSafePrefix(prefix: string): void {
  if (typeof prefix !== 'string' || !SAFE_PREFIX.test(prefix)) {
    throw new LokiError(
      `tablePrefix "${prefix}" must be empty or match [A-Za-z_][A-Za-z0-9_]* (no quotes, spaces, or punctuation).`,
    )
  }
}

export function buildPartitionsOps(connection: Connection): PartitionsOps {
  return {
    async ensureFor(date, opts = {}) {
      const monthsAhead = opts.monthsAhead ?? 0
      const prefix = opts.tablePrefix ?? ''
      assertSafePrefix(prefix)
      const out: EnsuredPartition[] = []
      await connection.asAdmin(async (tx) => {
        for (const table of ['txn_transitions', 'postings'] as const) {
          for (let i = 0; i <= monthsAhead; i++) {
            const target = monthAdded(date, i)
            const partition = await ensurePartition(tx, prefix, table, target)
            out.push(partition)
          }
        }
      })
      return out
    },
    async list(table, options = {}) {
      const prefix = options.tablePrefix ?? ''
      assertSafePrefix(prefix)
      const parent = `${prefix}${table}`
      return await connection.asAdmin(async (tx) => {
        const rows = await tx<{ partition: string; bounds: string }[]>`
          select
            child.relname as partition,
            pg_get_expr(child.relpartbound, child.oid) as bounds
          from pg_inherits
          join pg_class parent on parent.oid = pg_inherits.inhparent
          join pg_class child  on child.oid  = pg_inherits.inhrelid
          where parent.relname = ${parent}
          order by partition
        `
        return rows.map((r) => ({ partitionName: r.partition, bounds: r.bounds }))
      })
    },
  }
}

async function ensurePartition(
  tx: SqlTransaction,
  prefix: string,
  table: PartitionTable,
  target: Date,
): Promise<EnsuredPartition> {
  const year = target.getUTCFullYear()
  const month = target.getUTCMonth() + 1
  const fromInclusive = `${year}-${String(month).padStart(2, '0')}-01`
  const nextMonthDate = monthAdded(target, 1)
  const toExclusive = `${nextMonthDate.getUTCFullYear()}-${String(
    nextMonthDate.getUTCMonth() + 1,
  ).padStart(2, '0')}-01`
  const partitionName = `${prefix}${table}_y${year}m${String(month).padStart(2, '0')}`
  // Create the partition if it doesn't exist. We can't query
  // pg_class directly through the tagged template safely (table name
  // identifiers), so we check for existence via `pg_class`.
  const [exists] = await tx<{ count: string }[]>`
    select count(*)::text as count from pg_class where relname = ${partitionName}
  `
  if (exists && Number(exists.count) > 0) {
    return {
      table,
      partitionName,
      fromInclusive,
      toExclusive,
      created: false,
    }
  }
  // Defense-in-depth: even though `assertSafePrefix` rejects unsafe
  // prefixes at the entry point, we route every identifier through
  // the shared `ident()` helper so this path matches the rest of the
  // DDL surface. `partitionName` is composed from the (already-safe)
  // prefix + a literal table name + a year/month suffix, so it
  // satisfies the same regex by construction.
  const parent = ident(`${prefix}${table}`)
  const child = ident(partitionName)
  const sql = `CREATE TABLE ${child} PARTITION OF ${parent} FOR VALUES FROM ('${fromInclusive}') TO ('${toExclusive}')`
  await tx.unsafe(sql)
  return {
    table,
    partitionName,
    fromInclusive,
    toExclusive,
    created: true,
  }
}

function monthAdded(date: Date, months: number): Date {
  // Always anchor to UTC day-1 so the bounds align cleanly to month
  // boundaries regardless of the host's local timezone.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1))
}
