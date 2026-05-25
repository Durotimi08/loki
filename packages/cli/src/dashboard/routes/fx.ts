/**
 * FX route — DASHBOARD.md §6.8.
 *
 *   GET /api/v1/tenants/:tid/fx?base=&quote=&since=&until=&limit=
 *
 * Currencies are restricted to those declared on the static schema's
 * accounts (we never have a use case for a currency the schema doesn't
 * already know about).
 */
import type { FastifyInstance } from 'fastify'
import type { FxRate, SchemaDef } from '@loki/core'
import type { ReadEngine } from '../read-engine.js'
import * as v from '../security/validation.js'
import { problem, resolveTenant } from './helpers.js'

export type FxRouteContext = {
  readonly engine: ReadEngine
  readonly schema: SchemaDef
  readonly tenants: 'all' | readonly string[]
}

const CURRENCY_RE = /^[A-Z]{3}$/

export function registerFxRoutes(app: FastifyInstance, ctx: FxRouteContext): void {
  // Snapshot of every currency the schema declares — that's our closed
  // enum for `base` / `quote`.
  const knownCurrencies = new Set<string>()
  for (const a of ctx.schema.actors) {
    for (const acc of Object.values(a.accounts)) {
      knownCurrencies.add(acc.currency)
    }
  }

  app.get('/api/v1/tenants/:tid/fx', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply

    const q = req.query as Record<string, string | undefined>
    const base = q['base']
    const quote = q['quote']
    if (typeof base !== 'string' || !CURRENCY_RE.test(base)) {
      return problem(reply, 400, 'bad-base', 'expected 3-letter currency')
    }
    if (typeof quote !== 'string' || !CURRENCY_RE.test(quote)) {
      return problem(reply, 400, 'bad-quote', 'expected 3-letter currency')
    }
    if (!knownCurrencies.has(base)) return problem(reply, 404, 'unknown-base-currency')
    if (!knownCurrencies.has(quote)) return problem(reply, 404, 'unknown-quote-currency')

    const limit = v.limit(q['limit'], 1000)
    if (!limit.ok) return problem(reply, 400, 'bad-limit', limit.reason)

    let since: Date | undefined
    let until: Date | undefined
    if (q['since'] !== undefined) {
      const r = v.isoTimestamp(q['since'])
      if (!r.ok) return problem(reply, 400, 'bad-since', r.reason)
      since = r.value
    }
    if (q['until'] !== undefined) {
      const r = v.isoTimestamp(q['until'])
      if (!r.ok) return problem(reply, 400, 'bad-until', r.reason)
      until = r.value
    }

    const rows = await ctx.engine.fx.history({
      tenantId: t.id,
      baseCurrency: base,
      quoteCurrency: quote,
      limit: limit.value,
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    })
    reply.header('Cache-Control', 'private, no-store')
    return { items: rows.map(projectFx) }
  })
}

function projectFx(r: FxRate): Record<string, unknown> {
  return {
    id: r.id,
    baseCurrency: r.baseCurrency,
    quoteCurrency: r.quoteCurrency,
    rate: r.rate,
    fixedAt: r.fixedAt.toISOString(),
    expiresAt: r.expiresAt !== null ? r.expiresAt.toISOString() : null,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }
}
