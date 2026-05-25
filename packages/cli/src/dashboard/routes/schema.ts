/**
 * GET /api/v1/schema                          — static schema description
 * GET /api/v1/tenants/:tid/schema/versions    — per-tenant schema versions
 *
 * The static schema description is also surfaced via `/api/v1/version`
 * as a fingerprint; the full description here is what the UI consumes
 * to render the Schema and Flows pages (M7).
 */
import type { FastifyInstance } from 'fastify'
import type { SchemaDef } from '@loki/core'
import { describeSchema } from '../schema-fingerprint.js'
import type { ReadEngine } from '../read-engine.js'
import * as v from '../security/validation.js'
import { problem } from './helpers.js'

export function registerSchemaRoutes(
  app: FastifyInstance,
  engine: ReadEngine,
  schema: SchemaDef,
  tenants: 'all' | readonly string[],
): void {
  const payload = describeSchema(schema)

  app.get('/api/v1/schema', async (_req, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    return payload
  })

  app.get('/api/v1/tenants/:tid/schema/versions', async (req, reply) => {
    const params = req.params as { tid?: string }
    const tid = v.tenantId(params.tid)
    if (!tid.ok) return problem(reply, 400, 'bad-tenant-id', tid.reason)
    const allowed = v.tenantInAllowlist(tid.value, tenants)
    if (!allowed.ok) return problem(reply, 404, 'tenant-not-found', 'not in allowlist')
    const t = await engine.admin.tenants.get(tid.value)
    if (t === null) return problem(reply, 404, 'tenant-not-found')
    const versions = await engine.admin.schema.versions(tid.value)
    reply.header('Cache-Control', 'private, no-store')
    return { items: versions }
  })
}
