/**
 * Response security headers — DASHBOARD.md §8.7.
 *
 * Applied as a single `onSend` hook so every response — including 4xx
 * and 5xx — carries the full set. We deliberately use `default-src
 * 'none'` and enumerate every source: no inline scripts, no
 * `unsafe-eval`, no `data:` for scripts, no wildcards.
 *
 * `Cache-Control: private, no-store` is the default; routes that serve
 * hashed static assets can override (set on the reply directly in their
 * own handlers — Fastify keeps a route-level value over a hook-level
 * one only if the hook checks for it; we check below).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const DEFAULT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "require-trusted-types-for 'script'",
  'trusted-types loki-dash',
].join('; ')

const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'microphone=()',
  'payment=()',
  'usb=()',
  'magnetometer=()',
  'gyroscope=()',
].join(', ')

export type SecurityHeadersOptions = {
  /** Override the default CSP. Use with care. */
  readonly csp?: string
  /** Add `Strict-Transport-Security` when the server is behind TLS. */
  readonly tls: boolean
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  opts: SecurityHeadersOptions,
): void {
  const csp = opts.csp ?? DEFAULT_CSP

  app.addHook('onSend', async (_req: FastifyRequest, reply: FastifyReply, payload) => {
    // Identifying / fingerprinting headers — strip if any upstream set them.
    reply.removeHeader('server')
    reply.removeHeader('x-powered-by')

    setIfAbsent(reply, 'content-security-policy', csp)
    setIfAbsent(reply, 'x-content-type-options', 'nosniff')
    setIfAbsent(reply, 'x-frame-options', 'DENY')
    setIfAbsent(reply, 'referrer-policy', 'no-referrer')
    setIfAbsent(reply, 'permissions-policy', PERMISSIONS_POLICY)
    setIfAbsent(reply, 'cross-origin-opener-policy', 'same-origin')
    setIfAbsent(reply, 'cross-origin-resource-policy', 'same-origin')
    setIfAbsent(reply, 'cross-origin-embedder-policy', 'require-corp')
    setIfAbsent(reply, 'cache-control', 'private, no-store')
    setIfAbsent(reply, 'vary', 'Cookie, Authorization')

    if (opts.tls) {
      setIfAbsent(reply, 'strict-transport-security', 'max-age=31536000; includeSubDomains')
    }
    return payload
  })
}

function setIfAbsent(reply: FastifyReply, name: string, value: string): void {
  const existing = reply.getHeader(name)
  if (existing === undefined || existing === null) {
    reply.header(name, value)
  }
}
