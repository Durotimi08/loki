/**
 * Currency is represented as ISO-4217-style codes (free-form string for
 * non-fiat — `LKR_PROMO`, `POINTS`). Amounts everywhere are integer minor
 * units stored as `bigint`. Floats never appear in posting math.
 *
 * Batch F (M0) adds an advisory layer for precision and rounding:
 * `defineCurrency('NGN', { decimals: 2, rounding: 'banker' })` and
 * `defineCurrencyMap({...})`. The engine itself doesn't consume these —
 * postings are always integers. The metadata is for display, splits,
 * and any FX conversion the consumer drives.
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
 * Rounding mode for `formatMinor` overflow and `splitAmount` residual
 * distribution.
 *
 *   - `banker`   — round half to even (IEEE-754 default).
 *   - `half-up`   — round half away from zero (the schoolbook default).
 *   - `half-down` — round half toward zero.
 *   - `truncate`  — drop fractional remainder (toward zero).
 *   - `ceil`      — round toward +∞.
 *   - `floor`     — round toward -∞.
 */
export type RoundingMode = 'banker' | 'half-up' | 'half-down' | 'truncate' | 'ceil' | 'floor'

export type CurrencyMeta = {
  readonly code: CurrencyCode
  readonly decimals: number
  readonly rounding: RoundingMode
  /** Optional human label, e.g. "Nigerian Naira". Display-only. */
  readonly name?: string
  /** Optional symbol, e.g. "₦". Display-only. */
  readonly symbol?: string
}

export type CurrencyDefInput = {
  readonly decimals?: number
  readonly rounding?: RoundingMode
  readonly name?: string
  readonly symbol?: string
}

const ALL_ROUNDING: readonly RoundingMode[] = [
  'banker',
  'half-up',
  'half-down',
  'truncate',
  'ceil',
  'floor',
]

function isRoundingMode(value: unknown): value is RoundingMode {
  return typeof value === 'string' && (ALL_ROUNDING as readonly string[]).includes(value)
}

/**
 * Declare metadata for a single currency. Pure data — no engine side
 * effects. Currency codes follow `[A-Z][A-Z0-9_]*` (uppercase
 * letters/digits/underscores).
 */
export function defineCurrency(code: CurrencyCode, options: CurrencyDefInput = {}): CurrencyMeta {
  if (!/^[A-Z][A-Z0-9_]{0,15}$/.test(code)) {
    throw new Error(`Currency "${code}" must match [A-Z][A-Z0-9_]{0,15} (uppercase, length 1-16).`)
  }
  const decimals = options.decimals ?? 2
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Currency "${code}" decimals must be an integer in [0, 18].`)
  }
  const rounding = options.rounding ?? 'banker'
  if (!isRoundingMode(rounding)) {
    throw new Error(`Currency "${code}" rounding "${rounding}" is not a known mode.`)
  }
  return {
    code,
    decimals,
    rounding,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.symbol !== undefined ? { symbol: options.symbol } : {}),
  }
}

export type CurrencyMap = ReadonlyMap<CurrencyCode, CurrencyMeta>

/**
 * Aggregate currency metadata into a lookup map. Either pass an array
 * of `defineCurrency` results or an object literal:
 *
 *     defineCurrencyMap({
 *       NGN: { decimals: 2, rounding: 'banker' },
 *       BTC: { decimals: 8, rounding: 'truncate' },
 *     })
 */
export function defineCurrencyMap(
  input: Readonly<Record<string, CurrencyDefInput>> | readonly CurrencyMeta[],
): CurrencyMap {
  const map = new Map<CurrencyCode, CurrencyMeta>()
  if (Array.isArray(input)) {
    for (const entry of input as readonly CurrencyMeta[]) {
      if (map.has(entry.code)) {
        throw new Error(`Currency "${entry.code}" defined twice in defineCurrencyMap.`)
      }
      map.set(entry.code, entry)
    }
  } else {
    for (const [code, def] of Object.entries(input as Record<string, CurrencyDefInput>)) {
      map.set(code, defineCurrency(code, def))
    }
  }
  return map
}

/**
 * Formats a minor-unit amount with a decimal point. Two call shapes:
 *
 *   - `formatMinor(123n)` — defaults to 2 decimals (legacy behaviour).
 *   - `formatMinor(123n, 'BTC', currencies)` — looks up decimals from
 *     the currency map.
 *   - `formatMinor(123n, 8)` — explicit decimals.
 */
export function formatMinor(amount: bigint, decimals?: number): string
export function formatMinor(amount: bigint, code: CurrencyCode, currencies: CurrencyMap): string
export function formatMinor(
  amount: bigint,
  decimalsOrCode: number | CurrencyCode | undefined = 2,
  currencies?: CurrencyMap,
): string {
  let decimals: number
  if (typeof decimalsOrCode === 'string') {
    if (!currencies) {
      throw new Error('formatMinor: currency code given but no CurrencyMap supplied.')
    }
    const meta = currencies.get(decimalsOrCode)
    if (!meta) throw new Error(`formatMinor: currency "${decimalsOrCode}" not in map.`)
    decimals = meta.decimals
  } else {
    decimals = decimalsOrCode ?? 2
  }
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

/**
 * Split an integer minor-unit `total` into `parts` portions. The base
 * portion is `floor(total/parts)`; the residual `total - base*parts`
 * is distributed across the leading shares according to the rounding
 * mode.
 *
 * Always sums back to `total` exactly — no precision is lost. This is
 * the canonical helper for "$10 split three ways" and similar splits
 * where the underlying total must be preserved.
 *
 * Examples (assuming 2-decimal currency where 1000 = $10.00):
 *   - splitAmount(1000n, 3, 'banker')   → [333n, 333n, 334n]
 *   - splitAmount(1000n, 3, 'truncate') → [334n, 333n, 333n] (residual on first)
 *   - splitAmount(1001n, 3, 'banker')   → [334n, 334n, 333n]
 *
 * `parts` must be a positive integer; negative totals are supported
 * (residuals are distributed sign-aware so the sum still matches).
 */
export function splitAmount(
  total: bigint,
  parts: number,
  rounding: RoundingMode = 'banker',
): bigint[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new Error(`splitAmount: parts must be a positive integer, got ${parts}.`)
  }
  const partsBig = BigInt(parts)
  // Truncated quotient toward zero — bigint `/` is C-style (toward zero).
  const base = total / partsBig
  const residual = total - base * partsBig
  const out: bigint[] = new Array(parts).fill(base)
  if (residual === 0n) return out

  // `residual` shares the sign of `total`. Number of recipients is
  // `|residual|` for modes that distribute by penny.
  const absResidual = residual < 0n ? -residual : residual
  const sign = residual < 0n ? -1n : 1n
  // For modes other than banker, the residual is distributed across
  // the leading `|residual|` shares.
  const distributePennies = (count: bigint, fromEnd = false): void => {
    const n = Number(count)
    const positions = fromEnd
      ? Array.from({ length: parts }, (_, i) => parts - 1 - i).slice(0, n)
      : Array.from({ length: parts }, (_, i) => i).slice(0, n)
    for (const idx of positions) {
      out[idx] = (out[idx] as bigint) + sign
    }
  }
  switch (rounding) {
    case 'half-up':
    case 'banker':
    case 'ceil':
      distributePennies(absResidual, false)
      break
    case 'truncate':
      // Allocate residual to the FIRST share (no rounding spread —
      // matches "everyone gets equal but the first absorbs leftover").
      out[0] = (out[0] as bigint) + residual
      break
    case 'floor':
      // Floor moves toward -∞. For positive totals → fewer pennies in
      // most shares, residual is dropped onto trailing shares (so
      // earlier ones round down). For negative totals → opposite.
      distributePennies(absResidual, true)
      break
    case 'half-down':
      // Half-down rounds toward zero on ties. With integer minor
      // units there's no fractional half here, so it behaves like
      // truncate for residual placement.
      out[0] = (out[0] as bigint) + residual
      break
  }
  return out
}
