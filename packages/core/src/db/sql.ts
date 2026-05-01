/**
 * Minimal SQL text helpers for DDL generation.
 *
 * Loki's DDL is built from schema names — every name has already been
 * validated by `validateSchema` against `/^[A-Za-z][A-Za-z0-9_]*$/`, so
 * the surface here is narrow. Each helper validates again as a defense
 * in depth: a malformed identifier or string is a programming error and
 * throws, never silently slips into generated SQL.
 */

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const NUL_CHAR = String.fromCharCode(0)

export class SqlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SqlError'
  }
}

/**
 * Quote a Postgres identifier (table, column, role name). The name must
 * match `[A-Za-z_][A-Za-z0-9_]*`. Anything else is rejected — Loki never
 * needs identifiers with embedded whitespace, dots, or quotes.
 */
export function ident(name: string): string {
  if (typeof name !== 'string' || !SAFE_IDENT.test(name)) {
    throw new SqlError(`Invalid SQL identifier: ${JSON.stringify(name)}`)
  }
  return `"${name}"`
}

/**
 * Quote a string literal for inclusion in DDL (e.g. `CHECK (state IN
 * ('pending'))`). Single quotes are doubled per the Postgres standard;
 * backslash-escapes are *not* used (we never run with
 * `standard_conforming_strings = off`).
 *
 * NUL bytes are rejected up front — Postgres rejects them in `text`
 * values regardless, but a clear error here beats one bubbling up at
 * run time from the server.
 */
export function literalString(value: string): string {
  if (typeof value !== 'string') {
    throw new SqlError(`Expected string literal, got ${typeof value}`)
  }
  if (value.includes(NUL_CHAR)) {
    throw new SqlError('SQL string literals cannot contain NUL bytes.')
  }
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Format a JavaScript value as a Postgres literal: string, number,
 * bigint, boolean, or null. Used inside DDL only — runtime queries
 * always use parameterized statements.
 */
export function literal(value: string | number | bigint | boolean | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SqlError(`Cannot represent ${value} as a SQL literal.`)
    }
    return value.toString()
  }
  if (typeof value === 'bigint') return value.toString()
  return literalString(value)
}

/**
 * Format a list of string values as a SQL `IN (...)` body. Empty lists
 * are formatted as `(NULL)` so an `IN` clause stays syntactically valid
 * but matches nothing.
 */
export function inList(values: readonly string[]): string {
  if (values.length === 0) return '(NULL)'
  return `(${values.map(literalString).join(', ')})`
}

/**
 * Trim trailing whitespace on every line and collapse the trailing
 * newline run. Used to keep generated SQL stable for snapshot tests.
 */
export function trimSql(sql: string): string {
  return `${sql
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')}\n`
}
