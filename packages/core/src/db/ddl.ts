import type { ActorDef, SchemaDef, TransactionDef, TransitionDef } from '../schema/types.js'
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

  const stmts: string[] = []
  stmts.push(buildTenantsTable(t))
  stmts.push(buildAccountsTable(schema, t))
  stmts.push(buildTxnRecordsTable(schema, t))
  stmts.push(buildTxnTransitionsTable(schema, t))
  stmts.push(buildTxnKeysTable(schema, t))
  stmts.push(buildPostingsTable(t))
  stmts.push(buildOutboxTable(schema, t))
  stmts.push(buildTxnAnomaliesTable(t))
  return stmts.map(trimSql)
}

/**
 * Build the matching `DROP TABLE` statements in reverse-dependency
 * order. Used by the migration plan's `down` script.
 */
export function buildDropTablesSql(options: ResolvedMigrationOptions): string[] {
  const reversed = [...ENGINE_TABLES].reverse()
  return reversed.map((name) => `DROP TABLE IF EXISTS ${ident(`${options.tablePrefix}${name}`)};\n`)
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

function buildTxnTransitionsTable(schema: SchemaDef, t: TableNamer): string {
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

  const lines: string[] = [
    // ULIDs are 26-char Crockford-Base32 strings — `text` keeps them
    // sortable as strings so reconciliation and the hash chain can rely
    // on `ORDER BY id`.
    `${ident('id')}                  text PRIMARY KEY CHECK (length(${ident('id')}) = 26)`,
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
    `${ident('reverses')}            text REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('occurred_at')}         timestamptz NOT NULL DEFAULT now()`,
  ]
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
  lines.push(`UNIQUE (${ident('tenant_id')}, ${ident('txn_id')}, ${ident('idempotency_key')})`)

  return `CREATE TABLE ${t('txn_transitions')} (
  ${lines.join(',\n  ')}
);
`
}

function buildTxnKeysTable(schema: SchemaDef, t: TableNamer): string {
  const keyNames = Array.from(
    new Set(
      schema.transactions.flatMap((tx) =>
        Object.values(tx.transitions).flatMap((tr: TransitionDef) => [...tr.unlocks]),
      ),
    ),
  )
  const lines: string[] = [
    `${ident('id')}                          uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    `${ident('tenant_id')}                   text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('txn_id')}                      uuid NOT NULL REFERENCES ${t('txn_records')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('name')}                        text NOT NULL`,
    `${ident('granted_by_transition_id')}    text NOT NULL REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('consumed_by_transition_id')}   text REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT`,
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

function buildPostingsTable(t: TableNamer): string {
  return `CREATE TABLE ${t('postings')} (
  ${ident('id')}              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ${ident('tenant_id')}       text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT,
  ${ident('transition_id')}   text NOT NULL REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT,
  ${ident('account_id')}      uuid NOT NULL REFERENCES ${t('accounts')}(${ident('id')}) ON DELETE RESTRICT,
  ${ident('amount')}          numeric(38,0) NOT NULL CHECK (${ident('amount')} >= 0),
  ${ident('direction')}       text NOT NULL CHECK (${ident('direction')} IN ('D', 'C')),
  ${ident('occurred_at')}     timestamptz NOT NULL DEFAULT now()
);
`
}

function buildOutboxTable(schema: SchemaDef, t: TableNamer): string {
  const eventNames = Array.from(
    new Set(
      schema.transactions.flatMap((tx) =>
        Object.values(tx.transitions)
          .map((tr) => tr.emit)
          .filter((e): e is string => typeof e === 'string' && e.length > 0),
      ),
    ),
  )
  const lines: string[] = [
    `${ident('id')}                  uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    `${ident('tenant_id')}           text NOT NULL REFERENCES ${t('tenants')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('txn_id')}              uuid NOT NULL REFERENCES ${t('txn_records')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('transition_id')}       text NOT NULL REFERENCES ${t('txn_transitions')}(${ident('id')}) ON DELETE RESTRICT`,
    `${ident('event')}               text NOT NULL`,
    `${ident('intent')}              text`,
    `${ident('payload')}             jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `${ident('delivered_at')}        timestamptz`,
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
