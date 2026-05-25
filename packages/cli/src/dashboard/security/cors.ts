/**
 * CORS denial — DASHBOARD.md §8.3, T5.
 *
 * The dashboard is same-origin only. We never emit any
 * `Access-Control-Allow-*` headers. Cross-origin browsers see no CORS
 * permission and refuse to read the response themselves.
 *
 * `OPTIONS` preflights are answered with `403 Forbidden`. We deliberately
 * 403 (not 405): we want it to be obvious from logs that someone tried
 * a cross-origin preflight, and 403 makes the rejection cacheable as a
 * negative result by sane clients.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuditLog } from '../audit.js'

export function registerCorsDeny(app: FastifyInstance, audit: AuditLog): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'OPTIONS') return undefined
    audit.append({
      reqId: req.id,
      event: 'cors.preflight-deny',
      sourceIp: req.ip,
      detail: { path: req.url, origin: req.headers['origin'] ?? null },
    })
    reply
      .code(403)
      .type('application/problem+json')
      .header('Cache-Control', 'private, no-store')
      .send({
        type: 'https://loki.dev/problems/cors-denied',
        title: 'CORS preflight denied',
        status: 403,
        detail: 'This dashboard is same-origin only.',
      })
    return reply
  })
}
