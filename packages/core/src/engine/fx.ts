import type { Connection } from './connection.js'
import { LokiError } from './errors.js'

/**
 * FX rate table — M16 (Batch D).
 *
 * Tenant-scoped time-series of base/quote/rate tuples. Loki itself
 * never charges money in FX terms — `postings` always live in minor
 * units of a single currency. The rate table sits alongside, so:
 *
 *   - cross-currency transitions can pin a quoted rate at write time
 *     (`data.rate` + `data.rateSource`),
 *   - the reconciler can verify those quotes against the published
 *     rate within a configurable tolerance,
 *   - reporting and historical lookups (e.g., "what was 1 USD to NGN
 *     when this transition committed?") become first-class queries.
 *
 * The schema is intentionally tiny — operators publish rates from
 * whatever feed they trust; Loki just stores and looks them up.
 */

export type FxRate = {
  readonly id: string
  readonly tenantId: string
  readonly baseCurrency: string
  readonly quoteCurrency: string
  /**
   * Decimal rate as a string (numeric(38,18) on the wire). Strings,
   * not `number`, because IEEE-754 cannot represent 18 fractional
   * digits without loss. Multiply via your library of choice
   * (decimal.js, big.js) before applying to a posting amount.
   */
  readonly rate: string
  readonly fixedAt: Date
  readonly expiresAt: Date | null
  readonly source: string
  readonly createdAt: Date
}

export type PublishFxRateInput = {
  readonly tenantId: string
  readonly baseCurrency: string
  readonly quoteCurrency: string
  /** Decimal string. Validated `> 0` at the DB level. */
  readonly rate: string
  readonly source: string
  /** Defaults to `now()` when omitted. */
  readonly fixedAt?: Date
  readonly expiresAt?: Date
}

export type LookupFxRateInput = {
  readonly tenantId: string
  readonly baseCurrency: string
  readonly quoteCurrency: string
  /**
   * Returns the most recent rate at or before `at`. Defaults to
   * `now()`. `expires_at` (if set) must also be after `at`.
   */
  readonly at?: Date
}

export type FxRateHistoryInput = {
  readonly tenantId: string
  readonly baseCurrency: string
  readonly quoteCurrency: string
  readonly since?: Date
  readonly until?: Date
  /** Default 100, capped at 1000. */
  readonly limit?: number
}

export type FxOps = {
  /**
   * Insert a new rate row. No upsert — the table is append-only so the
   * reconciler can verify against the rate that was current at the
   * time of a transition.
   */
  publish(input: PublishFxRateInput): Promise<FxRate>
  /**
   * Most recent published rate for the (base, quote) pair that was
   * in effect at `at` (default `now()`). Returns `null` when none
   * exists or when the matching row's `expires_at` has already passed.
   */
  lookup(input: LookupFxRateInput): Promise<FxRate | null>
  /** Time-series of rates within the [since, until] window, newest first. */
  history(input: FxRateHistoryInput): Promise<readonly FxRate[]>
}

export function buildFxOps(connection: Connection): FxOps {
  return {
    async publish(input) {
      assertCurrency(input.baseCurrency, 'baseCurrency')
      assertCurrency(input.quoteCurrency, 'quoteCurrency')
      assertDistinctPair(input.baseCurrency, input.quoteCurrency)
      assertRate(input.rate)
      const fixedAt = input.fixedAt ?? new Date()
      const expiresAt = input.expiresAt ?? null
      return connection.asAdmin(async (tx) => {
        const [row] = await tx<Record<string, unknown>[]>`
          insert into "fx_rates" (
            tenant_id, base_currency, quote_currency, rate, fixed_at, expires_at, source
          ) values (
            ${input.tenantId}, ${input.baseCurrency}, ${input.quoteCurrency},
            ${input.rate}, ${fixedAt}, ${expiresAt}, ${input.source}
          )
          returning id, tenant_id, base_currency, quote_currency,
                    rate::text as rate, fixed_at, expires_at, source, created_at
        `
        if (!row) throw new LokiError('Failed to insert fx_rates row.')
        return mapFxRate(row)
      })
    },

    async lookup(input) {
      assertCurrency(input.baseCurrency, 'baseCurrency')
      assertCurrency(input.quoteCurrency, 'quoteCurrency')
      assertDistinctPair(input.baseCurrency, input.quoteCurrency)
      const at = input.at ?? new Date()
      return connection.asAdmin(async (tx) => {
        const [row] = await tx<Record<string, unknown>[]>`
          select id, tenant_id, base_currency, quote_currency,
                 rate::text as rate, fixed_at, expires_at, source, created_at
          from "fx_rates"
          where tenant_id = ${input.tenantId}
            and base_currency = ${input.baseCurrency}
            and quote_currency = ${input.quoteCurrency}
            and fixed_at <= ${at}
            and (expires_at is null or expires_at > ${at})
          order by fixed_at desc
          limit 1
        `
        return row ? mapFxRate(row) : null
      })
    },

    async history(input) {
      assertCurrency(input.baseCurrency, 'baseCurrency')
      assertCurrency(input.quoteCurrency, 'quoteCurrency')
      assertDistinctPair(input.baseCurrency, input.quoteCurrency)
      const limit = Math.min(1000, Math.max(1, input.limit ?? 100))
      const since = input.since ?? null
      const until = input.until ?? null
      return connection.asAdmin(async (tx) => {
        const sinceFrag = since ? tx`and fixed_at >= ${since}` : tx``
        const untilFrag = until ? tx`and fixed_at <= ${until}` : tx``
        const rows = await tx<Record<string, unknown>[]>`
          select id, tenant_id, base_currency, quote_currency,
                 rate::text as rate, fixed_at, expires_at, source, created_at
          from "fx_rates"
          where tenant_id = ${input.tenantId}
            and base_currency = ${input.baseCurrency}
            and quote_currency = ${input.quoteCurrency}
            ${sinceFrag}
            ${untilFrag}
          order by fixed_at desc
          limit ${limit}
        `
        return rows.map(mapFxRate)
      })
    },
  }
}

function mapFxRate(row: Record<string, unknown>): FxRate {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    baseCurrency: row['base_currency'] as string,
    quoteCurrency: row['quote_currency'] as string,
    rate: row['rate'] as string,
    fixedAt: row['fixed_at'] as Date,
    expiresAt: (row['expires_at'] as Date | null) ?? null,
    source: row['source'] as string,
    createdAt: row['created_at'] as Date,
  }
}

const CURRENCY_REGEX = /^[A-Z][A-Z0-9_]{0,15}$/
function assertCurrency(value: string, label: string): void {
  if (!CURRENCY_REGEX.test(value)) {
    throw new LokiError(
      `${label} "${value}" must be uppercase letters/digits/underscores only, length 1-16.`,
    )
  }
}

function assertDistinctPair(base: string, quote: string): void {
  if (base === quote) {
    throw new LokiError(
      `FX rate base and quote must differ — got ${base} → ${quote}. An identity rate is not a meaningful exchange.`,
    )
  }
}

function assertRate(value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LokiError('rate must be a non-empty decimal string.')
  }
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new LokiError(`rate "${value}" must be a positive decimal (no exponent, no sign).`)
  }
}
