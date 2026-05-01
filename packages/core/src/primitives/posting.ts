import type { CurrencyCode } from './currency.js'

export type Direction = 'D' | 'C'

/**
 * A reference to a concrete account instance (resolved when a transition
 * is driven). Carries enough information for the engine to look up or
 * provision the underlying `accounts` row.
 *
 * The schema-time placeholder `AccountDef` (in `schema/types`) describes
 * the *shape* of an account on an actor type; an `AccountInstanceRef`
 * pins it to a specific actor instance.
 */
export type AccountInstanceRef = {
  readonly _kind: 'accountInstance'
  readonly actorType: string
  readonly actorId: string
  readonly accountName: string
  readonly currency: CurrencyCode
}

export type Posting = {
  readonly direction: Direction
  readonly account: AccountInstanceRef
  readonly amount: bigint
}

/**
 * Sums a list of postings by direction. Used by the engine pre-commit
 * to enforce `sum(D) === sum(C)`.
 */
export function sumByDirection(postings: readonly Posting[]): { debits: bigint; credits: bigint } {
  let debits = 0n
  let credits = 0n
  for (const p of postings) {
    if (p.direction === 'D') debits += p.amount
    else credits += p.amount
  }
  return { debits, credits }
}

export function isBalanced(postings: readonly Posting[]): boolean {
  const { debits, credits } = sumByDirection(postings)
  return debits === credits
}
