import { describe, expect, it } from 'vitest'
import type { AccountInstanceRef, CurrencyCode, Posting } from '../src/index.js'
import { isBalanced, sumByDirection, sumByDirectionPerCurrency } from '../src/index.js'

const acc = (name: string, currency: CurrencyCode = 'NGN'): AccountInstanceRef => ({
  _kind: 'accountInstance',
  actorType: 'Test',
  actorId: 't-1',
  accountName: name,
  currency,
})

const D = (a: AccountInstanceRef, amount: bigint): Posting => ({
  direction: 'D',
  account: a,
  amount,
})
const C = (a: AccountInstanceRef, amount: bigint): Posting => ({
  direction: 'C',
  account: a,
  amount,
})

describe('postings — sumByDirection', () => {
  it('returns 0 for an empty list', () => {
    expect(sumByDirection([])).toEqual({ debits: 0n, credits: 0n })
  })

  it('totals debits and credits independently', () => {
    const p = [D(acc('w'), 100n), D(acc('w'), 50n), C(acc('b'), 75n), C(acc('r'), 75n)]
    expect(sumByDirection(p)).toEqual({ debits: 150n, credits: 150n })
  })

  it('uses bigint arithmetic — never silently overflows to Number', () => {
    const big = 9_000_000_000_000_000_000n
    const p = [D(acc('w'), big), C(acc('b'), big)]
    expect(sumByDirection(p)).toEqual({ debits: big, credits: big })
  })
})

describe('postings — isBalanced', () => {
  it('is true when sums match', () => {
    expect(isBalanced([D(acc('w'), 1500n), C(acc('b'), 500n), C(acc('r'), 1000n)])).toBe(true)
  })

  it('is false on mismatched sums', () => {
    expect(isBalanced([D(acc('w'), 1500n), C(acc('b'), 500n)])).toBe(false)
  })

  it('is true on an empty list (vacuously balanced)', () => {
    expect(isBalanced([])).toBe(true)
  })

  it('is false when an FX leg balances in aggregate but not per currency', () => {
    // 100 USD debited, 100 NGN credited — sum matches, but neither
    // currency is balanced on its own. Must be flagged.
    const p: Posting[] = [D(acc('usd_wallet', 'USD'), 100n), C(acc('ngn_wallet', 'NGN'), 100n)]
    expect(isBalanced(p)).toBe(false)
  })

  it('is true when each currency balances independently', () => {
    // Realistic FX: D 100 USD ↔ C 100 USD (to fx_holding); D 8500 NGN
    // (from fx_holding) ↔ C 8500 NGN. Each currency nets to zero.
    const userUsd = acc('usd_wallet', 'USD')
    const fxUsd = acc('fx_holding', 'USD')
    const fxNgn = acc('fx_holding', 'NGN')
    const userNgn = acc('ngn_wallet', 'NGN')
    expect(isBalanced([D(userUsd, 100n), C(fxUsd, 100n), D(fxNgn, 8500n), C(userNgn, 8500n)])).toBe(
      true,
    )
  })
})

describe('postings — sumByDirectionPerCurrency', () => {
  it('groups debits and credits by account currency', () => {
    const p: Posting[] = [
      D(acc('w', 'USD'), 100n),
      C(acc('h', 'USD'), 100n),
      D(acc('h', 'NGN'), 8500n),
      C(acc('w', 'NGN'), 8500n),
    ]
    const sums = sumByDirectionPerCurrency(p)
    expect(sums.get('USD')).toEqual({ debits: 100n, credits: 100n })
    expect(sums.get('NGN')).toEqual({ debits: 8500n, credits: 8500n })
  })

  it('returns an empty map for no postings', () => {
    expect(sumByDirectionPerCurrency([]).size).toBe(0)
  })
})
