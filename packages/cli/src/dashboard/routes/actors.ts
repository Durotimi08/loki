/**
 * Actor routes — DASHBOARD.md §6.3.
 *
 *   GET /api/v1/tenants/:tid/actors                        → actor types + counts
 *   GET /api/v1/tenants/:tid/actors/:type                  → page of actor ids
 *   GET /api/v1/tenants/:tid/actors/:type/:id              → actor detail
 *   GET /api/v1/tenants/:tid/actors/:type/:id/summary      → per-actor summary
 *   GET /api/v1/tenants/:tid/actors/:type/:id/transactions → per-actor txn page
 *   GET /api/v1/tenants/:tid/actors/:type/:id/trails       → per-actor trails
 *
 * Every `:type` is validated against the static schema before any DB
 * call (§8.19.2). Cursors are HMAC-signed + route-scoped (§8.19.4).
 */
import type { FastifyInstance } from 'fastify'
import type { SchemaDef } from '@loki/core'
import type { CursorEncoder } from '../security/cursor.js'
import * as v from '../security/validation.js'
import type { ReadEngine } from '../read-engine.js'
import { problem, resolveTenant } from './helpers.js'

export type ActorRouteContext = {
  readonly engine: ReadEngine
  readonly schema: SchemaDef
  readonly tenants: 'all' | readonly string[]
  readonly cursor: CursorEncoder
}

export function registerActorRoutes(app: FastifyInstance, ctx: ActorRouteContext): void {
  // Actor types — schema-declared list + live distinct-id counts.
  app.get('/api/v1/tenants/:tid/actors', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    const [counts, active] = await Promise.all([
      ctx.engine.dashboard.actorTypeCounts(t.id),
      ctx.engine.dashboard.actorTypeActiveCounts(t.id, sevenDaysMs),
    ])
    const countByType = new Map(counts.map((c) => [c.type, c.count]))
    const activeByType = new Map(active.map((c) => [c.type, c.count]))
    reply.header('Cache-Control', 'private, no-store')
    return {
      items: ctx.schema.actors.map((a) => ({
        type: a.name,
        count: countByType.get(a.name) ?? 0,
        active7d: activeByType.get(a.name) ?? 0,
        accounts: Object.values(a.accounts).map((acc) => ({
          name: acc.name,
          currency: acc.currency,
        })),
      })),
    }
  })

  // Actor ID enumeration (one type).
  app.get('/api/v1/tenants/:tid/actors/:type', async (req, reply) => {
    const params = req.params as { tid?: string; type?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    const at = v.actorType(params.type, ctx.schema)
    if (!at.ok) return problem(reply, 404, 'unknown-actor-type', at.reason)

    const q = req.query as Record<string, string | undefined>
    const limit = v.limit(q['limit'])
    if (!limit.ok) return problem(reply, 400, 'bad-limit', limit.reason)

    let inner: string | undefined
    if (q['cursor'] !== undefined) {
      const dec = ctx.cursor.decode(`actors:${at.value}`, q['cursor'])
      if (!dec.ok) return problem(reply, 400, 'bad-cursor', dec.reason)
      inner = dec.inner
    }

    const page = await ctx.engine.dashboard.actorIds(t.id, at.value, {
      ...(inner !== undefined ? { cursor: inner } : {}),
      limit: limit.value,
    })

    reply.header('Cache-Control', 'private, no-store')
    return {
      items: page.items.map((id) => ({ type: at.value, id })),
      nextCursor: page.nextCursor !== null
        ? ctx.cursor.encode(`actors:${at.value}`, page.nextCursor)
        : null,
    }
  })

  // Actor detail — accounts + balances.
  app.get('/api/v1/tenants/:tid/actors/:type/:id', async (req, reply) => {
    const params = req.params as { tid?: string; type?: string; id?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    const at = v.actorType(params.type, ctx.schema)
    if (!at.ok) return problem(reply, 404, 'unknown-actor-type', at.reason)
    const actorIdRaw = v.canonicalString(params.id, 128)
    if (!actorIdRaw.ok) return problem(reply, 400, 'bad-actor-id', actorIdRaw.reason)

    const actor = { type: at.value, id: actorIdRaw.value }
    const accounts = await ctx.engine.dashboard.actorAccounts(t.id, actor)
    if (accounts.length === 0) return problem(reply, 404, 'actor-not-found')
    reply.header('Cache-Control', 'private, no-store')
    return {
      type: at.value,
      id: actorIdRaw.value,
      accounts: accounts.map((a) => ({
        name: a.name,
        currency: a.currency,
        balance: a.balance.toString(),
      })),
    }
  })

  // Per-actor summary (engine.queries.actor.summary).
  app.get('/api/v1/tenants/:tid/actors/:type/:id/summary', async (req, reply) => {
    const params = req.params as { tid?: string; type?: string; id?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    const at = v.actorType(params.type, ctx.schema)
    if (!at.ok) return problem(reply, 404, 'unknown-actor-type', at.reason)
    const actorIdRaw = v.canonicalString(params.id, 128)
    if (!actorIdRaw.ok) return problem(reply, 400, 'bad-actor-id', actorIdRaw.reason)

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

    const client = ctx.engine.forTenant(t.id)
    const actor = { type: at.value, id: actorIdRaw.value }
    const [summary, accountActivity] = await Promise.all([
      client.queries.actor(actor).summary({
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
      }),
      ctx.engine.dashboard.actorAccountActivity(t.id, actor, {
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
      }),
    ])
    reply.header('Cache-Control', 'private, no-store')
    return {
      // "Initiated" view — transitions this actor itself fired.
      transitions: summary.transitions,
      totalCredited: summary.totalCredited.toString(),
      totalDebited: summary.totalDebited.toString(),
      byState: summary.byState,
      byType: summary.byType,
      // "Account" view — postings on accounts owned by this actor,
      // regardless of who fired the transition. This is the right metric
      // for "what happened on this actor's books".
      account: {
        transitionsTouched: accountActivity.transitionsTouched,
        credited: accountActivity.credited,
        debited: accountActivity.debited,
      },
    }
  })

  // Per-actor transactions — paginated list of records this actor has touched.
  app.get('/api/v1/tenants/:tid/actors/:type/:id/transactions', async (req, reply) => {
    const params = req.params as { tid?: string; type?: string; id?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    const at = v.actorType(params.type, ctx.schema)
    if (!at.ok) return problem(reply, 404, 'unknown-actor-type', at.reason)
    const actorIdRaw = v.canonicalString(params.id, 128)
    if (!actorIdRaw.ok) return problem(reply, 400, 'bad-actor-id', actorIdRaw.reason)

    const q = req.query as Record<string, string | undefined>
    const limit = v.limit(q['limit'])
    if (!limit.ok) return problem(reply, 400, 'bad-limit', limit.reason)

    let inner: string | undefined
    if (q['cursor'] !== undefined) {
      const dec = ctx.cursor.decode(`actor-txns:${at.value}:${actorIdRaw.value}`, q['cursor'])
      if (!dec.ok) return problem(reply, 400, 'bad-cursor', dec.reason)
      inner = dec.inner
    }

    const client = ctx.engine.forTenant(t.id)
    const page = await client.queries.actor({ type: at.value, id: actorIdRaw.value }).transactions({
      limit: limit.value,
      ...(inner !== undefined ? { cursor: inner } : {}),
    })

    reply.header('Cache-Control', 'private, no-store')
    return {
      items: page.items.map((r) => ({
        id: r.id,
        type: r.type,
        state: r.state,
        version: r.version,
        compromised: r.compromised,
        updatedAt: r.updatedAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor !== null
        ? ctx.cursor.encode(`actor-txns:${at.value}:${actorIdRaw.value}`, page.nextCursor)
        : null,
    }
  })
}
