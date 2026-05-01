/**
 * Keyset-pagination cursors. The cursor encodes the last seen
 * `(occurred_at, id)` tuple as base64url-wrapped JSON. Stable across
 * page navigation, opaque to clients, and trivially decodable for
 * tests.
 *
 * Loki never emits `OFFSET`-paginated queries — the spec's §11.7 hard
 * rule. Every paginated read uses keyset cursors.
 */

export type Cursor = {
  readonly occurredAt: Date
  readonly id: string
}

const ENCODING = 'base64url' as const

export function encodeCursor(occurredAt: Date, id: string): string {
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error('Cannot encode an invalid Date as a cursor.')
  }
  const payload = JSON.stringify([occurredAt.toISOString(), id])
  return Buffer.from(payload, 'utf8').toString(ENCODING)
}

export function decodeCursor(cursor: string): Cursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, ENCODING).toString('utf8'))
  } catch (e) {
    throw new Error(`Invalid cursor: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new Error('Invalid cursor — expected a [iso, id] tuple.')
  }
  const [iso, id] = parsed as [unknown, unknown]
  if (typeof iso !== 'string' || typeof id !== 'string') {
    throw new Error('Invalid cursor — payload type mismatch.')
  }
  const occurredAt = new Date(iso)
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error('Invalid cursor — bad timestamp.')
  }
  return { occurredAt, id }
}

export type Order = 'asc' | 'desc'

export type Page<T> = {
  readonly items: readonly T[]
  /** `null` when there's no next page. Pass back as `cursor` to fetch the next slice. */
  readonly nextCursor: string | null
}
