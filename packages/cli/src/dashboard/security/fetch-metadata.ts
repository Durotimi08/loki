/**
 * Sec-Fetch-Site / Sec-Fetch-Mode / Sec-Fetch-Dest enforcement —
 * DASHBOARD.md §8.3, T5. Pairs with the Host allowlist (§8.2) to
 * fully shut the cross-origin-from-localhost attack.
 *
 * Modern browsers attach `Sec-Fetch-*` headers to every request. They
 * cannot be set or overridden by JS. So if a malicious tab on
 * `evil.example` tries `fetch('http://127.0.0.1:4488/api/...')`, the
 * browser stamps `Sec-Fetch-Site: cross-site` and we 403.
 *
 * Non-browser clients (curl, fetch-from-Node, CI tools) don't send
 * Sec-Fetch headers. When the dashboard's auth scheme is `none` we
 * still allow absent (dev mode). When auth is configured, absent →
 * the caller MUST present `Authorization: Bearer ...` — that's how we
 * tell a curl-with-token call apart from a no-Sec-Fetch browser.
 *
 * `Origin` (when present) is also checked against the configured host
 * allowlist as a belt-and-braces second line; older browsers that lack
 * Sec-Fetch-* still send Origin on CORS-style requests.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { HostAllowlist } from './host-allowlist.js'
import type { AuditLog } from '../audit.js'

const SEC_FETCH_SITE_OK = new Set(['same-origin', 'none'])

export type FetchMetadataOptions = {
  /** When true, missing `Sec-Fetch-Site` is only OK if `Authorization` is set. */
  readonly strictWhenAuth?: boolean
  /**
   * URLs (path prefixes) where the strict-when-auth rule does NOT apply.
   * Default: `/api/v1/health` and `/api/v1/version` — those are
   * liveness probes operators want reachable from anywhere.
   */
  readonly publicPaths?: readonly string[]
}

const DEFAULT_PUBLIC_PATHS = ['/api/v1/health', '/api/v1/version']

export function registerFetchMetadata(
  app: FastifyInstance,
  allowlist: HostAllowlist,
  audit: AuditLog,
  opts: FetchMetadataOptions = {},
): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const fetchSite = headerOf(req, 'sec-fetch-site')
    if (fetchSite !== undefined && !SEC_FETCH_SITE_OK.has(fetchSite)) {
      audit.append({
        reqId: req.id,
        event: 'fetch-metadata.deny',
        sourceIp: req.ip,
        detail: { secFetchSite: fetchSite, path: req.url },
      })
      return forbid(reply)
    }

    if (fetchSite === undefined && opts.strictWhenAuth === true) {
      const publicPaths = opts.publicPaths ?? DEFAULT_PUBLIC_PATHS
      const path = req.url.split('?')[0] ?? req.url
      const isPublic = publicPaths.some((p) => path === p || path.startsWith(`${p}/`))
      if (!isPublic) {
        const auth = headerOf(req, 'authorization')
        const cookie = headerOf(req, 'cookie')
        if (auth === undefined && cookie === undefined) {
          audit.append({
            reqId: req.id,
            event: 'fetch-metadata.absent-no-auth',
            sourceIp: req.ip,
            detail: { path: req.url },
          })
          return forbid(reply)
        }
      }
    }

    const origin = headerOf(req, 'origin')
    if (origin !== undefined && origin !== 'null') {
      const stripped = stripScheme(origin).toLowerCase()
      if (!allowlist.accepted.has(stripped)) {
        audit.append({
          reqId: req.id,
          event: 'fetch-metadata.origin-deny',
          sourceIp: req.ip,
          detail: { origin, path: req.url },
        })
        return forbid(reply)
      }
    }
    return undefined
  })
}

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name]
  if (typeof raw === 'string') return raw.toLowerCase().trim()
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].toLowerCase().trim()
  return undefined
}

/** `https://dashboard.example:4488` → `dashboard.example:4488` */
function stripScheme(origin: string): string {
  const idx = origin.indexOf('://')
  return idx === -1 ? origin : origin.slice(idx + 3)
}

function forbid(reply: FastifyReply): FastifyReply {
  reply
    .code(403)
    .type('application/problem+json')
    .header('Cache-Control', 'private, no-store')
    .send({
      type: 'https://loki.dev/problems/forbidden',
      title: 'Forbidden',
      status: 403,
    })
  return reply
}
