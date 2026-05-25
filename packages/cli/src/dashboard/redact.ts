/**
 * Payload redaction — DASHBOARD.md §8.9, §8.12.
 *
 * Every payload the dashboard surfaces (transition payloads, outbox
 * event payloads, anomaly expected/observed) is funnelled through a
 * `Redactor` callback. The dashboard runs `engine.decryptPayload`
 * first (if `payloadCrypto` is wired), then the redactor — so the
 * redactor sees plaintext.
 *
 * Default behaviour:
 *   - dev-mode: identity (operator has access to the dev DB anyway)
 *   - prod-mode: replace every leaf with `<redacted>` except keys in
 *     `SAFE_KEYS`. `idempotencyKey` and PSP reference fields are
 *     surfaced as `sha256(value)[0..16]` so support staff can still
 *     match a row to an external system without seeing the literal.
 *   - long strings truncated to 1 KB (DoS-via-display defence).
 *
 * Encrypted envelopes (decryption failed) bubble through as
 * `{ $encrypted: true, alg: ... }` — ciphertext never leaves the DB.
 */
import { createHash } from 'node:crypto'

export type RedactCtx =
  | {
      readonly kind: 'transition'
      readonly tenantId: string
      readonly txnType: string
      readonly transitionName: string
    }
  | { readonly kind: 'outbox'; readonly tenantId: string; readonly topic: string }
  | { readonly kind: 'anomaly'; readonly tenantId: string; readonly check: string }

export type Redactor = (payload: unknown, ctx: RedactCtx) => unknown

const SAFE_KEYS: ReadonlySet<string> = new Set([
  'amount',
  'amount_minor',
  'currency',
  'state',
  'by',
  'terminal',
  'reason',
  'driverShare',
  'companyShare',
  'companyId',
  'driverId',
  'userId',
  'direction',
])

const HASHED_KEYS: ReadonlySet<string> = new Set([
  'idempotencyKey',
  'idempotency_key',
  'psp_reference',
  'pspReference',
  'pspId',
])

const MAX_STRING_LEN = 1024
const REDACTED = '<redacted>'

/** No-op redactor — used in dev mode. */
export const identityRedactor: Redactor = (payload) => payload

/**
 * Prod-mode redactor — leaves a few well-known financial fields visible,
 * hashes idempotency / PSP reference fields, truncates long strings,
 * redacts everything else.
 */
export const defaultProdRedactor: Redactor = (payload) => walk(payload, false)

function walk(value: unknown, parentKeyWasSafe: boolean): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => walk(v, parentKeyWasSafe))
  if (isPlainObject(value)) {
    // Encrypted envelopes stay shaped — the dashboard never returns
    // ciphertext but does signal "this field is encrypted, and we
    // couldn't decrypt it".
    if (isEncryptedEnvelope(value)) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (HASHED_KEYS.has(k)) {
        out[k] = hashForDisplay(v)
      } else if (SAFE_KEYS.has(k)) {
        out[k] = redactScalar(v, true)
      } else if (isPlainObject(v) || Array.isArray(v)) {
        out[k] = walk(v, false)
      } else {
        out[k] = REDACTED
      }
    }
    return out
  }
  // Top-level scalars (rare) — respect parent context if available.
  return parentKeyWasSafe ? redactScalar(value, true) : REDACTED
}

function redactScalar(v: unknown, safe: boolean): unknown {
  if (!safe) return REDACTED
  if (typeof v === 'string') {
    return v.length > MAX_STRING_LEN ? `${v.slice(0, MAX_STRING_LEN)}…` : v
  }
  // bigints don't survive JSON.stringify — serialize as decimal string
  // (matches the rest of the dashboard's bigint convention).
  if (typeof v === 'bigint') return v.toString()
  // numbers, booleans pass through.
  return v
}

function hashForDisplay(v: unknown): string {
  if (v === null || v === undefined) return REDACTED
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return `sha256:${createHash('sha256').update(s).digest('hex').slice(0, 16)}`
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  // Plain objects only — instances of Buffer / Date / etc. don't get walked.
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function isEncryptedEnvelope(v: Record<string, unknown>): boolean {
  return '$encrypted' in v
}

/**
 * Decrypt-and-redact one payload. Failures during decryption surface as
 * `{ $encrypted: true, alg: <best-guess> }` — never the ciphertext.
 */
export async function redactPayload(
  decrypt: (value: unknown) => Promise<unknown>,
  payload: unknown,
  ctx: RedactCtx,
  redactor: Redactor,
): Promise<unknown> {
  let plain: unknown
  try {
    plain = await decrypt(payload)
  } catch {
    return { $encrypted: true, alg: extractAlg(payload) }
  }
  return redactor(plain, ctx)
}

function extractAlg(payload: unknown): string {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    '$encrypted' in payload &&
    typeof (payload as Record<string, unknown>)['$encrypted'] === 'string'
  ) {
    const env = (payload as Record<string, unknown>)['$encrypted'] as string
    // env format: 'v1:<alg>:<base64>' — surface alg only.
    const parts = env.split(':')
    return parts[1] ?? 'unknown'
  }
  return 'unknown'
}
