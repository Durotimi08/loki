import { describe, expect, it } from 'vitest'
import { ULID_REGEX, ulid } from '../src/index.js'

describe('ulid', () => {
  it('produces 26-character Crockford-base32 strings', () => {
    for (let i = 0; i < 100; i++) {
      const id = ulid()
      expect(id).toHaveLength(26)
      expect(ULID_REGEX.test(id)).toBe(true)
    }
  })

  it('is monotonically non-decreasing across rapid calls', () => {
    const ids = Array.from({ length: 200 }, () => ulid())
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
  })

  it('encodes time monotonically when called with explicit timestamps', () => {
    const a = ulid(1_700_000_000_000)
    const b = ulid(1_700_000_001_000)
    expect(b > a).toBe(true)
  })

  it('produces unique values within the same millisecond', () => {
    const t = 1_700_000_000_000
    const set = new Set<string>()
    for (let i = 0; i < 50; i++) set.add(ulid(t))
    expect(set.size).toBe(50)
  })
})
