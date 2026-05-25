/**
 * Security baseline wiring — DASHBOARD.md §8.
 *
 * Registers every M2 hook on the Fastify instance in the correct order
 * (matching the lifecycle diagram at the top of §8). The order matters:
 * cheaper checks fire first, refusals short-circuit later hooks.
 *
 *   onRequest:
 *     1. Host allowlist          (T4, hashset lookup)
 *     2. Fetch-Metadata + Origin (T5, header inspection)
 *     3. CORS preflight deny     (T5, method == OPTIONS)
 *     4. Smuggling guard         (T19, header sanity)
 *     5. Rate limit              (T17/T18, in-process LRU)
 *   onSend:
 *     6. Security headers        (T9/T14/T29/T30)
 *   error handlers:
 *     7. Problem+json + 404 body (T28)
 */
import type { FastifyInstance } from 'fastify'
import type { Logger as LokiLogger } from '@loki/core'
import type { AuditLog } from '../audit.js'
import { registerHostAllowlist, type HostAllowlist } from './host-allowlist.js'
import { type FetchMetadataOptions, registerFetchMetadata } from './fetch-metadata.js'
import { registerCorsDeny } from './cors.js'
import { registerSmugglingGuard } from './body-limits.js'
import { registerRateLimit, type RateLimitOptions } from '../rate-limit.js'
import { registerSecurityHeaders, type SecurityHeadersOptions } from './headers.js'
import { registerProblemHandler } from './problem.js'

export type SecurityWiring = {
  readonly allowlist: HostAllowlist
  readonly audit: AuditLog
  readonly logger: LokiLogger
  readonly rateLimit?: RateLimitOptions
  readonly headers: SecurityHeadersOptions
  /** Tighten Sec-Fetch when auth is on (DASHBOARD.md §8.3). */
  readonly fetchMetadata?: FetchMetadataOptions
}

export function registerSecurity(app: FastifyInstance, w: SecurityWiring): void {
  registerHostAllowlist(app, w.allowlist, w.audit)
  // CORS deny fires before fetch-metadata so an OPTIONS preflight is
  // always recorded as `cors.preflight-deny` (not as an Origin refusal).
  registerCorsDeny(app, w.audit)
  registerFetchMetadata(app, w.allowlist, w.audit, w.fetchMetadata ?? {})
  registerSmugglingGuard(app, w.audit)
  registerRateLimit(app, w.audit, w.rateLimit ?? {})
  registerSecurityHeaders(app, w.headers)
  registerProblemHandler(app, w.logger)
}
