/**
 * Account routes — DASHBOARD.md §6.4.
 *
 *   GET /api/v1/tenants/:tid/accounts/:actorType/:id/:name
 *   GET /api/v1/tenants/:tid/accounts/:actorType/:id/:name/history
 *   GET /api/v1/tenants/:tid/accounts/:actorType/:id/:name/balance-at
 *   GET /api/v1/tenants/:tid/accounts/:actorType/:id/:name/aggregate
 *
 * `actorType` and `name` are checked against the static schema (closed
 * enum) before any DB call. `currency` is read from the schema's declared
 * accounts so the client never names a currency we don't have.
 */
import type { FastifyInstance } from 'fastify'
import type { AccountAggregate, AccountAggregateMetric, SchemaDef } from '@loki/core'
import type { CursorEncoder } from '../security/cursor.js'
import * as v from '../security/validation.js'
import type { ReadEngine } from '../read-engine.js'
import { problem, resolveTenant } from './helpers.js'

export type AccountRouteContext = {
  readonly engine: ReadEngine
  readonly schema: SchemaDef
  readonly tenants: 'all' | readonly string[]
  readonly cursor: CursorEncoder
}

const ALLOWED_AGGREGATE_METRICS: readonly AccountAggregateMetric[] = [
  'count',
  'sum_credit',
  'sum_debit',
  'min_amount',
  'max_amount',
]

export function registerAccountRoutes(app: FastifyInstance, ctx: AccountRouteContext): void {
  app.get(
    '/api/v1/tenants/:tid/accounts/:actorType/:id/:name',
    async (req, reply) => {
      const ident = await resolveAccount(ctx, req, reply)
      if (ident === null) return reply
      const client = ctx.engine.forTenant(ident.tid)
      const balance = await client.accounts.balance({
        actor: { type: ident.actorType, id: ident.actorId },
        name: ident.name,
        currency: ident.currency,
      })
      reply.header('Cache-Control', 'private, no-store')
      return {
        actor: { type: ident.actorType, id: ident.actorId },
        name: ident.name,
        currency: ident.currency,
        balance: balance.toString(),
      }
    },
  )

  app.get(
    '/api/v1/tenants/:tid/accounts/:actorType/:id/:name/balance-at',
    async (req, reply) => {
      const ident = await resolveAccount(ctx, req, reply)
      if (ident === null) return reply
      const q = req.query as Record<string, string | undefined>
      const at = v.isoTimestamp(q['at'])
      if (!at.ok) return problem(reply, 400, 'bad-at', at.reason)

      const client = ctx.engine.forTenant(ident.tid)
      const balance = await client.queries.account.balanceAt(
        {
          actor: { type: ident.actorType, id: ident.actorId },
          name: ident.name,
          currency: ident.currency,
        },
        at.value,
      )
      reply.header('Cache-Control', 'private, no-store')
      return {
        actor: { type: ident.actorType, id: ident.actorId },
        name: ident.name,
        currency: ident.currency,
        balance: balance.toString(),
        at: at.value.toISOString(),
      }
    },
  )

  app.get(
    '/api/v1/tenants/:tid/accounts/:actorType/:id/:name/history',
    async (req, reply) => {
      const ident = await resolveAccount(ctx, req, reply)
      if (ident === null) return reply
      const q = req.query as Record<string, string | undefined>

      const limit = v.limit(q['limit'])
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

      let dir: 'D' | 'C' | undefined
      if (q['direction'] !== undefined) {
        const r = v.direction(q['direction'])
        if (!r.ok) return problem(reply, 400, 'bad-direction', r.reason)
        dir = r.value
      }

      let innerCursor: string | undefined
      const route = `account-history:${ident.actorType}:${ident.actorId}:${ident.name}:${ident.currency}`
      if (q['cursor'] !== undefined) {
        const dec = ctx.cursor.decode(route, q['cursor'])
        if (!dec.ok) return problem(reply, 400, 'bad-cursor', dec.reason)
        innerCursor = dec.inner
      }

      const client = ctx.engine.forTenant(ident.tid)
      const page = await client.queries.account.history(
        {
          actor: { type: ident.actorType, id: ident.actorId },
          name: ident.name,
          currency: ident.currency,
        },
        {
          ...(since !== undefined ? { since } : {}),
          ...(until !== undefined ? { until } : {}),
          ...(dir !== undefined ? { direction: dir } : {}),
          ...(innerCursor !== undefined ? { cursor: innerCursor } : {}),
          limit: limit.value,
        },
      )

      reply.header('Cache-Control', 'private, no-store')
      return {
        items: page.items.map((p) => ({
          direction: p.direction,
          amount: p.amount.toString(),
        })),
        nextCursor: page.nextCursor !== null ? ctx.cursor.encode(route, page.nextCursor) : null,
      }
    },
  )

  app.get(
    '/api/v1/tenants/:tid/accounts/:actorType/:id/:name/aggregate',
    async (req, reply) => {
      const ident = await resolveAccount(ctx, req, reply)
      if (ident === null) return reply
      const q = req.query as Record<string, string | undefined>

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

      let metrics: AccountAggregateMetric[] | undefined
      if (q['metrics'] !== undefined) {
        const parts = q['metrics'].split(',').map((s) => s.trim()).filter(Boolean)
        for (const p of parts) {
          if (!(ALLOWED_AGGREGATE_METRICS as readonly string[]).includes(p)) {
            return problem(reply, 400, 'bad-metric', p)
          }
        }
        metrics = parts as AccountAggregateMetric[]
      }

      const client = ctx.engine.forTenant(ident.tid)
      const agg = await client.queries.account.aggregate(
        {
          actor: { type: ident.actorType, id: ident.actorId },
          name: ident.name,
          currency: ident.currency,
        },
        {
          ...(since !== undefined ? { since } : {}),
          ...(until !== undefined ? { until } : {}),
          ...(metrics !== undefined ? { metrics } : {}),
        },
      )

      reply.header('Cache-Control', 'private, no-store')
      return serializeAggregate(agg)
    },
  )
}

type ResolvedAccount = {
  readonly tid: string
  readonly actorType: string
  readonly actorId: string
  readonly name: string
  readonly currency: string
}

async function resolveAccount(
  ctx: AccountRouteContext,
  req: { params: unknown; query: unknown },
  reply: Parameters<typeof problem>[0],
): Promise<ResolvedAccount | null> {
  const params = req.params as {
    tid?: string
    actorType?: string
    id?: string
    name?: string
  }
  const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
  if (t === null) return null

  const at = v.actorType(params.actorType, ctx.schema)
  if (!at.ok) {
    problem(reply, 404, 'unknown-actor-type', at.reason)
    return null
  }
  const idRaw = v.canonicalString(params.id, 128)
  if (!idRaw.ok) {
    problem(reply, 400, 'bad-actor-id', idRaw.reason)
    return null
  }
  const name = v.accountName(params.name, ctx.schema, at.value)
  if (!name.ok) {
    problem(reply, 404, 'unknown-account', name.reason)
    return null
  }

  // Currency: take from the static schema; reject any client override
  // unless it matches what the schema declares.
  const actor = ctx.schema.actors.find((a) => a.name === at.value)
  if (actor === undefined) {
    problem(reply, 404, 'unknown-actor-type')
    return null
  }
  const acc = actor.accounts[name.value]
  if (acc === undefined) {
    problem(reply, 404, 'unknown-account')
    return null
  }
  const q = req.query as Record<string, string | undefined>
  if (q['currency'] !== undefined && q['currency'] !== acc.currency) {
    problem(reply, 400, 'currency-mismatch')
    return null
  }

  return {
    tid: t.id,
    actorType: at.value,
    actorId: idRaw.value,
    name: name.value,
    currency: acc.currency,
  }
}

function serializeAggregate(agg: AccountAggregate): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, val] of Object.entries(agg)) {
    if (typeof val === 'bigint') out[k] = val.toString()
    else if (typeof val === 'number') out[k] = val
  }
  return out
}
