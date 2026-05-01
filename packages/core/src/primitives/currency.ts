/**
 * Currency is represented as ISO-4217-style codes (free-form string for
 * non-fiat — `LKR_PROMO`, `POINTS`). Amounts everywhere are integer minor
 * units stored as `bigint`. Floats never appear in posting math.
 */
export type CurrencyCode = string

export const ZERO = 0n

export function isNonNegative(amount: bigint): boolean {
  return amount >= ZERO
}

export function isPositive(amount: bigint): boolean {
  return amount > ZERO
}

/**
 * Formats a minor-unit amount with a decimal point for display only.
 * Display formatting is the consumer's job; this helper exists so the
 * test suite and reconciliation reports can render numbers consistently.
 */
export function formatMinor(amount: bigint, decimals = 2): string {
  const negative = amount < ZERO
  const abs = negative ? -amount : amount
  if (decimals === 0) {
    return `${negative ? '-' : ''}${abs.toString()}`
  }
  const str = abs.toString().padStart(decimals + 1, '0')
  const whole = str.slice(0, -decimals)
  const frac = `.${str.slice(-decimals)}`
  return `${negative ? '-' : ''}${whole === '' ? '0' : whole}${frac}`
}
