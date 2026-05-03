/**
 * Payload encryption hook (M6).
 *
 * Lets operators store sensitive payloads (PII, card last4, free-form
 * memo) encrypted at rest while keeping the engine's hash chain
 * meaningful. The pipeline is:
 *
 *     plaintext  → canonicalize + hash chain → encrypt → store
 *
 * On read:
 *
 *     row → decrypt → canonicalize → re-hash → verify
 *
 * Hashing happens over the PLAINTEXT canonical form so a key rotation
 * never invalidates historical hashes. The storage envelope is a
 * single-key object so a JSONB column can hold either the encrypted
 * form or the plain form transparently:
 *
 *     { "$encrypted": "v1:aes-256-gcm:<base64-ciphertext>" }
 *
 * The crypto layer is a pure plug-in — Loki itself never picks an
 * algorithm, never holds a key, and never talks to a KMS. The hook is
 * `undefined` by default; deployments without a crypto config write
 * payloads as plaintext (current behaviour, byte-for-byte unchanged).
 */

import { LokiError } from '../engine/errors.js'

export const ENCRYPTED_KEY = '$encrypted'
export const ENVELOPE_VERSION = 'v1'
export const DEFAULT_ALGORITHM = 'aes-256-gcm'

/**
 * Operator-supplied encryption hook. Both methods may be sync or async
 * (return a value or a `Promise`); the engine `await`s either way so a
 * KMS call works as cleanly as in-process AES.
 *
 * `encrypt` receives a UTF-8 string of canonical JSON (whatever
 * `JSON.stringify`'s of `jsonifyForStorage(payload)` would produce) and
 * must return a base64-encoded ciphertext blob — IV/nonce + tag
 * concatenated as the implementer prefers, opaque to Loki.
 *
 * `decrypt` is the inverse: take the base64 string, return the
 * original UTF-8 JSON.
 *
 * `algorithm` is a free-form tag written into the envelope. It exists
 * only so future migrations can route an old envelope through the old
 * key — Loki never inspects it.
 */
export type PayloadCrypto = {
  encrypt(plaintextJson: string): string | Promise<string>
  decrypt(ciphertext: string): string | Promise<string>
  readonly algorithm?: string
}

export function isEncryptedEnvelope(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null) return false
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== ENCRYPTED_KEY) return false
  return typeof (value as Record<string, unknown>)[ENCRYPTED_KEY] === 'string'
}

/**
 * Wrap a JSON-safe value (whatever `jsonifyForStorage` produced) into
 * the storage envelope. The caller has already canonicalized + hashed
 * the plaintext at this point — encryption is the last step before the
 * INSERT.
 */
export async function encryptPayload(
  crypto: PayloadCrypto,
  jsonSafeValue: unknown,
): Promise<Record<string, string>> {
  const algorithm = crypto.algorithm ?? DEFAULT_ALGORITHM
  const plaintext = JSON.stringify(jsonSafeValue ?? null)
  const ciphertext = await crypto.encrypt(plaintext)
  if (typeof ciphertext !== 'string') {
    throw new LokiError(
      `payloadCrypto.encrypt must return a base64 string, got ${typeof ciphertext}.`,
    )
  }
  return { [ENCRYPTED_KEY]: `${ENVELOPE_VERSION}:${algorithm}:${ciphertext}` }
}

/**
 * Inverse of `encryptPayload`. Returns the value untouched when the
 * input is not an encrypted envelope — so the same code path serves
 * mixed-mode rows during a key-rotation rollout.
 */
export async function decryptPayload(
  crypto: PayloadCrypto | undefined,
  value: unknown,
): Promise<unknown> {
  if (!isEncryptedEnvelope(value)) return value
  if (!crypto) {
    throw new LokiError(
      'Encountered an encrypted payload envelope but no payloadCrypto was configured.',
    )
  }
  const tag = value[ENCRYPTED_KEY]
  if (typeof tag !== 'string') {
    throw new LokiError('Malformed payload envelope: $encrypted must be a string.')
  }
  const firstColon = tag.indexOf(':')
  if (firstColon === -1) throw new LokiError(`Malformed payload envelope: ${tag.slice(0, 40)}…`)
  const version = tag.slice(0, firstColon)
  if (version !== ENVELOPE_VERSION) {
    throw new LokiError(`Unsupported payload envelope version "${version}".`)
  }
  const secondColon = tag.indexOf(':', firstColon + 1)
  if (secondColon === -1) throw new LokiError(`Malformed payload envelope: ${tag.slice(0, 40)}…`)
  // Algorithm tag is captured but not used by the engine — the operator's
  // `decrypt` is expected to know how to reverse what its `encrypt` did.
  const ciphertext = tag.slice(secondColon + 1)
  const json = await crypto.decrypt(ciphertext)
  if (typeof json !== 'string') {
    throw new LokiError(
      `payloadCrypto.decrypt must return a UTF-8 JSON string, got ${typeof json}.`,
    )
  }
  try {
    return JSON.parse(json)
  } catch (e) {
    throw new LokiError(`Decrypted payload was not valid JSON: ${(e as Error).message}`)
  }
}
