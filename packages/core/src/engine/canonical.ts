/**
 * Canonical JSON serialization used for the §5.1 hash chain.
 *
 * The bytes that go into `row_hash` and `postings_checksum` must be
 * deterministic across processes, languages, and library versions.
 * `JSON.stringify` doesn't qualify — object key order depends on
 * insertion order. This module enforces:
 *
 *   - Object keys sorted lexicographically
 *   - `bigint` rendered as `{ "$bigint": "<digits>" }`
 *   - `Date` rendered as ISO-8601 string with millisecond precision
 *   - `Buffer` / `Uint8Array` rendered as `{ "$bytes": "<hex>" }`
 *   - `undefined` properties dropped (matches stdlib JSON behavior)
 *   - `null` preserved
 *
 * Any other value type (functions, symbols, `Map`, `Set`, etc.) throws.
 * Hash chain inputs must be plain data.
 */

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalizationError'
  }
}

export type CanonicalValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Date
  | Buffer
  | Uint8Array
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined }

/**
 * Produce a deterministic Buffer representing `value`. Two structurally
 * equal inputs always yield byte-identical output.
 */
export function canonicalize(value: CanonicalValue): Buffer {
  return Buffer.from(canonicalizeToString(value), 'utf8')
}

/** Same output as `canonicalize`, returned as a string. */
export function canonicalizeToString(value: CanonicalValue): string {
  return write(value)
}

function write(value: CanonicalValue): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`Non-finite number cannot be canonicalized: ${value}`)
      }
      return Number.isInteger(value) ? value.toString() : value.toString()
    case 'bigint':
      // Wrap so a bigint never collides with a string of the same digits.
      return `{"$bigint":"${value.toString()}"}`
    case 'object':
      return writeObject(value)
    default:
      throw new CanonicalizationError(`Unsupported value type: ${typeof value}`)
  }
}

function writeObject(value: object): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CanonicalizationError('Invalid Date cannot be canonicalized.')
    }
    return JSON.stringify(value.toISOString())
  }

  if (value instanceof Uint8Array) {
    return `{"$bytes":"${Buffer.from(value).toString('hex')}"}`
  }

  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map(write).join(',')}]`
  }

  // Plain object: sort keys, drop undefined.
  const obj = value as Record<string, CanonicalValue | undefined>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined) continue
    parts.push(`${JSON.stringify(k)}:${write(v)}`)
  }
  return `{${parts.join(',')}}`
}
