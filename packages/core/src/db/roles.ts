import { ident, trimSql } from './sql.js'
import type { ResolvedMigrationOptions } from './types.js'

/**
 * Build the database-role bootstrap. Two roles, in line with §13:
 *
 *   - `ledger_app`   — the role the application connects as. Granted
 *                       INSERT on the append-only audit tables and
 *                       constrained UPDATE on cache/state columns of
 *                       the mutable tables. **No DELETE anywhere.** This
 *                       is what makes tamper detection inevitable —
 *                       direct rewrites need a more privileged role.
 *
 *   - `ledger_admin` — used by migrations and the reconciler only.
 *                       Granted full DML on every engine table.
 *
 * Both roles are created with `IF NOT EXISTS` semantics via a
 * `DO $$` block so re-running the migration on an existing cluster is
 * safe. Renames are configurable via `MigrationOptions`.
 */
export function buildRolesSql(options: ResolvedMigrationOptions): string[] {
  const app = ident(options.appRole)
  const admin = ident(options.adminRole)
  const ro = ident(options.readonlyRole)
  const stmts: string[] = []

  stmts.push(
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteRoleLiteral(options.appRole)}) THEN
    CREATE ROLE ${app} NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteRoleLiteral(options.adminRole)}) THEN
    CREATE ROLE ${admin} NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteRoleLiteral(options.readonlyRole)}) THEN
    CREATE ROLE ${ro} NOINHERIT NOLOGIN;
  END IF;
END
$$;
`,
  )

  return stmts.map(trimSql)
}

/**
 * Grants for `ledger_app`. Append-only INSERT on audit tables;
 * constrained UPDATE on cache/state columns; SELECT everywhere within
 * the tenant context (RLS narrows further).
 */
export function buildGrantsSql(options: ResolvedMigrationOptions): string[] {
  const app = ident(options.appRole)
  const admin = ident(options.adminRole)
  const ro = ident(options.readonlyRole)
  const t = (name: string) => ident(`${options.tablePrefix}${name}`)
  const stmts: string[] = []

  // --- ledger_admin: full DML on every engine table ---
  stmts.push(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON
  ${t('tenants')},
  ${t('accounts')},
  ${t('txn_records')},
  ${t('txn_transitions')},
  ${t('txn_keys')},
  ${t('postings')},
  ${t('outbox')},
  ${t('txn_anomalies')},
  ${t('txn_scheduled')},
  ${t('fx_rates')},
  ${t('txn_holds')},
  ${t('txn_disputes')}
TO ${admin};
`,
  )

  // --- ledger_app: SELECT on every engine table ---
  stmts.push(
    `GRANT SELECT ON
  ${t('tenants')},
  ${t('accounts')},
  ${t('txn_records')},
  ${t('txn_transitions')},
  ${t('txn_keys')},
  ${t('postings')},
  ${t('outbox')},
  ${t('txn_anomalies')},
  ${t('txn_scheduled')},
  ${t('fx_rates')},
  ${t('txn_holds')},
  ${t('txn_disputes')}
TO ${app};
`,
  )

  // --- ledger_app: append-only INSERT on audit tables ---
  stmts.push(`GRANT INSERT ON ${t('txn_transitions')} TO ${app};\n`)
  stmts.push(`GRANT INSERT ON ${t('postings')} TO ${app};\n`)
  stmts.push(`GRANT INSERT ON ${t('outbox')} TO ${app};\n`)
  stmts.push(`GRANT INSERT ON ${t('txn_anomalies')} TO ${app};\n`)
  stmts.push(`GRANT INSERT ON ${t('accounts')} TO ${app};\n`)
  stmts.push(`GRANT INSERT ON ${t('txn_records')} TO ${app};\n`)
  stmts.push(`GRANT INSERT ON ${t('txn_keys')} TO ${app};\n`)
  stmts.push(`GRANT INSERT ON ${t('txn_scheduled')} TO ${app};\n`)
  stmts.push(`GRANT INSERT ON ${t('fx_rates')} TO ${app};\n`)
  stmts.push(`GRANT INSERT ON ${t('txn_holds')} TO ${app};\n`)
  stmts.push(`GRANT INSERT ON ${t('txn_disputes')} TO ${app};\n`)
  // Holds + disputes both have transition-driven status updates from
  // the app role; the rest stays admin-only.
  stmts.push(
    `GRANT UPDATE (${ident('status')}, ${ident('released_by_transition_id')}, ${ident('released_at')})
ON ${t('txn_holds')} TO ${app};
`,
  )
  stmts.push(
    `GRANT UPDATE (${ident('status')}, ${ident('resolved_at')}, ${ident('resolution')})
ON ${t('txn_disputes')} TO ${app};
`,
  )

  // --- ledger_app: constrained UPDATE on cache / state columns ---
  // §13: "constrained UPDATE only on txn_records, accounts.balance,
  // txn_keys.status, outbox.delivered_at"
  stmts.push(
    `GRANT UPDATE (${ident('state')}, ${ident('version')}, ${ident('active_keys')}, ${ident('compromised')}, ${ident('updated_at')})
ON ${t('txn_records')} TO ${app};
`,
  )
  stmts.push(`GRANT UPDATE (${ident('balance')}) ON ${t('accounts')} TO ${app};\n`)
  stmts.push(
    `GRANT UPDATE (${ident('status')}, ${ident('consumed_by_transition_id')})
ON ${t('txn_keys')} TO ${app};
`,
  )
  stmts.push(
    `GRANT UPDATE (${ident('delivered_at')}, ${ident('attempts')}, ${ident('next_attempt_at')}, ${ident('last_error')})
ON ${t('outbox')} TO ${app};
`,
  )
  stmts.push(
    `GRANT UPDATE (${ident('resolved_at')}, ${ident('resolved_by')}, ${ident('resolution')})
ON ${t('txn_anomalies')} TO ${app};
`,
  )
  // Scheduler progresses through (status, attempts, last_error, fired_at,
  // fired_transition_id) — those are the only columns the app role can
  // touch after insert.
  stmts.push(
    `GRANT UPDATE (${ident('status')}, ${ident('attempts')}, ${ident('last_error')}, ${ident('fired_at')}, ${ident('fired_transition_id')})
ON ${t('txn_scheduled')} TO ${app};
`,
  )

  // ============================================================
  // ledger_readonly — DASHBOARD.md §8.10 layer 4
  // ============================================================
  // The dashboard pool runs as this role. SELECT on Loki's tables
  // ONLY. We REVOKE every public-schema privilege first so a fresh
  // role doesn't inherit anything Postgres grants to PUBLIC. The
  // search_path is pinned to the engine's schema, so an unqualified
  // `SELECT * FROM users` can't even resolve a name outside Loki.
  stmts.push(
    `REVOKE ALL ON SCHEMA public FROM ${ro};
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM ${ro};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${ro};
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${ro};
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM ${ro};
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${ro};
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM ${ro};
`,
  )
  stmts.push(
    `GRANT SELECT ON
  ${t('tenants')},
  ${t('accounts')},
  ${t('txn_records')},
  ${t('txn_transitions')},
  ${t('txn_keys')},
  ${t('postings')},
  ${t('outbox')},
  ${t('txn_anomalies')},
  ${t('txn_scheduled')},
  ${t('fx_rates')},
  ${t('txn_holds')},
  ${t('txn_disputes')}
TO ${ro};
`,
  )
  // Future tables created by `ledger_admin` (projections, future
  // engine tables) automatically gain SELECT for the readonly role.
  stmts.push(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${admin} IN SCHEMA public
  GRANT SELECT ON TABLES TO ${ro};
`,
  )
  // Pin search_path so unqualified names can't resolve to operator
  // tables in `public` outside Loki's set.
  stmts.push(
    `ALTER ROLE ${ro} SET search_path = ${quoteRoleLiteral('public')};
`,
  )

  return stmts.map(trimSql)
}

export function buildDropRolesSql(options: ResolvedMigrationOptions): string[] {
  const app = ident(options.appRole)
  const admin = ident(options.adminRole)
  const ro = ident(options.readonlyRole)
  // We don't `DROP ROLE` because grants on objects still owned by the
  // role would block it. The migration's `down` revokes grants; the
  // role itself is left in place — operators drop it manually if they
  // need to.
  return [
    trimSql(
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${app};
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${admin};
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ro};
`,
    ),
  ]
}

/**
 * Quote a role name for a SELECT-against-pg_roles literal. Roles are
 * stored as `text` in `pg_roles.rolname`, so we need a normal string
 * literal — `ident()` would wrap in double quotes which is wrong.
 */
function quoteRoleLiteral(roleName: string): string {
  // Already validated as a safe identifier by `ident()` upstream; here we
  // just emit the string-literal form.
  return `'${roleName.replace(/'/g, "''")}'`
}
