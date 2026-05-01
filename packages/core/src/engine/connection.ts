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

export type ConnectionInput =
  /** Connection URL — postgres.js parses options from it. */
  | { readonly url: string; readonly options?: postgres.Options<Record<string, never>> }
  /** Bring your own postgres.js client (useful for shared pools). */
  | { readonly sql: SqlClient }

export type Connection = {
  /** The underlying postgres.js client. */
  readonly sql: SqlClient
  /**
   * Run `fn` inside a transaction. The tenant GUC is set with
   * `set_config('loki.tenant_id', tenantId, true)` so RLS policies
   * scope every query.
   */
  withTenant<T>(tenantId: string, fn: (tx: SqlTransaction) => Promise<T>): Promise<T>
  /**
   * Run `fn` inside an admin transaction (no tenant GUC). Used by
   * migrations and engine.admin operations.
   */
  asAdmin<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T>
  /** Close the underlying pool. Idempotent. */
  close(): Promise<void>
}

/** Lazily create or wrap a postgres.js client. */
export function openConnection(input: ConnectionInput): Connection {
  let sql: SqlClient
  let owned: boolean
  if ('sql' in input) {
    sql = input.sql
    owned = false
  } else {
    sql = postgres(input.url, {
      max: 10,
      idle_timeout: 30,
      // postgres.js casts numeric to strings by default; for `bigint`
      // safety we coerce ourselves at read time. Prepared statements
      // are on by default which is what we want.
      ...input.options,
    })
    owned = true
  }

  let closed = false

  return {
    sql,
    async withTenant<T>(tenantId: string, fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      if (closed) throw new DatabaseError('Connection is closed.', null)
      try {
        return (await sql.begin(async (tx) => {
          await tx`select set_config(${TENANT_GUC}, ${tenantId}, true)`
          return fn(tx)
        })) as T
      } catch (e) {
        throw wrap(e)
      }
    },
    async asAdmin<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      if (closed) throw new DatabaseError('Connection is closed.', null)
      try {
        return (await sql.begin(async (tx) => fn(tx))) as T
      } catch (e) {
        throw wrap(e)
      }
    },
    async close() {
      if (closed) return
      closed = true
      if (owned) {
        await sql.end({ timeout: 5 })
      }
    },
  }
}

function wrap(error: unknown): unknown {
  // Pass through our own errors unchanged so the engine layer's typed
  // catches still work (UnknownTransitionError, etc.).
  if (error instanceof LokiError) return error
  return new DatabaseError(error instanceof Error ? error.message : 'Unknown database error', error)
}
