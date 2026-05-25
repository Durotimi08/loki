/**
 * GET /api/v1/tenants                  — list
 * GET /api/v1/tenants/:tid             — metadata
 * GET /api/v1/tenants/:tid/summary     — rollup (counts, anomalies, outbox, scheduler)
 *
 * Per-tenant routes go through `resolveTenant()` (slug → allowlist →
 * `engine.admin.tenants.get`) so the route never enumerates and never
 * runs a downstream query against a non-existent tenant.
 */
import type { FastifyInstance } from 'fastify'
import type { ReadEngine } from '../read-engine.js'
import { problem, resolveTenant } from './helpers.js'

export function registerTenantRoutes(
  app: FastifyInstance,
  engine: ReadEngine,
  tenants: 'all' | readonly string[],
): void {
  app.get('/api/v1/tenants', async (_req, reply) => {
    const all = await engine.admin.tenants.list()
    const filtered = tenants === 'all' ? all : all.filter((t) => tenants.includes(t.id))
    reply.header('Cache-Control', 'private, no-store')
    return {
      items: filtered.map((t) => ({
        id: t.id,
        name: t.name,
        mode: t.mode,
        state: t.state,
        createdAt: t.createdAt.toISOString(),
      })),
    }
  })

  app.get('/api/v1/tenants/:tid', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(engine, tenants, reply, params.tid)
    if (t === null) return reply
    reply.header('Cache-Control', 'private, no-store')
    return {
      id: t.row.id,
      name: t.row.name,
      mode: t.row.mode,
      state: t.row.state,
      createdAt: t.row.createdAt.toISOString(),
    }
  })

  app.get('/api/v1/tenants/:tid/summary', async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(engine, tenants, reply, params.tid)
    if (t === null) return reply
    try {
      const summary = await engine.dashboard.tenantSummary(t.id)
      const versions = await engine.admin.schema.versions(t.id)
      reply.header('Cache-Control', 'private, no-store')
      return {
        tenant: {
          id: t.row.id,
          name: t.row.name,
          mode: t.row.mode,
          state: t.row.state,
          createdAt: t.row.createdAt.toISOString(),
        },
        ...summary,
        schemaVersions: versions,
      }
    } catch (e) {
      return problem(
        reply,
        503,
        'summary-unavailable',
        e instanceof Error ? e.message : String(e),
      )
    }
  })
}
