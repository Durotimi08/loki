import { AsyncLocalStorage } from 'node:async_hooks'
import postgres from 'postgres'
import { TENANT_GUC } from '../db/rls.js'
import { DatabaseError, LokiError } from './errors.js'

/**
 * Loki always runs through postgres.js. The thin wrapper here adds two
 * conventions:
 *
 *   1. Every per-tenant operation runs inside a `BEGIN…COMMIT` block
 *      with `loki.tenant_id` set via `set_config(..., true)`. RLS
 *      policies refuse any query that doesn't pin a tenant.
 *
 *   2. Admin operations (migrations, tenant CRUD) bypass the GUC and
 *      run as the configured admin role.
 *
 * Application code never touches `postgres.js` directly — `Engine`
 * exposes a small surface that hides connection management and
 * guarantees the GUC is set per request.
 */

export type SqlClient = postgres.Sql
export type SqlTransaction = postgres.TransactionSql<Record<string, unknown>>

/**
 * Per-tx role enforcement (§5.1 third pillar — append-only at the DB).
 *
 * When set, every `withTenant` / `withTenantReplica` tx runs
 * `SET LOCAL ROLE <app>` and every `asAdmin` tx runs
 * `SET LOCAL ROLE <admin>`. This locks application-path writes to the
 * grants on the app role (INSERT-only on history tables, no DELETE).
 *
 * Requirements on the connection-string user:
 *   1. Must be a member of both roles (`GRANT loki_app TO <user>` and
 *      `GRANT loki_admin TO <user>`); the migrator creates the roles.
 *   2. The roles must already exist — run `loki migrate apply` first.
 *
 * Identifier validation is strict: role names must match
 * `[A-Za-z_][A-Za-z0-9_]*` so a misconfigured value can't smuggle DDL.
 */
export type RuntimeRoles = {
  readonly app: string
  readonly admin: string
}

/**
 * Read-your-writes mode (M0, Batch G).
 *
 *   - `'off'` (default) — read-replica reads can lag behind a write
 *      that just committed in the same async context. Matches the
 *      historical behaviour.
 *   - `'auto'` — after every primary write, capture the WAL LSN via
 *      `pg_current_wal_lsn()` in an `AsyncLocalStorage` context. The
 *      next replica read in the same context checks
 *      `pg_last_wal_replay_lsn()` and routes to the primary instead
 *      whenever the replica hasn't caught up. The check is one extra
 *      round-trip per replica read, no waiting.
 */
export type ReadYourWritesMode = 'auto' | 'off'

export type ConnectionInput =
  /** Connection URL — postgres.js parses options from it. */
  | {
      readonly url: string
      readonly options?: postgres.Options<Record<string, never>>
      /** Optional read-replica URL. Read-only ops (findMany, trace, balance, …) are routed here. */
      readonly readUrl?: string
      readonly readOptions?: postgres.Options<Record<string, never>>
      readonly runtimeRoles?: RuntimeRoles
      readonly readYourWrites?: ReadYourWritesMode
    }
  /** Bring your own postgres.js client (useful for shared pools). */
  | {
      readonly sql: SqlClient
      readonly readSql?: SqlClient
      readonly runtimeRoles?: RuntimeRoles
      readonly readYourWrites?: ReadYourWritesMode
    }

export type Connection = {
  /** The underlying postgres.js client (primary, accepts writes). */
  readonly sql: SqlClient
  /**
   * The configured read-replica client, or `null` when none was
   * supplied. Exposed for cases that need to hit the replica
   * directly without going through `withTenantReplica` — most
   * notably the health probe, which must NOT consult the LSN
   * tracking (otherwise an in-flight write masks real replica lag).
   * Application code should normally use `withTenantReplica` instead.
   */
  readonly readSql: SqlClient | null
  /** Whether a read-replica was configured. */
  readonly hasReplica: boolean
  /**
   * Run `fn` inside a transaction. The tenant GUC is set with
   * `set_config('loki.tenant_id', tenantId, true)` so RLS policies
   * scope every query.
   */
  withTenant<T>(tenantId: string, fn: (tx: SqlTransaction) => Promise<T>): Promise<T>
  /**
   * Same as `withTenant` but routes through the read replica when one
   * is configured. Falls back to the primary otherwise. Use for
   * findMany / trace / balance / verify — anything that doesn't write.
   */
  withTenantReplica<T>(tenantId: string, fn: (tx: SqlTransaction) => Promise<T>): Promise<T>
  /**
   * Run `fn` inside an admin transaction (no tenant GUC). Used by
   * migrations and engine.admin operations.
   */
  asAdmin<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T>
  /** Close the underlying pool. Idempotent. */
  close(): Promise<void>
}

/**
 * Pool defaults Loki applies on every owned `postgres()` instance.
 * Operators override per-deployment via `ConnectionInput.options`
 * / `readOptions`.
 *
 *   - `max: 10` — sized for unit tests + small workloads. **Production
 *     write traffic should raise this.** A reasonable starting point is
 *     `(P95 concurrent transitions) × 1.5`, capped by Postgres
 *     `max_connections` divided by your replica count. 25–50 is the
 *     normal range for a single-engine API box; 100+ for high-traffic
 *     workers. Match read-replica pool size to fan-out.
 *   - `idle_timeout: 30` (seconds) — recycle idle conns so a
 *     transient backend restart doesn't blackhole the pool.
 *   - `connect_timeout: 10` — fail fast on cold-start so PaaS
 *     liveness probes flag the issue instead of hanging the request.
 *   - `connection.statement_timeout: '30s'` — server-side ceiling on
 *     any single query. The engine writes everything inside short
 *     transactions; a 30s upper bound is generous and rules out the
 *     "runaway query holds a connection forever" failure mode.
 *     Override on a per-tenant basis with `SET LOCAL statement_timeout
 *     = '60s'` inside a `withTenant` callback if you really need it.
 *
 * Postgres.js casts numeric to strings by default; for `bigint`
 * safety we coerce ourselves at read time. Prepared statements are on
 * by default which is what we want.
 */
export const DEFAULT_POOL_OPTIONS = Object.freeze({
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  // postgres.js types `statement_timeout` as a number of ms.
  // 30_000 = 30 seconds.
  connection: { statement_timeout: 30_000 },
})

/** Lazily create or wrap a postgres.js client. */
export function openConnection(input: ConnectionInput): Connection {
  let sql: SqlClient
  let readSql: SqlClient | null
  let owned: boolean
  let readOwned: boolean
  if ('sql' in input) {
    sql = input.sql
    readSql = input.readSql ?? null
    owned = false
    readOwned = false
  } else {
    sql = postgres(input.url, mergePoolOptions(DEFAULT_POOL_OPTIONS, input.options))
    owned = true
    if (input.readUrl) {
      readSql = postgres(input.readUrl, mergePoolOptions(DEFAULT_POOL_OPTIONS, input.readOptions))
      readOwned = true
    } else {
      readSql = null
      readOwned = false
    }
  }

  let closed = false

  // Read-your-writes (Batch G). Per async context (typically a single
  // request), track the highest WAL LSN observed at the end of any
  // primary write tx. Subsequent replica reads check the replica's
  // `pg_last_wal_replay_lsn()` against this stored mark; if behind,
  // fall back to the primary so the read sees the just-written data.
  // The whole machinery is no-op when `readYourWrites !== 'auto'` or
  // when no replica is configured.
  const ryw: ReadYourWritesMode = input.readYourWrites ?? 'off'
  const lsnStore = new AsyncLocalStorage<{ lsn: string | null }>()
  const updateLsn = (next: string | null): void => {
    if (!next) return
    const ctx = lsnStore.getStore()
    if (!ctx) return
    if (!ctx.lsn || compareLsn(next, ctx.lsn) > 0) ctx.lsn = next
  }
  const captureLsnAfterWrite = async (tx: SqlTransaction): Promise<void> => {
    if (ryw !== 'auto' || readSql === null) return
    try {
      const [row] = await tx<{ lsn: string }[]>`select pg_current_wal_lsn()::text as lsn`
      if (row?.lsn) updateLsn(row.lsn)
    } catch {
      // Some Postgres builds (e.g. recovery mode) reject the call —
      // silently skip rather than fail every write.
    }
  }
  const replicaCaughtUp = async (replica: SqlClient, target: string): Promise<boolean> => {
    try {
      const [row] = await replica<{ lsn: string | null }[]>`
        select pg_last_wal_replay_lsn()::text as lsn
      `
      if (!row?.lsn) return false
      return compareLsn(row.lsn, target) >= 0
    } catch {
      // Probe failure → conservative: route to primary.
      return false
    }
  }

  // Runtime role plumbing (§5.1). Validate names eagerly so a bad
  // value fails on Connection construction, not on every query.
  const roles = input.runtimeRoles ?? null
  if (roles) {
    if (!isSafeIdentifier(roles.app)) {
      throw new LokiError(`runtimeRoles.app "${roles.app}" must match [A-Za-z_][A-Za-z0-9_]*.`)
    }
    if (!isSafeIdentifier(roles.admin)) {
      throw new LokiError(`runtimeRoles.admin "${roles.admin}" must match [A-Za-z_][A-Za-z0-9_]*.`)
    }
  }

  const runOn = async <T>(
    pool: SqlClient,
    tenantId: string,
    fn: (tx: SqlTransaction) => Promise<T>,
    capturePrimaryLsn = false,
  ): Promise<T> => {
    if (closed) throw new DatabaseError('Connection is closed.', null)
    // H5: reject empty / non-string tenant ids before opening a tx.
    // An empty `loki.tenant_id` GUC silently makes RLS policies match
    // nothing — but combined with a buggy caller that *also* skips
    // RLS-aware queries, that's a leak vector. Refusing here is cheap.
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new LokiError('withTenant: tenantId must be a non-empty string.')
    }
    try {
      return (await pool.begin(async (tx) => {
        if (roles) {
          // SET LOCAL is reverted at COMMIT/ROLLBACK — the underlying
          // pool connection returns to its base role for the next tx.
          await tx.unsafe(`SET LOCAL ROLE "${roles.app}"`)
        }
        await tx`select set_config(${TENANT_GUC}, ${tenantId}, true)`
        const result = await fn(tx)
        if (capturePrimaryLsn) await captureLsnAfterWrite(tx)
        return result
      })) as T
    } catch (e) {
      throw wrap(e)
    }
  }

  /**
   * Resolve which pool a replica-eligible read should use. With
   * `readYourWrites: 'auto'` and a tracked LSN in the current async
   * context, we probe the replica's `pg_last_wal_replay_lsn()`; if it
   * hasn't reached the captured write LSN, the read goes to the
   * primary. Otherwise → replica. Without a replica configured this
   * is a no-op (returns the primary).
   */
  const pickReplicaPool = async (): Promise<SqlClient> => {
    if (!readSql) return sql
    if (ryw !== 'auto') return readSql
    const ctx = lsnStore.getStore()
    if (!ctx?.lsn) return readSql
    const caughtUp = await replicaCaughtUp(readSql, ctx.lsn)
    return caughtUp ? readSql : sql
  }

  // Hoist a shim that opens an LSN-tracking context the very first time
  // a writeable tx fires inside an outer async chain. Read APIs check
  // the same store for a captured LSN.
  const ensureLsnContext = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (ryw !== 'auto' || readSql === null) return fn()
    const existing = lsnStore.getStore()
    if (existing) return fn()
    return lsnStore.run({ lsn: null }, fn)
  }

  return {
    sql,
    readSql,
    hasReplica: readSql !== null,
    async withTenant<T>(tenantId: string, fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      return ensureLsnContext(() => runOn(sql, tenantId, fn, true))
    },
    async withTenantReplica<T>(
      tenantId: string,
      fn: (tx: SqlTransaction) => Promise<T>,
    ): Promise<T> {
      // Read paths route to the replica when one is configured. Writes
      // always hit primary — there is no fallback for the write path
      // because that would silently break read-after-write semantics.
      // Under `readYourWrites: 'auto'`, replica reads that would
      // observe stale state fall back to primary instead.
      return ensureLsnContext(async () => {
        const pool = await pickReplicaPool()
        return runOn(pool, tenantId, fn)
      })
    },
    async asAdmin<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      if (closed) throw new DatabaseError('Connection is closed.', null)
      try {
        return (await sql.begin(async (tx) => {
          if (roles) await tx.unsafe(`SET LOCAL ROLE "${roles.admin}"`)
          const result = await fn(tx)
          if (ryw === 'auto' && readSql !== null) await captureLsnAfterWrite(tx)
          return result
        })) as T
      } catch (e) {
        throw wrap(e)
      }
    },
    async close() {
      if (closed) return
      closed = true
      if (owned) await sql.end({ timeout: 5 })
      if (readOwned && readSql) await readSql.end({ timeout: 5 })
    },
  }
}

/**
 * Merge caller-supplied postgres.js options on top of Loki defaults
 * with one wrinkle: the nested `connection: { statement_timeout: ... }`
 * GUC bag is shallow-merged so a caller who sets, say,
 * `connection: { application_name: 'svc-1' }` doesn't accidentally
 * drop the engine's `statement_timeout` ceiling.
 */
function mergePoolOptions(
  defaults: typeof DEFAULT_POOL_OPTIONS,
  overrides: postgres.Options<Record<string, never>> | undefined,
): postgres.Options<Record<string, never>> {
  if (!overrides) return defaults as postgres.Options<Record<string, never>>
  const overrideConnection = (overrides as { connection?: Record<string, unknown> }).connection
  return {
    ...defaults,
    ...overrides,
    connection: {
      ...defaults.connection,
      ...(overrideConnection ?? {}),
    },
  } as postgres.Options<Record<string, never>>
}

/**
 * Compare two Postgres WAL LSN strings (e.g. `0/1A2B3C4D`). Returns
 * `<0` if `a < b`, `0` if equal, `>0` if `a > b`. The two halves are
 * 8-digit hex numbers; comparison is hex-numeric on each. Exported
 * for unit tests; the runtime users are inside this file.
 */
export function compareLsn(a: string, b: string): number {
  const [aHi, aLo] = a.split('/')
  const [bHi, bLo] = b.split('/')
  const aHiN = Number.parseInt(aHi ?? '0', 16)
  const bHiN = Number.parseInt(bHi ?? '0', 16)
  if (aHiN !== bHiN) return aHiN - bHiN
  const aLoN = Number.parseInt(aLo ?? '0', 16)
  const bLoN = Number.parseInt(bLo ?? '0', 16)
  return aLoN - bLoN
}

/**
 * Wrap a `Connection` so every per-tenant tx scopes its `search_path`
 * to a tenant schema (§7.2 schema-per-tenant). The wrapped connection
 * shares the underlying `sql` pool and `close` is a no-op (the caller
 * still owns the original).
 *
 * Identifier validation is strict — schema names must match
 * `[a-z][a-z0-9_]{0,62}` so a malicious tenant id can't smuggle SQL.
 */
export function withSearchPath(base: Connection, schemaName: string): Connection {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
    throw new LokiError(
      `Invalid schema name "${schemaName}". Use lowercase letters, digits, underscores; max 63 chars.`,
    )
  }
  const setSearchPath = async (tx: SqlTransaction): Promise<void> => {
    // tx.unsafe + an identifier is the safe path; postgres.js doesn't
    // parameterize identifiers in tagged templates, but we've already
    // checked the input above.
    await tx.unsafe(`SET LOCAL search_path = "${schemaName}", public`)
  }
  return {
    sql: base.sql,
    readSql: base.readSql,
    hasReplica: base.hasReplica,
    async withTenant(tenantId, fn) {
      return base.withTenant(tenantId, async (tx) => {
        await setSearchPath(tx)
        return fn(tx)
      })
    },
    async withTenantReplica(tenantId, fn) {
      return base.withTenantReplica(tenantId, async (tx) => {
        await setSearchPath(tx)
        return fn(tx)
      })
    },
    async asAdmin(fn) {
      return base.asAdmin(async (tx) => {
        await setSearchPath(tx)
        return fn(tx)
      })
    },
    async close() {
      // Caller still owns the base connection; do nothing.
    },
  }
}

function isSafeIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

function wrap(error: unknown): unknown {
  // Pass through our own errors unchanged so the engine layer's typed
  // catches still work (UnknownTransitionError, etc.).
  if (error instanceof LokiError) return error
  return new DatabaseError(error instanceof Error ? error.message : 'Unknown database error', error)
}
