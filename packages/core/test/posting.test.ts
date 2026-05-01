import { describe, expect, it } from 'vitest'
import type { AccountInstanceRef, Posting } from '../src/index.js'
import { isBalanced, sumByDirection } from '../src/index.js'

const acc = (name: string): AccountInstanceRef => ({
  _kind: 'accountInstance',
  actorType: 'Test',
  actorId: 't-1',
  accountName: name,
  currency: 'NGN',
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
})
