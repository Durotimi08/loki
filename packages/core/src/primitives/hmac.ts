import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * HMAC sign / verify helpers for outbox delivery.
 *
 * The library is not a webhook framework — `engine.outbox` ships rows
 * and a worker; what the consumer does with them (HTTP, queues,
 * adapters) is their code. But cryptographic signing is easy to get
 * wrong (forgetting timing-safe compare, missing replay protection),
 * so we ship the primitives. Use them from your worker handler:
 *
 *   const headers = signOutboxPayload(secret, event)
 *   await fetch(url, { headers, body: JSON.stringify(event) })
 *
 *   // server side
 *   verifyInboundSignature(secret, headers, await req.text())
 *
 * Algorithm: HMAC-SHA-256 over `<timestamp>.<body>`. The timestamp is
 * embedded in `loki-timestamp`; the signature is `loki-signature: v1=<hex>`.
 * Versioning the prefix (`v1`) lets us rotate the construction
 * without breaking deployed consumers.
 */

export const SIGNATURE_HEADER = 'loki-signature'
export const TIMESTAMP_HEADER = 'loki-timestamp'

export type SignedHeaders = {
  readonly [SIGNATURE_HEADER]: string
  readonly [TIMESTAMP_HEADER]: string
  readonly 'content-type': 'application/json'
}

/**
 * Sign an outbox payload (or any string body) with HMAC-SHA-256. The
 * caller is responsible for serialising `body` deterministically —
 * pass the exact string you'll send over the wire so the verifier
 * sees the same bytes.
 */
export function signOutboxPayload(
  secret: string,
  body: string,
  options: { readonly now?: Date } = {},
): SignedHeaders {
  if (!secret) throw new Error('signOutboxPayload: secret must be a non-empty string.')
  const timestamp = String(Math.floor((options.now ?? new Date()).getTime() / 1000))
  const signature = computeSignature(secret, timestamp, body)
  return {
    [SIGNATURE_HEADER]: `v1=${signature}`,
    [TIMESTAMP_HEADER]: timestamp,
    'content-type': 'application/json',
  }
}

export type VerifyOptions = {
  /** Maximum age of the timestamp in seconds. Default 300 (5 min). */
  readonly toleranceSeconds?: number
  /** Override the verifier's "now" — tests only. */
  readonly now?: Date
}

/**
 * Verify an inbound webhook signature. Returns nothing on success,
 * throws on any failure: missing headers, malformed signature,
 * timestamp out of tolerance window, or HMAC mismatch.
 *
 * The error messages are intentionally non-specific to avoid leaking
 * which check failed (defense against signature oracles).
 */
export function verifyInboundSignature(
  secret: string,
  headers: Record<string, string | undefined>,
  body: string,
  options: VerifyOptions = {},
): void {
  if (!secret) throw new Error('verifyInboundSignature: secret must be a non-empty string.')
  const tolerance = options.toleranceSeconds ?? 300
  const timestamp = pickHeader(headers, TIMESTAMP_HEADER)
  const signatureHeader = pickHeader(headers, SIGNATURE_HEADER)
  if (!timestamp || !signatureHeader) {
    throw new Error('Invalid signature.')
  }

  const ts = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(ts) || ts <= 0) {
    throw new Error('Invalid signature.')
  }
  const nowSec = Math.floor((options.now ?? new Date()).getTime() / 1000)
  if (Math.abs(nowSec - ts) > tolerance) {
    throw new Error('Invalid signature.')
  }

  // Header format: `v1=<hex>` (only v1 is shipped; future versions
  // can be added with explicit fallthrough).
  const match = /^v1=([0-9a-fA-F]+)$/.exec(signatureHeader)
  if (!match) throw new Error('Invalid signature.')
  const presented = Buffer.from(match[1] as string, 'hex')

  const expected = Buffer.from(computeSignature(secret, timestamp, body), 'hex')
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new Error('Invalid signature.')
  }
}

function computeSignature(secret: string, timestamp: string, body: string): string {
  const h = createHmac('sha256', secret)
  // Bind timestamp + body together so a captured signature can't be
  // replayed against a substituted body (Stripe's exact construction).
  h.update(`${timestamp}.${body}`)
  return h.digest('hex')
}

function pickHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  // Header lookup is case-insensitive per RFC 7230; consumers may pass
  // either form. Normalise once.
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k]
  }
  return undefined
}
