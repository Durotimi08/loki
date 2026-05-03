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
 * to enforce `sum(D) === sum(C)`. Aggregates across all currencies —
 * use `sumByDirectionPerCurrency` for the per-currency view that M16
 * relies on.
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

/**
 * Per-currency sums. The map is keyed by the leg's account currency.
 * `isBalanced` uses this — `D === C` must hold within each currency,
 * not just in aggregate, otherwise an FX transition could "balance"
 * 100 USD against 8500 NGN with no rate metadata anywhere.
 */
export function sumByDirectionPerCurrency(
  postings: readonly Posting[],
): Map<CurrencyCode, { debits: bigint; credits: bigint }> {
  const out = new Map<CurrencyCode, { debits: bigint; credits: bigint }>()
  for (const p of postings) {
    const slot = out.get(p.account.currency) ?? { debits: 0n, credits: 0n }
    if (p.direction === 'D') slot.debits += p.amount
    else slot.credits += p.amount
    out.set(p.account.currency, slot)
  }
  return out
}

export function isBalanced(postings: readonly Posting[]): boolean {
  for (const { debits, credits } of sumByDirectionPerCurrency(postings).values()) {
    if (debits !== credits) return false
  }
  return true
}
