/**
 * Flow routes — DASHBOARD.md §6.10.
 *
 *   GET /api/v1/tenants/:tid/flows                             → txn types + total + by-state counts
 *   GET /api/v1/tenants/:tid/flows/:txnType?windowMs=         → state machine snapshot
 *   GET /api/v1/tenants/:tid/flows/:txnType/instances?state=  → page of records in state
 *
 * The state-machine snapshot pulls structural data from the static
 * schema (states, terminal flag, transitions and their declared `by`,
 * `needs`, `unlocks`, `emit`) and overlays live counts from SQL. The
 * UI's Flows page renders this directly.
 */
import type { FastifyInstance } from 'fastify'
import type { SchemaDef } from '@loki/core'
import type { CursorEncoder } from '../security/cursor.js'
import * as v from '../security/validation.js'
import type { ReadEngine } from '../read-engine.js'
import { problem, resolveTenant } from './helpers.js'

export type FlowRouteContext = {
  readonly engine: ReadEngine
  readonly schema: SchemaDef
  readonly tenants: 'all' | readonly string[]
  readonly cursor: CursorEncoder
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60_000
const MAX_WINDOW_MS = 30 * 24 * 60 * 60_000

export function registerFlowRoutes(app: FastifyInstance, ctx: FlowRouteContext): void {
  // 1. Listing of every txn type with total + by-state counts.
  app.get('/api/v1/tenants/:tid/flows', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply

    const items = await Promise.all(
      ctx.schema.transactions.map(async (tx) => {
        const counts = await ctx.engine.dashboard.flowStates(t.id, tx.name)
        const total = counts.reduce((acc, c) => acc + c.count, 0)
        const byState = Object.fromEntries(counts.map((c) => [c.state, c.count]))
        return { txnType: tx.name, totalInstances: total, byState }
      }),
    )
    reply.header('Cache-Control', 'private, no-store')
    return { items }
  })

  // 2. State machine for one txn type.
  app.get('/api/v1/tenants/:tid/flows/:txnType', async (req, reply) => {
    const params = req.params as { tid?: string; txnType?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    const tt = v.txnType(params.txnType, ctx.schema)
    if (!tt.ok) return problem(reply, 404, 'unknown-txn-type', tt.reason)
    const def = ctx.schema.transactions.find((x) => x.name === tt.value)
    if (def === undefined) return problem(reply, 404, 'unknown-txn-type')

    const q = req.query as Record<string, string | undefined>
    let windowMs = DEFAULT_WINDOW_MS
    if (q['windowMs'] !== undefined) {
      const n = Number(q['windowMs'])
      if (!Number.isInteger(n) || n < 1_000 || n > MAX_WINDOW_MS) {
        return problem(reply, 400, 'bad-window', `windowMs must be 1000..${MAX_WINDOW_MS}`)
      }
      windowMs = n
    }

    const [stateCounts, transitionCounts] = await Promise.all([
      ctx.engine.dashboard.flowStates(t.id, tt.value),
      ctx.engine.dashboard.flowTransitionCounts(t.id, tt.value, windowMs),
    ])
    const stateCountMap = new Map(stateCounts.map((s) => [s.state, s.count]))
    const terminal = new Set(def.terminal as readonly string[])
    const transitionCountMap = new Map<string, { count: number; lastAt: string | null }>()
    for (const tc of transitionCounts) {
      transitionCountMap.set(tc.name, { count: tc.count, lastAt: tc.lastAt })
    }

    // Project the schema's static state machine + overlay live counts.
    const states = (def.states as readonly string[]).map((s) => ({
      name: s,
      count: stateCountMap.get(s) ?? 0,
      terminal: terminal.has(s),
      initial: s === def.initial,
    }))

    const transitions = Object.entries(def.transitions).map(([name, td]) => {
      // td is a TransitionDef; we extract the fields needed for rendering.
      const t2 = td as unknown as {
        from: string | readonly string[]
        to: string
        by?: readonly { name: string }[]
        needs?: string
        unlocks?: readonly string[]
        emit?: string
      }
      const live = transitionCountMap.get(name)
      const fromArr = Array.isArray(t2.from) ? t2.from : [t2.from]
      return {
        name,
        from: fromArr,
        to: t2.to,
        by: (t2.by ?? []).map((a) => a.name),
        needs: t2.needs ?? null,
        unlocks: [...(t2.unlocks ?? [])],
        emit: t2.emit ?? null,
        count: live?.count ?? 0,
        lastAt: live?.lastAt ?? null,
      }
    })

    reply.header('Cache-Control', 'private, no-store')
    return {
      txnType: tt.value,
      initial: def.initial,
      states,
      transitions,
      window: { ms: windowMs, end: new Date().toISOString() },
    }
  })

  // 3. Instances in a given state.
  app.get('/api/v1/tenants/:tid/flows/:txnType/instances', async (req, reply) => {
    const params = req.params as { tid?: string; txnType?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply
    const tt = v.txnType(params.txnType, ctx.schema)
    if (!tt.ok) return problem(reply, 404, 'unknown-txn-type', tt.reason)

    const q = req.query as Record<string, string | undefined>
    const limit = v.limit(q['limit'])
    if (!limit.ok) return problem(reply, 400, 'bad-limit', limit.reason)

    let stateFilter: string | undefined
    if (q['state'] !== undefined) {
      const r = v.state(q['state'], ctx.schema, tt.value)
      if (!r.ok) return problem(reply, 404, 'unknown-state', r.reason)
      stateFilter = r.value
    }

    const route = `flow-instances:${tt.value}`
    let innerCursor: string | undefined
    if (q['cursor'] !== undefined) {
      const dec = ctx.cursor.decode(route, q['cursor'])
      if (!dec.ok) return problem(reply, 400, 'bad-cursor', dec.reason)
      innerCursor = dec.inner
    }

    const client = ctx.engine.forTenant(t.id)
    const page = await client.queries.transactions.findMany({
      where: {
        type: tt.value,
        ...(stateFilter !== undefined ? { state: stateFilter } : {}),
      },
      limit: limit.value,
      ...(innerCursor !== undefined ? { cursor: innerCursor } : {}),
    })

    reply.header('Cache-Control', 'private, no-store')
    return {
      items: page.items.map((r) => ({
        id: r.id,
        state: r.state,
        version: r.version,
        compromised: r.compromised,
        createdBy: r.createdBy,
        participants: r.participants,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      nextCursor: page.nextCursor !== null ? ctx.cursor.encode(route, page.nextCursor) : null,
    }
  })
}
