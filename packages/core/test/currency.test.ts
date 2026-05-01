import { describe, expect, it } from 'vitest'
import { ZERO, formatMinor, isNonNegative, isPositive } from '../src/index.js'

describe('currency — predicates', () => {
  it('isPositive only on strictly > 0', () => {
    expect(isPositive(1n)).toBe(true)
    expect(isPositive(ZERO)).toBe(false)
    expect(isPositive(-1n)).toBe(false)
  })

  it('isNonNegative on >= 0', () => {
    expect(isNonNegative(0n)).toBe(true)
    expect(isNonNegative(1n)).toBe(true)
    expect(isNonNegative(-1n)).toBe(false)
  })
})

describe('currency — formatMinor', () => {
  it('formats whole-unit amounts with 2 decimals by default', () => {
    expect(formatMinor(150_000n)).toBe('1500.00')
    expect(formatMinor(0n)).toBe('0.00')
    expect(formatMinor(50n)).toBe('0.50')
    expect(formatMinor(5n)).toBe('0.05')
  })

  it('formats with arbitrary decimal precision', () => {
    expect(formatMinor(1n, 0)).toBe('1')
    expect(formatMinor(12345n, 4)).toBe('1.2345')
  })

  it('preserves sign for negatives', () => {
    expect(formatMinor(-150n)).toBe('-1.50')
    expect(formatMinor(-5n, 2)).toBe('-0.05')
  })
})
