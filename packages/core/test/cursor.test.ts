import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from '../src/index.js'

describe('encodeCursor / decodeCursor — keyset cursor', () => {
  it('round-trips an (occurredAt, id) pair', () => {
    const ts = new Date('2026-04-01T12:34:56.789Z')
    const id = '01HZX8RR9YN1234567890ABCDE'
    const cursor = encodeCursor(ts, id)
    expect(typeof cursor).toBe('string')
    const decoded = decodeCursor(cursor)
    expect(decoded.occurredAt.toISOString()).toBe(ts.toISOString())
    expect(decoded.id).toBe(id)
  })

  it('rejects an invalid Date', () => {
    expect(() => encodeCursor(new Date('definitely-not-a-date'), 'x')).toThrow(/invalid Date/i)
  })

  it('rejects a malformed cursor blob', () => {
    expect(() => decodeCursor('not-base64url')).toThrow(/Invalid cursor/)
    // Valid base64url, invalid JSON
    const bogus = Buffer.from('garbage', 'utf8').toString('base64url')
    expect(() => decodeCursor(bogus)).toThrow(/Invalid cursor/)
  })

  it('rejects a wrong-shape payload', () => {
    const bogus = Buffer.from(JSON.stringify({ a: 1 }), 'utf8').toString('base64url')
    expect(() => decodeCursor(bogus)).toThrow(/expected a \[iso, id\] tuple/)
  })

  it('rejects a bad timestamp inside the payload', () => {
    const bogus = Buffer.from(JSON.stringify(['not-a-date', 'id']), 'utf8').toString('base64url')
    expect(() => decodeCursor(bogus)).toThrow(/bad timestamp/)
  })
})
