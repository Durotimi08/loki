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

  // outbox: worker drain (partial)
  stmts.push(
    `CREATE INDEX ${ix('outbox_drain_idx')}
  ON ${t('outbox')} (
    ${ident('tenant_id')},
    ${ident('next_attempt_at')},
    ${ident('id')}
  )
  WHERE ${ident('delivered_at')} IS NULL;
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

  return stmts.map(trimSql)
}

export function buildDropIndexesSql(options: ResolvedMigrationOptions): string[] {
  const ix = (name: string) => ident(`${options.tablePrefix}${name}`)
  // Order is irrelevant for DROP INDEX, but reverse-sorting keeps the
  // generated `down` script stable for snapshot tests.
  return [
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
