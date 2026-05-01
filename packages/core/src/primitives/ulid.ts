import { randomBytes } from 'node:crypto'

/**
 * Crockford's Base32 alphabet (no I, L, O, U).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Generates a Crockford-Base32 ULID. 26 chars: 10 timestamp + 16 random.
 * Monotonically increasing per process when called within the same
 * millisecond, by incrementing the random portion. The engine sorts
 * `txn_transitions` by `id` to derive ordering — see §6.6.
 */
let lastTime = 0
let lastRandom = new Uint8Array(10)

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    incrementRandom(lastRandom)
  } else {
    lastTime = now
    lastRandom = randomBytes(10)
  }

  return `${encodeTime(now)}${encodeRandom(lastRandom)}`
}

function encodeTime(time: number): string {
  // 10 chars × 5 bits = 50 bits — enough for milliseconds until year 10889.
  let out = ''
  let t = time
  for (let i = 9; i >= 0; i--) {
    const mod = t % 32
    out = ALPHABET[mod] + out
    t = (t - mod) / 32
  }
  return out
}

function encodeRandom(bytes: Uint8Array): string {
  // 16 chars × 5 bits = 80 bits, drawn from 10 random bytes (80 bits).
  let bitBuf = 0
  let bits = 0
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    bitBuf = (bitBuf << 8) | (bytes[i] ?? 0)
    bits += 8
    while (bits >= 5) {
      bits -= 5
      const idx = (bitBuf >>> bits) & 0x1f
      out += ALPHABET[idx]
    }
  }
  if (bits > 0) {
    out += ALPHABET[(bitBuf << (5 - bits)) & 0x1f]
  }
  return out.slice(0, 16)
}

function incrementRandom(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const next = ((bytes[i] ?? 0) + 1) & 0xff
    bytes[i] = next
    if (next !== 0) return
  }
}

export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/
