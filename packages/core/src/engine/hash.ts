import { createHash } from 'node:crypto'
import { type CanonicalValue, canonicalize } from './canonical.js'

/**
 * Hashing strategy for the §5.1 hash chain. The default is SHA-256;
 * alternatives (BLAKE3, bring-your-own) plug in here.
 *
 * Implementations must be:
 *   - Deterministic (same bytes in → same digest out)
 *   - Collision-resistant for the audit-log threat model (no SHA-1)
 *   - Pure (no I/O, no random salts)
 */
export interface Hasher {
  /** Stable identifier emitted into audit metadata so reconciliation can detect upgrades. */
  readonly algorithm: string
  hash(input: Uint8Array): Buffer
}

export const sha256Hasher: Hasher = {
  algorithm: 'sha256',
  hash(input) {
    return createHash('sha256').update(input).digest()
  },
}

/**
 * Compute the hash of a transition's canonical content given the prior
 * row's `row_hash`. The first transition on a record uses the genesis
 * `prevHash = null`.
 *
 *   row_hash = H(canonical(transition_content) || prev_hash)
 *
 * Tampering with any column on any prior transition breaks the chain
 * for every subsequent row. The reconciler verifies this in §5.2.
 */
export function computeRowHash(
  hasher: Hasher,
  content: CanonicalValue,
  prevHash: Buffer | null,
): Buffer {
  const body = canonicalize(content)
  const tail = prevHash ?? Buffer.alloc(0)
  return hasher.hash(Buffer.concat([body, tail]))
}

/**
 * Compute the checksum of a transition's postings list. Postings are
 * canonicalized — order, direction, account identity, amount — so the
 * hash is invariant under arbitrary insertion order at write time.
 */
export function computePostingsChecksum(
  hasher: Hasher,
  postings: readonly CanonicalValue[],
): Buffer {
  // Sort by the canonical bytes themselves so we don't depend on a
  // specific column order / type knowledge.
  const sorted = postings.map((p) => canonicalize(p)).sort(Buffer.compare)
  return hasher.hash(Buffer.concat(sorted))
}
