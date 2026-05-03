/**
 * H2 — HMAC sign / verify helpers. Pure unit test, no DB.
 */
import { describe, expect, it } from 'vitest'
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signOutboxPayload,
  verifyInboundSignature,
} from '../src/index.js'

const SECRET = 'whsec_super_secret_value'
const BODY = JSON.stringify({ event: 'delivery.paid', amount: 1500 })

describe('signOutboxPayload', () => {
  it('returns headers with the expected shape', () => {
    const h = signOutboxPayload(SECRET, BODY)
    expect(h[SIGNATURE_HEADER]).toMatch(/^v1=[0-9a-f]+$/)
    expect(h[TIMESTAMP_HEADER]).toMatch(/^\d+$/)
    expect(h['content-type']).toBe('application/json')
  })

  it('produces deterministic output for the same body, secret, and timestamp', () => {
    const now = new Date('2026-05-03T08:00:00Z')
    const a = signOutboxPayload(SECRET, BODY, { now })
    const b = signOutboxPayload(SECRET, BODY, { now })
    expect(a).toEqual(b)
  })

  it('rejects an empty secret', () => {
    expect(() => signOutboxPayload('', BODY)).toThrow(/non-empty/)
  })
})

describe('verifyInboundSignature', () => {
  it('accepts a fresh signature signed with the same secret', () => {
    const headers = signOutboxPayload(SECRET, BODY)
    expect(() => verifyInboundSignature(SECRET, headers, BODY)).not.toThrow()
  })

  it('is case-insensitive on header names', () => {
    const h = signOutboxPayload(SECRET, BODY)
    const upper = {
      [SIGNATURE_HEADER.toUpperCase()]: h[SIGNATURE_HEADER],
      [TIMESTAMP_HEADER.toUpperCase()]: h[TIMESTAMP_HEADER],
      'Content-Type': 'application/json',
    }
    expect(() => verifyInboundSignature(SECRET, upper, BODY)).not.toThrow()
  })

  it('rejects a mismatched secret', () => {
    const headers = signOutboxPayload(SECRET, BODY)
    expect(() => verifyInboundSignature('other_secret', headers, BODY)).toThrow(/Invalid signature/)
  })

  it('rejects a tampered body', () => {
    const headers = signOutboxPayload(SECRET, BODY)
    const tampered = `${BODY.slice(0, -1)} ` // tweak one char
    expect(() => verifyInboundSignature(SECRET, headers, tampered)).toThrow(/Invalid signature/)
  })

  it('rejects a missing signature header', () => {
    expect(() =>
      verifyInboundSignature(SECRET, { [TIMESTAMP_HEADER]: '1700000000' }, BODY),
    ).toThrow(/Invalid signature/)
  })

  it('rejects a missing timestamp header', () => {
    expect(() =>
      verifyInboundSignature(SECRET, { [SIGNATURE_HEADER]: 'v1=deadbeef' }, BODY),
    ).toThrow(/Invalid signature/)
  })

  it('rejects a stale timestamp (replay attack)', () => {
    const past = new Date('2026-05-03T08:00:00Z')
    const headers = signOutboxPayload(SECRET, BODY, { now: past })
    const future = new Date('2026-05-03T09:00:00Z') // 1 hour later
    expect(() =>
      verifyInboundSignature(SECRET, headers, BODY, {
        toleranceSeconds: 300,
        now: future,
      }),
    ).toThrow(/Invalid signature/)
  })

  it('honours a custom tolerance', () => {
    const past = new Date('2026-05-03T08:00:00Z')
    const headers = signOutboxPayload(SECRET, BODY, { now: past })
    const slightlyLater = new Date('2026-05-03T08:10:00Z') // 600s later
    // Default tolerance is 300s — would fail.
    expect(() => verifyInboundSignature(SECRET, headers, BODY, { now: slightlyLater })).toThrow(
      /Invalid signature/,
    )
    // Bumped tolerance accepts.
    expect(() =>
      verifyInboundSignature(SECRET, headers, BODY, {
        toleranceSeconds: 1000,
        now: slightlyLater,
      }),
    ).not.toThrow()
  })

  it('rejects an unknown signature version', () => {
    const headers = {
      [TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
      [SIGNATURE_HEADER]: 'v9=deadbeef',
    }
    expect(() => verifyInboundSignature(SECRET, headers, BODY)).toThrow(/Invalid signature/)
  })

  it('rejects a non-hex signature value', () => {
    const headers = {
      [TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
      [SIGNATURE_HEADER]: 'v1=NOT_HEX!!',
    }
    expect(() => verifyInboundSignature(SECRET, headers, BODY)).toThrow(/Invalid signature/)
  })
})
