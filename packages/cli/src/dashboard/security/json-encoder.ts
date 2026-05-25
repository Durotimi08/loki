/**
 * Safe JSON-in-HTML encoder — DASHBOARD.md §8.7, §8.19.6 T21.
 *
 * When the dashboard inlines JSON into HTML via a
 * `<script type="application/json">` tag, naive `JSON.stringify` is
 * unsafe: a value containing `</script>` would close the tag, U+2028
 * or U+2029 would break inline-JSON parsers, and an apostrophe might
 * break an attribute that wraps the script.
 *
 * This function `JSON.stringify`s and then escapes every dangerous
 * character to its `\uXXXX` form. The output is safe to drop directly
 * inside a `<script type="application/json">` element.
 *
 * Built via `new RegExp(...)` because TypeScript's lexer treats raw
 * U+2028 / U+2029 in source as line terminators inside regex literals.
 */
const DANGEROUS = new RegExp('[<>&\'\\u2028\\u2029]', 'g')

export function safeJsonInScript(value: unknown): string {
  return JSON.stringify(value).replace(
    DANGEROUS,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
