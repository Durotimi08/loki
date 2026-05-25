/**
 * GET /api/v1/health — wraps `engine.health()` with a hard timeout.
 *
 * Responds 200 when the engine considers itself ok, 503 otherwise. The
 * payload is the full `HealthReport` either way — operators routinely
 * want to see *why* a probe is red.
 */
import type { FastifyInstance } from 'fastify'
import type { ReadEngine } from '../read-engine.js'

export function registerHealthRoute(app: FastifyInstance, engine: ReadEngine): void {
  app.get('/api/v1/health', async (_req, reply) => {
    const report = await engine.health({ timeoutMs: 2_000 })
    reply.code(report.ok ? 200 : 503)
    reply.header('Cache-Control', 'private, no-store')
    return report
  })
}
