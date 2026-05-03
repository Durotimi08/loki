import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  PAYLOAD_CRYPTO_DEFAULT_ALGORITHM as DEFAULT_ALGORITHM,
  ENCRYPTED_KEY,
  ENVELOPE_VERSION,
  type PayloadCrypto,
  decryptPayload,
  encryptPayload,
  isEncryptedEnvelope,
} from '../src/index.js'

/**
 * In-memory AES-256-GCM crypto, the same shape an operator would write
 * around `node:crypto` or a KMS client. Everything inside a deployment
 * keys off a single 32-byte secret derived from a passphrase via scrypt.
 */
function makeAesGcmCrypto(passphrase: string): PayloadCrypto {
  const key = scryptSync(passphrase, 'loki-test-salt', 32)
  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([iv, tag, enc]).toString('base64')
    },
    decrypt(ciphertext: string): string {
      const buf = Buffer.from(ciphertext, 'base64')
      const iv = buf.subarray(0, 12)
      const tag = buf.subarray(12, 28)
      const enc = buf.subarray(28)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      const dec = Buffer.concat([decipher.update(enc), decipher.final()])
      return dec.toString('utf8')
    },
  }
}

describe('payload-crypto', () => {
  it('round-trips an arbitrary JSON-safe payload', async () => {
    const crypto = makeAesGcmCrypto('test-pass')
    const original = {
      memo: 'hello',
      amount: { $bigint: '12345' },
      date: '2026-05-03T00:00:00.000Z',
      nested: { tags: ['a', 'b', 'c'] },
    }
    const wrapped = await encryptPayload(crypto, original)
    expect(isEncryptedEnvelope(wrapped)).toBe(true)
    const back = await decryptPayload(crypto, wrapped)
    expect(back).toEqual(original)
  })

  it('storage envelope is a single-key object with the v1 prefix', async () => {
    const crypto = makeAesGcmCrypto('p')
    const env = await encryptPayload(crypto, { x: 1 })
    expect(Object.keys(env)).toEqual([ENCRYPTED_KEY])
    expect(env[ENCRYPTED_KEY]?.startsWith(`${ENVELOPE_VERSION}:${DEFAULT_ALGORITHM}:`)).toBe(true)
  })

  it('respects a custom algorithm tag', async () => {
    const crypto: PayloadCrypto = {
      encrypt: (s) => Buffer.from(s, 'utf8').toString('base64'),
      decrypt: (s) => Buffer.from(s, 'base64').toString('utf8'),
      algorithm: 'kms-v2',
    }
    const env = await encryptPayload(crypto, { ok: true })
    expect(env[ENCRYPTED_KEY]?.startsWith('v1:kms-v2:')).toBe(true)
    const back = await decryptPayload(crypto, env)
    expect(back).toEqual({ ok: true })
  })

  it('decryptPayload returns plain values untouched', async () => {
    const crypto = makeAesGcmCrypto('p')
    expect(await decryptPayload(crypto, { plain: 1 })).toEqual({ plain: 1 })
    expect(await decryptPayload(crypto, null)).toBe(null)
    expect(await decryptPayload(crypto, 'string')).toBe('string')
    expect(await decryptPayload(crypto, [1, 2])).toEqual([1, 2])
  })

  it('decryptPayload throws when an envelope is seen but no crypto is configured', async () => {
    const crypto = makeAesGcmCrypto('p')
    const env = await encryptPayload(crypto, { v: 1 })
    await expect(decryptPayload(undefined, env)).rejects.toThrow(/no payloadCrypto/)
  })

  it('rejects unknown envelope versions', async () => {
    const crypto = makeAesGcmCrypto('p')
    await expect(decryptPayload(crypto, { [ENCRYPTED_KEY]: 'v9:aes:abc' })).rejects.toThrow(
      /Unsupported payload envelope version/,
    )
  })

  it('supports async encrypt / decrypt (KMS-style)', async () => {
    const sync = makeAesGcmCrypto('p')
    const asyncCrypto: PayloadCrypto = {
      encrypt: async (s) => sync.encrypt(s),
      decrypt: async (s) => sync.decrypt(s as string),
    }
    const env = await encryptPayload(asyncCrypto, { v: 1 })
    expect(await decryptPayload(asyncCrypto, env)).toEqual({ v: 1 })
  })

  it('isEncryptedEnvelope rejects extra keys', () => {
    expect(isEncryptedEnvelope({ [ENCRYPTED_KEY]: 'v1:aes:abc' })).toBe(true)
    expect(isEncryptedEnvelope({ [ENCRYPTED_KEY]: 'v1:aes:abc', extra: 1 })).toBe(false)
    expect(isEncryptedEnvelope({})).toBe(false)
    expect(isEncryptedEnvelope(null)).toBe(false)
  })
})
