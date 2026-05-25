/**
 * Auth wiring — DASHBOARD.md §8.4 / §8.5 / §8.6.
 *
 * Registers an `onRequest` resolver that:
 *   1. Reads the Authorization header (bearer or basic).
 *   2. Falls back to the session cookie when present.
 *   3. Decorates `req.session` with the resolved `SessionPayload` (or `null`).
 *
 * Routes that should enforce auth attach `requireAuth` as a `preHandler`.
 * Public routes (`/api/v1/health`, `/api/v1/version`) don't.
 *
 * For the `none` scheme, every request becomes anonymous — `req.session`
 * is a stable `{ subject: 'anonymous', scheme: 'none', … }`. M3
 * deliberately gates *production* deployments away from `none` via the
 * refusal matrix (§8.1); dev mode is free to skip auth entirely.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuditLog } from '../audit.js'
import { type BasicCredentials, type BasicVerifier, createBasicVerifier, parseBasicHeader } from './basic.js'
import { type BearerVerifier, createBearerVerifier } from './bearer.js'
import { parseCookieHeader, serializeCookie, sessionCookieName } from './cookie.js'
import { type SessionStore, createSessionStore } from './session.js'
import { type Throttle, createThrottle, type ThrottleOptions } from './throttle.js'
import type { Argon2Verify } from './basic.js'
import type { Secret } from './secret.js'
import type { AuthScheme, SessionPayload } from './types.js'

export type AuthWiring = {
  readonly scheme: AuthScheme
  readonly secret: Secret
  readonly audit: AuditLog
  /** Whether the dashboard is reachable over TLS — drives the `Secure` cookie flag. */
  readonly tls: boolean
  readonly throttle?: ThrottleOptions
  /** Inject argon2 verify — tests use a fast stub. Defaults to lazy real argon2. */
  readonly argon2Verify?: Argon2Verify
  /** Override clock. Tests use this to advance time. */
  readonly now?: () => number
  /** Idle session timeout (ms). */
  readonly sessionIdleMs?: number
  /** Absolute session lifetime (ms). */
  readonly sessionAbsoluteMs?: number
}

export type AuthSurface = {
  readonly sessionStore: SessionStore
  readonly throttle: Throttle
  /** Pre-handler that enforces the configured scheme on a route. */
  readonly requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
}

const ANON: SessionPayload = {
  subject: 'anonymous',
  scheme: 'none',
  sid: 'anon',
  csrf: 'anon',
  issuedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
}

export function registerAuth(app: FastifyInstance, w: AuthWiring): AuthSurface {
  const now = w.now ?? Date.now
  const sessionStore = createSessionStore({
    secret: w.secret,
    ...(w.sessionIdleMs !== undefined ? { idleMs: w.sessionIdleMs } : {}),
    ...(w.sessionAbsoluteMs !== undefined ? { absoluteMs: w.sessionAbsoluteMs } : {}),
    now,
  })
  const throttle = createThrottle({
    ...(w.throttle?.perIp !== undefined ? { perIp: w.throttle.perIp } : {}),
    ...(w.throttle?.perUser !== undefined ? { perUser: w.throttle.perUser } : {}),
    now,
  })

  const bearer: BearerVerifier | null =
    w.scheme.kind === 'bearer' ? createBearerVerifier(w.scheme.token) : null
  const basic: BasicVerifier | null =
    w.scheme.kind === 'basic'
      ? createBasicVerifier({
          user: w.scheme.user,
          argon2Hash: w.scheme.argon2Hash,
          ...(w.argon2Verify !== undefined ? { verifyImpl: w.argon2Verify } : {}),
        })
      : null

  const cookieName = sessionCookieName(w.tls)

  // Resolve a session for every request. We don't reject here — that's
  // the route-level `requireAuth`'s job. Decorating `null` means
  // "anonymous", decorating a payload means "authenticated".
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (w.scheme.kind === 'none') {
      req.session = ANON
      return
    }
    // Cookie path first — cheap.
    const cookies = parseCookieHeader(req.headers['cookie'])
    const raw = cookies[cookieName]
    if (raw !== undefined) {
      const res = sessionStore.validate(raw)
      if (res.ok) {
        req.session = res.payload
        return
      }
    }
    // Header path — bearer is stateless, basic verifies + mints session.
    const authz = req.headers['authorization']
    if (bearer !== null && typeof authz === 'string' && authz.startsWith('Bearer ')) {
      if (bearer.verify(authz)) {
        // Stateless — no session minted. The route handler sees
        // `req.session = null` and falls through `requireAuth` because
        // bearer is also handled there directly.
        // We still expose the subject via a one-shot anonymous payload.
        req.session = {
          subject: bearer.subject,
          scheme: 'bearer',
          sid: 'stateless',
          csrf: 'stateless',
          issuedAt: now(),
          expiresAt: now() + 60_000,
        }
        return
      }
    }
    if (basic !== null && typeof authz === 'string' && authz.startsWith('Basic ')) {
      const creds = parseBasicHeader(authz)
      const verdict = throttle.check(req.ip, creds?.user ?? null)
      if (!verdict.allowed) {
        w.audit.append({
          reqId: req.id,
          event: 'auth.throttle',
          sourceIp: req.ip,
          detail: { key: verdict.key, retryAfterMs: verdict.retryAfterMs },
        })
        req.session = null
        return
      }
      const subject = await basic.verify(creds)
      if (subject !== null) {
        throttle.recordSuccess(req.ip, creds?.user ?? null)
        const { payload } = sessionStore.mint({ subject, scheme: 'basic' })
        req.session = payload
        return
      }
      throttle.recordFailure(req.ip, creds?.user ?? null)
      w.audit.append({
        reqId: req.id,
        event: 'auth.deny',
        sourceIp: req.ip,
        detail: { scheme: 'basic' },
      })
      req.session = null
      return
    }
    req.session = null
  })

  // After the handler runs, if we minted a fresh session payload we
  // need to set the cookie. Detect "minted on this request" by checking
  // for the basic scheme + a stateless sentinel: if `sid !== 'stateless'`
  // and there was no incoming cookie of the same name, mint.
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload) => {
    const s = req.session
    if (s === undefined || s === null) return payload
    if (s.scheme === 'none' || s.scheme === 'bearer') return payload
    const cookies = parseCookieHeader(req.headers['cookie'])
    const had = cookies[cookieName]
    // First success on a basic request → Set-Cookie.
    if (had === undefined) {
      const cookieValue = sessionStore.refresh(s).cookieValue
      reply.header(
        'set-cookie',
        serializeCookie(cookieName, cookieValue, {
          httpOnly: true,
          secure: w.tls,
          sameSite: 'Strict',
          path: '/',
          maxAgeSec: Math.floor((s.expiresAt - now()) / 1000),
        }),
      )
    }
    return payload
  })

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (w.scheme.kind === 'none') return
    if (req.session !== undefined && req.session !== null) return
    w.audit.append({
      reqId: req.id,
      event: 'auth.unauthorized',
      sourceIp: req.ip,
      detail: { scheme: w.scheme.kind, path: req.url },
    })
    reply
      .code(401)
      .type('application/problem+json')
      .header('WWW-Authenticate', w.scheme.kind === 'bearer' ? 'Bearer realm="loki"' : 'Basic realm="loki"')
      .header('Cache-Control', 'private, no-store')
      .send({
        type: 'https://loki.dev/problems/unauthorized',
        title: 'Unauthorized',
        status: 401,
      })
  }

  return { sessionStore, throttle, requireAuth }
}

export type { AuthScheme, SessionPayload } from './types.js'
export type { Secret } from './secret.js'
export { loadSessionSecret } from './secret.js'
export { checkCsrf, sendCsrfFailure } from './csrf.js'
export { DUMMY_HASH, type Argon2Verify } from './basic.js'

type _Used<T> = T
type _ = _Used<BasicCredentials>
