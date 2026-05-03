import { describe, expect, it } from 'vitest'
import { compareLsn } from '../src/index.js'

describe('batch G — compareLsn', () => {
  it('orders LSNs by high half first', () => {
    expect(compareLsn('0/1', '1/0')).toBeLessThan(0)
    expect(compareLsn('1/0', '0/FFFFFFFF')).toBeGreaterThan(0)
  })

  it('orders within the same high half by low half', () => {
    expect(compareLsn('0/1A2B', '0/1A2C')).toBeLessThan(0)
    expect(compareLsn('0/1A2C', '0/1A2B')).toBeGreaterThan(0)
  })

  it('returns zero for identical LSNs', () => {
    expect(compareLsn('1A/B2C3D4E5', '1A/B2C3D4E5')).toBe(0)
  })

  it('hex digits are case-insensitive numerically', () => {
    expect(compareLsn('0/abcdef', '0/ABCDEF')).toBe(0)
  })

  it('handles single-digit halves', () => {
    expect(compareLsn('0/1', '0/2')).toBeLessThan(0)
    expect(compareLsn('A/B', 'A/B')).toBe(0)
  })
})
