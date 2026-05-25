/**
 * Per-route concurrency semaphore — DASHBOARD.md §8.13.
 *
 * Heavy `findMany` routes can dogpile the DB if many tabs are open at
 * once. We bound concurrency per route URL pattern (Fastify's matched
 * route, not the raw URL). Excess requests get `429`.
 *
 * Typical usage: register only on routes that touch the largest tables
 * (transitions, postings, anomaly findMany). The light per-tenant
 * rollups are fine under the global rate limit.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuditLog } from '../audit.js'
import { problem } from '../routes/helpers.js'

export type RouteSemaphoreOptions = {
  /** Max concurrent requests in this semaphore. Default 4. */
  readonly maxConcurrent?: number
}

export type RouteSemaphore = {
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  onResponse: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  inFlight(): number
}

declare module 'fastify' {
  interface FastifyRequest {
    _lokiSemSlot?: symbol
  }
}

/**
 * Build a semaphore + matching Fastify hooks. Attach via:
 *
 *   const sem = createRouteSemaphore(audit, 'transitions')
 *   app.get('/.../transitions',
 *     { preHandler: sem.preHandler, onResponse: sem.onResponse },
 *     handler)
 */
export function createRouteSemaphore(
  audit: AuditLog,
  routeLabel: string,
  opts: RouteSemaphoreOptions = {},
): RouteSemaphore {
  const max = opts.maxConcurrent ?? 4
  // Unique symbol per semaphore so a request can have slots for
  // multiple routes if it ever does (it won't, but defensive).
  const slotTag = Symbol(`sem:${routeLabel}`)
  let held = 0
  return {
    async preHandler(req, reply) {
      if (held >= max) {
        audit.append({
          reqId: req.id,
          event: 'route-busy',
          sourceIp: req.ip,
          detail: { route: routeLabel, inFlight: held },
        })
        reply.header('Retry-After', '1')
        problem(reply, 429, 'route-busy', `too many concurrent ${routeLabel}; try again`)
        return
      }
      held += 1
      req._lokiSemSlot = slotTag
    },
    async onResponse(req, _reply) {
      if (req._lokiSemSlot === slotTag && held > 0) {
        held -= 1
      }
    },
    inFlight: () => held,
  }
}
