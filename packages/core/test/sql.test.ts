import { describe, expect, it } from 'vitest'
import { SqlError, ident, inList, literal, literalString, trimSql } from '../src/index.js'

describe('ident', () => {
  it('quotes valid identifiers in double quotes', () => {
    expect(ident('foo')).toBe('"foo"')
    expect(ident('with_underscore')).toBe('"with_underscore"')
    expect(ident('A1')).toBe('"A1"')
    expect(ident('_leading_underscore')).toBe('"_leading_underscore"')
  })

  it('rejects identifiers that could escape the quoter', () => {
    expect(() => ident('1starts_with_digit')).toThrow(SqlError)
    expect(() => ident('with space')).toThrow(SqlError)
    expect(() => ident('with"quote')).toThrow(SqlError)
    expect(() => ident('with;semi')).toThrow(SqlError)
    expect(() => ident('')).toThrow(SqlError)
    expect(() => ident('drop table foo;--')).toThrow(SqlError)
  })

  it('rejects non-string input', () => {
    // @ts-expect-error - runtime guard exercised
    expect(() => ident(42)).toThrow(SqlError)
    // @ts-expect-error
    expect(() => ident(null)).toThrow(SqlError)
  })
})

describe('literalString', () => {
  it('wraps in single quotes and doubles internal quotes', () => {
    expect(literalString('hello')).toBe("'hello'")
    expect(literalString("O'Brien")).toBe("'O''Brien'")
    expect(literalString('')).toBe("''")
  })

  it('rejects NUL bytes', () => {
    const withNul = `safe${String.fromCharCode(0)}injection`
    expect(() => literalString(withNul)).toThrow(SqlError)
  })
})

describe('literal', () => {
  it('handles every supported scalar', () => {
    expect(literal(null)).toBe('NULL')
    expect(literal(true)).toBe('TRUE')
    expect(literal(false)).toBe('FALSE')
    expect(literal(42)).toBe('42')
    expect(literal(0)).toBe('0')
    expect(literal(-1)).toBe('-1')
    expect(literal(3.14)).toBe('3.14')
    expect(literal(1500n)).toBe('1500')
    expect(literal('foo')).toBe("'foo'")
  })

  it('rejects non-finite numbers', () => {
    expect(() => literal(Number.NaN)).toThrow(SqlError)
    expect(() => literal(Number.POSITIVE_INFINITY)).toThrow(SqlError)
  })
})

describe('inList', () => {
  it('formats comma-separated string lists', () => {
    expect(inList(['a', 'b', 'c'])).toBe("('a', 'b', 'c')")
  })

  it('escapes embedded quotes', () => {
    expect(inList(["O'Brien", "Lee'is"])).toBe("('O''Brien', 'Lee''is')")
  })

  it('produces (NULL) for an empty list — never matches anything', () => {
    expect(inList([])).toBe('(NULL)')
  })
})

describe('trimSql', () => {
  it('strips trailing whitespace per line and collapses trailing newlines', () => {
    expect(trimSql('a   \nb\t\n\n\n')).toBe('a\nb\n')
  })

  it('always ends with exactly one newline', () => {
    expect(trimSql('foo')).toBe('foo\n')
    expect(trimSql('foo\n\n\n')).toBe('foo\n')
  })
})
