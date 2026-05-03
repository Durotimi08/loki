import { describe, expect, it } from 'vitest'
import { defineCurrency, defineCurrencyMap, formatMinor, splitAmount } from '../src/index.js'

describe('batch F — defineCurrency', () => {
  it('returns metadata with sensible defaults', () => {
    const ngn = defineCurrency('NGN')
    expect(ngn).toEqual({ code: 'NGN', decimals: 2, rounding: 'banker' })
  })

  it('accepts overrides', () => {
    const btc = defineCurrency('BTC', { decimals: 8, rounding: 'truncate', symbol: '₿' })
    expect(btc.decimals).toBe(8)
    expect(btc.rounding).toBe('truncate')
    expect(btc.symbol).toBe('₿')
  })

  it('rejects invalid currency codes', () => {
    expect(() => defineCurrency('ngn')).toThrow(/uppercase/)
    expect(() => defineCurrency('1USD')).toThrow(/uppercase/)
    expect(() => defineCurrency('TOO_LONG_CURRENCY_CODE_X')).toThrow(/uppercase/)
  })

  it('rejects out-of-range decimals', () => {
    expect(() => defineCurrency('USD', { decimals: -1 })).toThrow(/decimals/)
    expect(() => defineCurrency('USD', { decimals: 19 })).toThrow(/decimals/)
  })
})

describe('batch F — defineCurrencyMap', () => {
  it('aggregates from an object literal', () => {
    const map = defineCurrencyMap({
      NGN: { decimals: 2, rounding: 'banker' },
      BTC: { decimals: 8, rounding: 'truncate' },
    })
    expect(map.get('NGN')?.decimals).toBe(2)
    expect(map.get('BTC')?.decimals).toBe(8)
  })

  it('aggregates from an array of CurrencyMeta', () => {
    const map = defineCurrencyMap([defineCurrency('NGN'), defineCurrency('USD')])
    expect(Array.from(map.keys()).sort()).toEqual(['NGN', 'USD'])
  })

  it('rejects duplicates in array form', () => {
    expect(() => defineCurrencyMap([defineCurrency('NGN'), defineCurrency('NGN')])).toThrow(/twice/)
  })
})

describe('batch F — formatMinor by currency', () => {
  it('looks up decimals from the currency map', () => {
    const map = defineCurrencyMap({ NGN: { decimals: 2 }, BTC: { decimals: 8 } })
    expect(formatMinor(150_000n, 'NGN', map)).toBe('1500.00')
    expect(formatMinor(150_000n, 'BTC', map)).toBe('0.00150000')
  })

  it('numeric overload still works (legacy)', () => {
    expect(formatMinor(150n)).toBe('1.50')
    expect(formatMinor(150n, 4)).toBe('0.0150')
  })
})

describe('batch F — splitAmount', () => {
  const sumOf = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n)

  it('splits 1000 by 3 with banker rounding (residual on tail)', () => {
    const out = splitAmount(1000n, 3, 'banker')
    expect(out).toEqual([334n, 333n, 333n])
    expect(sumOf(out)).toBe(1000n)
  })

  it('splits 1001 by 3 with banker rounding', () => {
    const out = splitAmount(1001n, 3, 'banker')
    expect(out).toEqual([334n, 334n, 333n])
    expect(sumOf(out)).toBe(1001n)
  })

  it('truncate puts the residual on the first share', () => {
    const out = splitAmount(1000n, 3, 'truncate')
    expect(out).toEqual([334n, 333n, 333n])
    expect(sumOf(out)).toBe(1000n)
  })

  it('floor distributes the residual on the trailing shares', () => {
    const out = splitAmount(1000n, 3, 'floor')
    expect(out).toEqual([333n, 333n, 334n])
    expect(sumOf(out)).toBe(1000n)
  })

  it('exact splits return all-equal portions', () => {
    expect(splitAmount(900n, 3, 'banker')).toEqual([300n, 300n, 300n])
    expect(splitAmount(0n, 5, 'half-up')).toEqual([0n, 0n, 0n, 0n, 0n])
  })

  it('handles single-part splits', () => {
    expect(splitAmount(1234n, 1, 'banker')).toEqual([1234n])
  })

  it('preserves sign on negative totals', () => {
    const out = splitAmount(-1000n, 3, 'banker')
    expect(sumOf(out)).toBe(-1000n)
    // Each share is at most 1 unit different from -333n.
    for (const s of out) {
      expect(s === -333n || s === -334n).toBe(true)
    }
  })

  it('rejects non-positive parts', () => {
    expect(() => splitAmount(100n, 0, 'banker')).toThrow(/positive integer/)
    expect(() => splitAmount(100n, -1, 'banker')).toThrow(/positive integer/)
    expect(() => splitAmount(100n, 1.5, 'banker')).toThrow(/positive integer/)
  })

  it('half-up matches banker for residual placement (no fractional half here)', () => {
    expect(splitAmount(1000n, 3, 'half-up')).toEqual([334n, 333n, 333n])
  })

  it('ceil distributes residual on the leading shares', () => {
    expect(splitAmount(1000n, 3, 'ceil')).toEqual([334n, 333n, 333n])
  })

  it('half-down treats residual like truncate', () => {
    expect(splitAmount(1000n, 3, 'half-down')).toEqual([334n, 333n, 333n])
  })
})
