import { ident, trimSql } from './sql.js'
import type { ResolvedMigrationOptions } from './types.js'

/**
 * Build the index DDL specified in §12.2 of `project.md`. Every hot
 * query path is covered — no sequential scans are emitted by the
 * generated runtime client. Indexes are created in their own
 * statements (rather than inside `CREATE TABLE`) so we can later opt
 * in to `CONCURRENTLY` for live deployments.
 */
export function buildIndexesSql(options: ResolvedMigrationOptions): string[] {
  const t = (name: string) => ident(`${options.tablePrefix}${name}`)
  const ix = (name: string) => ident(`${options.tablePrefix}${name}`)

  const stmts: string[] = []

  // txn_records: list by type/state
  stmts.push(
    `CREATE INDEX ${ix('txn_records_type_state_idx')}
  ON ${t('txn_records')} (
    ${ident('tenant_id')},
    ${ident('type')},
    ${ident('state')},
    ${ident('updated_at')} DESC
  );
`,
  )

  // txn_records: list by creating actor
  stmts.push(
    `CREATE INDEX ${ix('txn_records_creator_idx')}
  ON ${t('txn_records')} (
    ${ident('tenant_id')},
    ${ident('created_by_actor_type')},
    ${ident('created_by_actor_id')},
    ${ident('updated_at')} DESC
  );
`,
  )

  // txn_transitions: trace one record (sorted by ULID)
  stmts.push(
    `CREATE INDEX ${ix('txn_transitions_trace_idx')}
  ON ${t('txn_transitions')} (
    ${ident('tenant_id')},
    ${ident('txn_id')},
    ${ident('id')} ASC
  );
`,
  )

  // txn_transitions: per-actor query
  stmts.push(
    `CREATE INDEX ${ix('txn_transitions_actor_idx')}
  ON ${t('txn_transitions')} (
    ${ident('tenant_id')},
    ${ident('actor_type')},
    ${ident('actor_id')},
    ${ident('occurred_at')} DESC,
    ${ident('id')} DESC
  );
`,
  )

  // postings: account history
  stmts.push(
    `CREATE INDEX ${ix('postings_account_history_idx')}
  ON ${t('postings')} (
    ${ident('tenant_id')},
    ${ident('account_id')},
    ${ident('occurred_at')} DESC,
    ${ident('id')} DESC
  );
`,
  )

  // postings: by transition
  stmts.push(
    `CREATE INDEX ${ix('postings_transition_idx')}
  ON ${t('postings')} (
    ${ident('tenant_id')},
    ${ident('transition_id')}
  );
`,
  )

  // txn_keys: active key lookup (partial)
  stmts.push(
    `CREATE INDEX ${ix('txn_keys_active_idx')}
  ON ${t('txn_keys')} (
    ${ident('tenant_id')},
    ${ident('txn_id')},
    ${ident('name')}
  )
  WHERE ${ident('status')} = 'active';
`,
  )

  // outbox: worker drain (partial — excludes both delivered AND
  // terminally-failed rows so the worker only ever sees actionable
  // events).
  stmts.push(
    `CREATE INDEX ${ix('outbox_drain_idx')}
  ON ${t('outbox')} (
    ${ident('tenant_id')},
    ${ident('next_attempt_at')},
    ${ident('id')}
  )
  WHERE ${ident('delivered_at')} IS NULL AND ${ident('failed_at')} IS NULL;
`,
  )

  // txn_anomalies: dashboards / hook routing
  stmts.push(
    `CREATE INDEX ${ix('txn_anomalies_severity_idx')}
  ON ${t('txn_anomalies')} (
    ${ident('tenant_id')},
    ${ident('severity')},
    ${ident('detected_at')} DESC
  );
`,
  )

  // txn_scheduled: scheduler tick — only `pending` rows are interesting,
  // ordered by run_at so each batch claims the next due window.
  stmts.push(
    `CREATE INDEX ${ix('txn_scheduled_due_idx')}
  ON ${t('txn_scheduled')} (
    ${ident('tenant_id')},
    ${ident('run_at')},
    ${ident('id')}
  )
  WHERE ${ident('status')} = 'pending';
`,
  )

  // Idempotent record creation (§6.2 race-safety): genesis (`_init`)
  // transitions must be unique per (tenant, idempotency_key) so two
  // concurrent `create()` calls converge on the same record. The
  // record-scoped UNIQUE on the table itself is what protects
  // post-genesis transitions, where each record is already known.
  //
  // Skipped in partitioned mode — Postgres requires every unique
  // constraint on a partitioned table to include the partition key
  // (`occurred_at`), and that defeats idempotency (two concurrent
  // `now()` values are practically distinct). Operators running with
  // `partitioning: 'monthly'` should serialise concurrent creates at
  // the application layer or pre-allocate record ids.
  if (options.partitioning !== 'monthly') {
    stmts.push(
      `CREATE UNIQUE INDEX ${ix('txn_transitions_init_idem_idx')}
  ON ${t('txn_transitions')} (${ident('tenant_id')}, ${ident('idempotency_key')})
  WHERE ${ident('name')} = '_init';
`,
    )
  }

  return stmts.map(trimSql)
}

export function buildDropIndexesSql(options: ResolvedMigrationOptions): string[] {
  const ix = (name: string) => ident(`${options.tablePrefix}${name}`)
  // Order is irrelevant for DROP INDEX, but reverse-sorting keeps the
  // generated `down` script stable for snapshot tests.
  return [
    'txn_transitions_init_idem_idx',
    'txn_scheduled_due_idx',
    'txn_anomalies_severity_idx',
    'outbox_drain_idx',
    'txn_keys_active_idx',
    'postings_transition_idx',
    'postings_account_history_idx',
    'txn_transitions_actor_idx',
    'txn_transitions_trace_idx',
    'txn_records_creator_idx',
    'txn_records_type_state_idx',
  ].map((name) => `DROP INDEX IF EXISTS ${ix(name)};\n`)
}
