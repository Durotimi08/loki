/**
 * Request smuggling and resource-exhaustion guards — DASHBOARD.md §8.8,
 * §8.13, T18 / T19.
 *
 * Fastify carries most of the body / header / timeout limits as
 * construction options; we centralise them here so a single review
 * touches one file. The smuggling guard is a separate `onRequest` hook
 * because it inspects the raw header set: any request that combines
 * `Transfer-Encoding` with `Content-Length`, duplicates `Content-Length`,
 * or uses a non-`chunked` `Transfer-Encoding` is rejected `400`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify'
import type { AuditLog } from '../audit.js'

export const FASTIFY_LIMITS: FastifyServerOptions = {
  bodyLimit: 64 * 1024, // 64 KB — POSTs carry tiny action bodies; reads have no body
  connectionTimeout: 10_000,
  keepAliveTimeout: 5_000,
  requestTimeout: 30_000,
  disableRequestLogging: true,
  maxParamLength: 200,
  trustProxy: false,
  // Node's HTTP parser caps header size at 16 KB by default; Fastify
  // doesn't expose that directly. If we ever need to lower it, set
  // NODE_OPTIONS=--max-http-header-size=<N> or use a custom server.
}

export function registerSmugglingGuard(app: FastifyInstance, audit: AuditLog): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const headers = req.raw.headers
    const te = headers['transfer-encoding']
    const cl = headers['content-length']

    // 1. Duplicate Content-Length is unambiguous abuse.
    if (Array.isArray(cl) && cl.length > 1) return badRequest(audit, req, reply, 'cl-duplicate')
    if (typeof cl === 'string' && /,/.test(cl)) {
      return badRequest(audit, req, reply, 'cl-multi-value')
    }

    // 2. TE + CL simultaneously is the canonical smuggling smell —
    //    different proxies pick different framings.
    if (te !== undefined && cl !== undefined) {
      return badRequest(audit, req, reply, 'te-and-cl')
    }

    // 3. TE other than `chunked` is forbidden. Spec only allows
    //    `chunked`, `compress`, `deflate`, `gzip`, `identity`; we
    //    don't accept compressed bodies on this surface.
    if (te !== undefined) {
      const normalized = Array.isArray(te)
        ? te.join(',').toLowerCase()
        : String(te).toLowerCase()
      const tokens = normalized.split(',').map((s) => s.trim()).filter(Boolean)
      for (const t of tokens) {
        if (t !== 'chunked') return badRequest(audit, req, reply, `te-bad:${t}`)
      }
    }

    return undefined
  })
}

function badRequest(
  audit: AuditLog,
  req: FastifyRequest,
  reply: FastifyReply,
  reason: string,
): FastifyReply {
  audit.append({
    reqId: req.id,
    event: 'smuggling.deny',
    sourceIp: req.ip,
    detail: { reason, path: req.url, method: req.method },
  })
  reply
    .code(400)
    .type('application/problem+json')
    .header('Cache-Control', 'private, no-store')
    .send({
      type: 'https://loki.dev/problems/bad-request',
      title: 'Bad Request',
      status: 400,
    })
  return reply
}
