import type {
  ActorDef,
  ProjectionDef,
  SchemaDef,
  TransactionDef,
  TransitionDef,
} from '../schema/types.js'
import { NONE_STATE } from '../schema/types.js'
import { ident, inList, literalString, trimSql } from './sql.js'
import type { ResolvedMigrationOptions } from './types.js'
import { ENGINE_TABLES } from './types.js'

/**
 * Build the `CREATE TABLE` statements for the eight engine tables. The
 * resulting list is ordered so referenced tables come before
 * referencing tables — `tenants` first, then everything that points
 * back to it.
 *
 * Per-schema CHECK constraints enforce that engine columns only ever
 * contain values declared by the schema (actor names, transaction
 * types, state names, transition names, key names, event names). This
 * is defense in depth: even an admin connection that bypasses the
 * application can't insert a row claiming to belong to a non-existent
 * actor type.
 */
export function buildTablesSql(schema: SchemaDef, options: ResolvedMigrationOptions): string[] {
  const t = (name: (typeof ENGINE_TABLES)[number]): string => ident(`${options.tablePrefix}${name}`)
  const partitioned = options.partitioning === 'monthly'

  const stmts: string[] = []
  stmts.push(buildTenantsTable(t))
  stmts.push(buildAccountsTable(schema, t))
  stmts.push(buildTxnRecordsTable(schema, t))
  stmts.push(buildTxnTransitionsTable(schema, t, partitioned))
  if (partitioned) {
    // Default partition catches any row whose occurred_at doesn't fall
    // into a pre-created monthly partition. Operators provision real
    // partitions via `engine.partitions.ensureFor(date)` ahead of time.
    stmts.push(
      `CREATE TABLE ${ident(`${options.tablePrefix}txn_transitions_default`)} PARTITION OF ${t('txn_transitions')} DEFAULT;\n`,
    )
  }
  stmts.push(buildTxnKeysTable(schema, t, partitioned))
  stmts.push(buildPostingsTable(t, partitioned))
  if (partitioned) {
    stmts.push(
      `CREATE TABLE ${ident(`${options.tablePrefix}postings_default`)} PARTITION OF ${t('postings')} DEFAULT;\n`,
    )
  }
  stmts.push(buildOutboxTable(schema, t, partitioned))
  stmts.push(buildTxnAnomaliesTable(t))
  stmts.push(buildTxnScheduledTable(schema, t, partitioned))
  // M16 + M17 — Batches D & E. The three tables are storage-only;
  // their typed APIs (`engine.fx`, `engine.holds`, `engine.disputes`)
  // are added in subsequent batches. Holds + disputes hold an FK to
  // `txn_transitions(id)`; under monthly partitioning that PK becomes
  // composite `(id, occurred_at)` so the single-column FK has to be
  // dropped (mirroring `postings`).
  stmts.push(buildFxRatesTable(t))
  stmts.push(buildTxnHoldsTable(t, partitioned))
  stmts.push(buildTxnDisputesTable(t, partitioned))

  // Materialized projections (§12.9). One table per declared projection.
  for (const projection of schema.projections) {
    stmts.push(buildProjectionTable(projection, options.tablePrefix))
  }
  return stmts.map(trimSql)
}

/**
 * Build the matching `DROP TABLE` statements in reverse-dependency
 * order. Used by the migration plan's `down` script.
 */
export function buildDropTablesSql(
  options: ResolvedMigrationOptions,
  schema?: SchemaDef,
): string[] {
  const reversed = [...ENGINE_TABLES].reverse()
  const out: string[] = []
  // Drop projection tables before engine tables to keep dependency
  // order clean (projections only reference engine tables).
  if (schema) {
    for (const p of schema.projections) {
      out.push(`DROP TABLE IF EXISTS ${ident(`${options.tablePrefix}proj_${p.name}`)};\n`)
    }
  }
  for (const name of reversed) {
    out.push(`DROP TABLE IF EXISTS ${ident(`${options.tablePrefix}${name}`)};\n`)
  }
  return out
}

/**
 * Build a `proj_<name>` table mirroring the projection's column subset
 * from `txn_transitions`. Column types match the source table verbatim.
 */
function buildProjectionTable(projection: ProjectionDef, prefix: string): string {
  const tableName = ident(`${prefix}proj_${projection.name}`)
  const columnLines = projection.columns.map((c) => `${ident(c)} ${PROJECTION_COLUMN_TYPES[c]}`)
  // (tenant_id, actor_id, occurred_at) is the canonical scope key for
  // actor-centric projections — it covers the §12.9 example query
  // shape "this driver's last 30 days".
  const indexCols = ['tenant_id']
  if (projection.columns.includes('actor_id')) indexCols.push('actor_id')
  if (projection.columns.includes('occurred_at')) indexCols.push('occurred_at')
  const indexCommand =
    indexCols.length > 1
      ? `\nCREATE INDEX ${ident(`${prefix}proj_${projection.name}_scope_idx`)} ON ${tableName} (${indexCols.map(ident).join(', ')});\n`
      : ''
  return `CREATE TABLE ${tableName} (
  ${columnLines.join(',\n  ')},
  PRIMARY KEY (${ident('id')})
);${indexCommand}`
}

const PROJECTION_COLUMN_TYPES: Record<string, string> = {
  id: 'text NOT NULL',
  tenant_id: 'text NOT NULL',
  txn_id: 'uuid NOT NULL',
  type: 'text NOT NULL',
  name: 'text NOT NULL',
  from_state: 'text',
  to_state: 'text NOT NULL',
  actor_type: 'text NOT NULL',
  actor_id: 'text NOT NULL',
  occurred_at: 'timestamptz NOT NULL',
  schema_version: 'int NOT NULL',
}

// =============================================================================
// Per-table builders
// =============================================================================

type TableNamer = (name: (typeof ENGINE_TABLES)[number]) => string

function buildTenantsTable(t: TableNamer): string {
  return `CREATE TABLE ${t('tenants')} (
  ${ident('id')}         text PRIMARY KEY,
  ${ident('name')}       text NOT NULL,
  ${ident('mode')}       text NOT NULL CHECK (${ident('mode')} IN ('db', 'schema', 'row')),
  ${ident('state')}      text NOT NULL CHECK (${ident('state')} IN ('active', 'suspended', 'deleted')),
  ${ident('created_at')} timestamptz NOT NULL DEFAULT now()
);
`
}

function buildAccountsTable(schema: SchemaDef, t: TableNamer): string {
  const actorChecks = collectAccountChecks(schema)
  const lines: string[] = [
    `${ident('id')}                  uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    `${ident('tenant_id')}           text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('owner_actor_type')}    text NOT NULL`,
    `${ident('owner_actor_id')}      text NOT NULL`,
    `${ident('name')}                text NOT NULL`,
    `${ident('parent_account_id')}   uuid REFERENCES ${t('accounts')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('shard_index')}         int NOT NULL DEFAULT 0 CHECK (${ident('shard_index')} >= 0)`,
    `${ident('currency')}            text NOT NULL CHECK (length(${ident('currency')}) > 0)`,
    `${ident('balance')}             numeric(38,0) NOT NULL DEFAULT 0`,
    `${ident('created_at')}          timestamptz NOT NULL DEFAULT now()`,
  ]

  if (actorChecks.actorTypes.length > 0) {
    lines.push(`CHECK (${ident('owner_actor_type')} IN ${inList(actorChecks.actorTypes)})`)
  }
  if (actorChecks.byActor.length > 0) {
    lines.push(`CHECK (${actorChecks.byActor.map(formatPerActorCheck).join('\n      OR ')})`)
  }
  // Postings, balance updates, sub-account hierarchies — every account
  // identity is uniquely keyed by (tenant, actor type, actor id, name,
  // currency, shard).
  lines.push(
    `UNIQUE (${ident('tenant_id')}, ${ident('owner_actor_type')}, ${ident('owner_actor_id')}, ${ident('name')}, ${ident('currency')}, ${ident('shard_index')})`,
  )

  return `CREATE TABLE ${t('accounts')} (
  ${lines.join(',\n  ')}
);
`
}

function buildTxnRecordsTable(schema: SchemaDef, t: TableNamer): string {
  const txnTypes = schema.transactions.map((tx) => tx.name)
  const stateChecks = schema.transactions
    .map(
      (tx) =>
        `(${ident('type')} = ${literalString(tx.name)} AND ${ident('state')} IN ${inList([...tx.states])})`,
    )
    .join('\n      OR ')
  const lines: string[] = [
    `${ident('id')}                      uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    `${ident('tenant_id')}               text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('type')}                    text NOT NULL`,
    `${ident('state')}                   text NOT NULL`,
    `${ident('version')}                 int NOT NULL DEFAULT 0`,
    `${ident('active_keys')}             jsonb NOT NULL DEFAULT '[]'::jsonb`,
    `${ident('participants')}            jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `${ident('created_by_actor_type')}   text NOT NULL`,
    `${ident('created_by_actor_id')}     text NOT NULL`,
    `${ident('compromised')}             boolean NOT NULL DEFAULT FALSE`,
    `${ident('schema_version')}          int NOT NULL DEFAULT 1`,
    `${ident('created_at')}              timestamptz NOT NULL DEFAULT now()`,
    `${ident('updated_at')}              timestamptz NOT NULL DEFAULT now()`,
  ]
  if (txnTypes.length > 0) {
    lines.push(`CHECK (${ident('type')} IN ${inList(txnTypes)})`)
  }
  if (stateChecks.length > 0) {
    lines.push(`CHECK (\n         ${stateChecks}\n       )`)
  }

  return `CREATE TABLE ${t('txn_records')} (
  ${lines.join(',\n  ')}
);
`
}

function buildTxnTransitionsTable(schema: SchemaDef, t: TableNamer, partitioned: boolean): string {
  // `_init` is the synthetic genesis transition emitted by `Engine.create()`.
  // Allowing it universally keeps idempotency uniform between record-creation
  // and subsequent transitions, with a single audit trail.
  const transitionChecks = schema.transactions
    .filter((tx) => Object.keys(tx.transitions).length > 0)
    .map((tx) => {
      const names = Object.keys(tx.transitions)
      return `(${ident('type')} = ${literalString(tx.name)} AND ${ident('name')} IN ${inList(names)})`
    })
  const initBranch = `(${ident('name')} = '_init')`
  const allTransitionChecks =
    transitionChecks.length > 0 ? [initBranch, ...transitionChecks].join('\n      OR ') : initBranch

  const fromStateChecks = buildFromStateChecks(schema)
  const toStateChecks = buildToStateChecks(schema)

  // When partitioning is enabled, every PK and UNIQUE constraint must
  // include the partition key (`occurred_at`). FKs to a partitioned
  // table can only reference column sets in such a constraint, so
  // either we propagate `occurred_at` to every referencing table or
  // we drop the FKs. We drop them — integrity at the row level is
  // already enforced by the hash chain + reconciler.
  const idLine = partitioned
    ? `${ident('id')}                  text NOT NULL CHECK (length(${ident('id')}) = 26)`
    : `${ident('id')}                  text PRIMARY KEY CHECK (length(${ident('id')}) = 26)`
  const reversesLine = partitioned
    ? `${ident('reverses')}            text`
    : `${ident('reverses')}            text REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT`

  const lines: string[] = [
    // ULIDs are 26-char Crockford-Base32 strings — `text` keeps them
    // sortable as strings so reconciliation and the hash chain can rely
    // on `ORDER BY id`.
    idLine,
    `${ident('tenant_id')}           text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('txn_id')}              uuid NOT NULL REFERENCES ${t('txn_records')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('type')}                text NOT NULL`,
    `${ident('from_state')}          text`,
    `${ident('to_state')}            text NOT NULL`,
    `${ident('name')}                text NOT NULL`,
    `${ident('schema_version')}      int NOT NULL DEFAULT 1`,
    `${ident('actor_type')}          text NOT NULL`,
    `${ident('actor_id')}            text NOT NULL`,
    `${ident('payload')}             jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `${ident('idempotency_key')}     text NOT NULL`,
    `${ident('trace_id')}            text`,
    `${ident('prev_hash')}           bytea`,
    `${ident('row_hash')}            bytea NOT NULL`,
    `${ident('postings_checksum')}   bytea NOT NULL`,
    reversesLine,
    `${ident('occurred_at')}         timestamptz NOT NULL DEFAULT now()`,
  ]
  if (partitioned) {
    lines.push(`PRIMARY KEY (${ident('id')}, ${ident('occurred_at')})`)
  }
  lines.push(`CHECK (\n         ${allTransitionChecks}\n       )`)
  if (fromStateChecks.length > 0) {
    // `from_state IS NULL` is allowed unconditionally — that's the
    // genesis `_init` transition. The per-type list narrows the rest.
    lines.push(
      `CHECK (\n         ${ident('from_state')} IS NULL\n      OR ${fromStateChecks}\n       )`,
    )
  }
  if (toStateChecks.length > 0) {
    lines.push(`CHECK (\n         ${toStateChecks}\n       )`)
  }
  if (partitioned) {
    lines.push(
      `UNIQUE (${ident('tenant_id')}, ${ident('txn_id')}, ${ident('idempotency_key')}, ${ident('occurred_at')})`,
    )
  } else {
    lines.push(`UNIQUE (${ident('tenant_id')}, ${ident('txn_id')}, ${ident('idempotency_key')})`)
  }

  const partitionClause = partitioned ? `\nPARTITION BY RANGE (${ident('occurred_at')})` : ''
  return `CREATE TABLE ${t('txn_transitions')} (
  ${lines.join(',\n  ')}
)${partitionClause};
`
}

function buildTxnKeysTable(schema: SchemaDef, t: TableNamer, partitioned: boolean): string {
  const keyNames = Array.from(
    new Set(
      schema.transactions.flatMap((tx) =>
        Object.values(tx.transitions).flatMap((tr: TransitionDef) =>
          tr.unlocks.map((spec) => (typeof spec === 'string' ? spec : spec.name)),
        ),
      ),
    ),
  )
  // FKs to a partitioned `txn_transitions(id)` aren't expressible
  // (Postgres requires the partition key in any unique constraint the
  // FK references); drop the FK clauses but keep the columns.
  const grantedByLine = partitioned
    ? `${ident('granted_by_transition_id')}    text NOT NULL`
    : `${ident('granted_by_transition_id')}    text NOT NULL REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT`
  const consumedByLine = partitioned
    ? `${ident('consumed_by_transition_id')}   text`
    : `${ident('consumed_by_transition_id')}   text REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT`
  const lines: string[] = [
    `${ident('id')}                          uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    `${ident('tenant_id')}                   text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('txn_id')}                      uuid NOT NULL REFERENCES ${t('txn_records')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('name')}                        text NOT NULL`,
    grantedByLine,
    consumedByLine,
    `${ident('expires_at')}                  timestamptz`,
    `${ident('status')}                      text NOT NULL CHECK (${ident('status')} IN ('active', 'consumed', 'expired'))`,
  ]
  if (keyNames.length > 0) {
    lines.push(`CHECK (${ident('name')} IN ${inList(keyNames)})`)
  }
  return `CREATE TABLE ${t('txn_keys')} (
  ${lines.join(',\n  ')}
);
`
}

function buildPostingsTable(t: TableNamer, partitioned: boolean): string {
  // Partitioning rules apply both to this table (postings is itself
  // partitioned by occurred_at when enabled) AND to its parent
  // (txn_transitions). The FK to txn_transitions(id) goes away in
  // partitioned mode.
  const idLine = partitioned
    ? `${ident('id')}              uuid NOT NULL DEFAULT gen_random_uuid()`
    : `${ident('id')}              uuid PRIMARY KEY DEFAULT gen_random_uuid()`
  const transitionIdLine = partitioned
    ? `${ident('transition_id')}   text NOT NULL`
    : `${ident('transition_id')}   text NOT NULL REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT`
  const pkLine = partitioned ? `,\n  PRIMARY KEY (${ident('id')}, ${ident('occurred_at')})` : ''
  const partitionClause = partitioned ? `\nPARTITION BY RANGE (${ident('occurred_at')})` : ''
  return `CREATE TABLE ${t('postings')} (
  ${idLine},
  ${ident('tenant_id')}       text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT,
  ${transitionIdLine},
  ${ident('account_id')}      uuid NOT NULL REFERENCES ${t('accounts')}(${ident('id')}) ON DELETE RESTRICT,
  ${ident('amount')}          numeric(38,0) NOT NULL CHECK (${ident('amount')} >= 0),
  ${ident('direction')}       text NOT NULL CHECK (${ident('direction')} IN ('D', 'C')),
  ${ident('occurred_at')}     timestamptz NOT NULL DEFAULT now()${pkLine}
)${partitionClause};
`
}

function buildOutboxTable(schema: SchemaDef, t: TableNamer, partitioned: boolean): string {
  // Both `emit` and `intent` are valid event names: when only one is
  // declared, the engine writes that string to `event` so the row is
  // never NULL. Adapters consult `intent` for routing; webhook fan-out
  // workers consult `event` for filtering.
  const eventNames = Array.from(
    new Set(
      schema.transactions.flatMap((tx) =>
        Object.values(tx.transitions).flatMap((tr) =>
          [tr.emit, tr.intent].filter((e): e is string => typeof e === 'string' && e.length > 0),
        ),
      ),
    ),
  )
  const transitionFkLine = partitioned
    ? `${ident('transition_id')}       text NOT NULL`
    : `${ident('transition_id')}       text NOT NULL REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT`
  const lines: string[] = [
    `${ident('id')}                  uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    `${ident('tenant_id')}           text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('txn_id')}              uuid NOT NULL REFERENCES ${t('txn_records')}(${ident('id')}) ON DELETE RESTRICT`,
    transitionFkLine,
    `${ident('event')}               text NOT NULL`,
    `${ident('intent')}              text`,
    `${ident('payload')}             jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `${ident('delivered_at')}        timestamptz`,
    `${ident('failed_at')}           timestamptz`,
    `${ident('attempts')}            int NOT NULL DEFAULT 0`,
    `${ident('next_attempt_at')}     timestamptz NOT NULL DEFAULT now()`,
    `${ident('last_error')}          text`,
  ]
  if (eventNames.length > 0) {
    lines.push(`CHECK (${ident('event')} IN ${inList(eventNames)})`)
  }
  return `CREATE TABLE ${t('outbox')} (
  ${lines.join(',\n  ')}
);
`
}

function buildTxnScheduledTable(schema: SchemaDef, t: TableNamer, partitioned: boolean): string {
  // The set of valid transition names mirrors what's allowed on
  // `txn_transitions.name` — a CHECK constraint blocks scheduling a
  // run for a transition that no transaction declares.
  const transitionNames = Array.from(
    new Set(
      schema.transactions.flatMap((tx) =>
        Object.keys(tx.transitions).filter((name) => name !== '_init'),
      ),
    ),
  )
  const firedTransitionLine = partitioned
    ? `${ident('fired_transition_id')}   text`
    : `${ident('fired_transition_id')}   text REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT`
  const lines: string[] = [
    `${ident('id')}                    uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    `${ident('tenant_id')}             text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('txn_id')}                uuid NOT NULL REFERENCES ${t('txn_records')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('name')}                  text NOT NULL`,
    `${ident('run_at')}                timestamptz NOT NULL`,
    `${ident('actor_type')}            text NOT NULL`,
    `${ident('actor_id')}              text NOT NULL`,
    `${ident('payload')}               jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `${ident('with_key')}              uuid REFERENCES ${t('txn_keys')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('idempotency_key')}       text NOT NULL`,
    `${ident('status')}                text NOT NULL CHECK (${ident('status')} IN ('pending', 'completed', 'cancelled', 'failed'))`,
    `${ident('attempts')}              int NOT NULL DEFAULT 0`,
    `${ident('last_error')}            text`,
    `${ident('fired_at')}              timestamptz`,
    firedTransitionLine,
    `${ident('created_at')}            timestamptz NOT NULL DEFAULT now()`,
  ]
  if (transitionNames.length > 0) {
    lines.push(`CHECK (${ident('name')} IN ${inList(transitionNames)})`)
  }
  lines.push(`UNIQUE (${ident('tenant_id')}, ${ident('txn_id')}, ${ident('idempotency_key')})`)
  return `CREATE TABLE ${t('txn_scheduled')} (
  ${lines.join(',\n  ')}
);
`
}

function buildTxnAnomaliesTable(t: TableNamer): string {
  return `CREATE TABLE ${t('txn_anomalies')} (
  ${ident('id')}              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ${ident('tenant_id')}       text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT,
  ${ident('detected_at')}     timestamptz NOT NULL DEFAULT now(),
  ${ident('check_name')}      text NOT NULL,
  ${ident('txn_id')}          uuid REFERENCES ${t('txn_records')}(${ident('id')}) ON DELETE RESTRICT,
  ${ident('account_id')}      uuid REFERENCES ${t('accounts')}(${ident('id')}) ON DELETE RESTRICT,
  ${ident('expected')}        jsonb,
  ${ident('observed')}        jsonb,
  ${ident('severity')}        text NOT NULL CHECK (${ident('severity')} IN ('warn', 'error', 'critical')),
  ${ident('resolved_at')}     timestamptz,
  ${ident('resolved_by')}     text,
  ${ident('resolution')}      text
);
`
}

/**
 * Tenant-scoped FX rate time series (M16, Batch D). Each row pins a
 * (base, quote) pair to a specific rate at `fixed_at`. The reconciler
 * reads it to verify rate-pinned cross-currency transitions; runtime
 * helpers `engine.fx.publish/lookup/history` are the typed surface.
 *
 * `numeric(38, 18)` keeps 18 fractional digits — enough for crypto-pair
 * precision (e.g., 1 USD = 0.000023456789 BTC) without overflow on
 * common fiat scales. Higher precision than minor-units posting math
 * because rate × amount happens BEFORE rounding back to integer minor
 * units.
 */
function buildFxRatesTable(t: TableNamer): string {
  return `CREATE TABLE ${t('fx_rates')} (
  ${ident('id')}              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ${ident('tenant_id')}       text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT,
  ${ident('base_currency')}   text NOT NULL,
  ${ident('quote_currency')}  text NOT NULL,
  ${ident('rate')}            numeric(38, 18) NOT NULL CHECK (${ident('rate')} > 0),
  ${ident('fixed_at')}        timestamptz NOT NULL,
  ${ident('expires_at')}      timestamptz,
  ${ident('source')}          text NOT NULL,
  ${ident('created_at')}      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ${ident(`${'fx_rates'}_lookup_idx`)} ON ${t('fx_rates')}
  (${ident('tenant_id')}, ${ident('base_currency')}, ${ident('quote_currency')}, ${ident('fixed_at')} DESC);
`
}

/**
 * First-class holds (M17, Batch E). Reserves funds against a hold
 * account without finalising a money-movement record. `release` is
 * applied via `engine.holds.release(id)`; `expire` is automatic via
 * the scheduler.
 *
 * Under monthly partitioning, `txn_transitions` has a composite PK of
 * `(id, occurred_at)` and a single-column FK back to it can't be
 * created. We drop the FK in that case — integrity is enforced by the
 * helper API + the reconciler.
 */
function buildTxnHoldsTable(t: TableNamer, partitioned: boolean): string {
  const releasedByLine = partitioned
    ? `${ident('released_by_transition_id')}   text`
    : `${ident('released_by_transition_id')}   text REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT`
  return `CREATE TABLE ${t('txn_holds')} (
  ${ident('id')}                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ${ident('tenant_id')}                   text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT,
  ${ident('txn_id')}                      uuid REFERENCES ${t('txn_records')}(${ident('id')}) ON DELETE RESTRICT,
  ${ident('hold_account_id')}             uuid NOT NULL REFERENCES ${t('accounts')}(${ident('id')}) ON DELETE RESTRICT,
  ${ident('amount')}                      numeric(38, 0) NOT NULL CHECK (${ident('amount')} > 0),
  ${ident('status')}                      text NOT NULL CHECK (${ident('status')} IN ('placed', 'released', 'expired', 'captured')),
  ${ident('expires_at')}                  timestamptz,
  ${releasedByLine},
  ${ident('placed_at')}                   timestamptz NOT NULL DEFAULT now(),
  ${ident('released_at')}                 timestamptz
);
CREATE INDEX ${ident(`${'txn_holds'}_tenant_status_idx`)} ON ${t('txn_holds')}
  (${ident('tenant_id')}, ${ident('status')}, ${ident('expires_at')});
`
}

/**
 * First-class disputes (M17, Batch E). A dispute opens against a
 * specific transition and either resolves to the customer (refund) or
 * the merchant (no-op). The scheduler auto-closes deadlines; the
 * resolution is recorded as a follow-up transition by
 * `engine.disputes.resolve`.
 *
 * Under partitioning, the single-column FK to `txn_transitions(id)`
 * is dropped (the parent's PK becomes composite). See `buildTxnHoldsTable`.
 */
function buildTxnDisputesTable(t: TableNamer, partitioned: boolean): string {
  const originalLine = partitioned
    ? `${ident('original_transition_id')}   text NOT NULL`
    : `${ident('original_transition_id')}   text NOT NULL REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT`
  return `CREATE TABLE ${t('txn_disputes')} (
  ${ident('id')}                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ${ident('tenant_id')}                text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT,
  ${originalLine},
  ${ident('status')}                   text NOT NULL CHECK (${ident('status')} IN ('open', 'resolved_customer', 'resolved_merchant', 'expired')),
  ${ident('opened_at')}                timestamptz NOT NULL DEFAULT now(),
  ${ident('deadline_at')}              timestamptz,
  ${ident('resolved_at')}              timestamptz,
  ${ident('resolution')}               text,
  ${ident('reason')}                   text
);
CREATE INDEX ${ident(`${'txn_disputes'}_tenant_status_idx`)} ON ${t('txn_disputes')}
  (${ident('tenant_id')}, ${ident('status')}, ${ident('deadline_at')});
`
}

// =============================================================================
// Helpers — collect schema-derived check pieces
// =============================================================================

function collectAccountChecks(schema: SchemaDef): {
  actorTypes: readonly string[]
  byActor: readonly { actor: string; accounts: readonly string[] }[]
} {
  const byActor: { actor: string; accounts: string[] }[] = []
  for (const actor of schema.actors) {
    const names = Object.keys(actor.accounts)
    if (names.length > 0) {
      byActor.push({ actor: actor.name, accounts: names })
    }
  }
  return {
    actorTypes: byActor.map((a) => a.actor),
    byActor,
  }
}

function formatPerActorCheck(entry: { actor: string; accounts: readonly string[] }): string {
  return `(${ident('owner_actor_type')} = ${literalString(entry.actor)} AND ${ident('name')} IN ${inList([...entry.accounts])})`
}

function buildFromStateChecks(schema: SchemaDef): string {
  const parts: string[] = []
  for (const tx of schema.transactions) {
    const transitions = Object.values(tx.transitions) as TransitionDef[]
    const explicitFroms = new Set<string>()
    let allowsNone = false
    for (const tr of transitions) {
      for (const f of tr.from) {
        if (f === NONE_STATE) {
          allowsNone = true
        } else {
          explicitFroms.add(f)
        }
      }
    }
    const froms = Array.from(explicitFroms)
    const clause = allowsNone ? `${ident('from_state')} IS NULL OR ` : ''
    if (froms.length > 0) {
      parts.push(
        `(${ident('type')} = ${literalString(tx.name)} AND (${clause}${ident('from_state')} IN ${inList(froms)}))`,
      )
    } else if (allowsNone) {
      parts.push(
        `(${ident('type')} = ${literalString(tx.name)} AND ${ident('from_state')} IS NULL)`,
      )
    }
  }
  return parts.join('\n      OR ')
}

function buildToStateChecks(schema: SchemaDef): string {
  const parts: string[] = []
  for (const tx of schema.transactions) {
    // Include `initial` so the synthetic `_init` genesis transition
    // (which writes to_state = initial) satisfies the check.
    const tos = Array.from(
      new Set([
        tx.initial,
        ...(Object.values(tx.transitions) as TransitionDef[]).map((tr) => tr.to),
      ]),
    )
    if (tos.length > 0) {
      parts.push(
        `(${ident('type')} = ${literalString(tx.name)} AND ${ident('to_state')} IN ${inList(tos)})`,
      )
    }
  }
  return parts.join('\n      OR ')
}

// Re-export helpers used by other db modules
export type { ActorDef, TransactionDef }
