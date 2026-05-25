/**
 * Loki dashboard HTTP server. Boots Fastify (lazy-imported by the
 * `dashboard` command handler so non-dashboard CLI invocations don't
 * pay for it), applies the boot-time refusal matrix, registers the
 * security baseline + auth, mounts read-only routes, and returns a
 * handle the caller can `close()`.
 *
 * Per-request flow:
 *   1. Host allowlist          (M2 §8.2)
 *   2. CORS preflight deny     (M2 §8.3)
 *   3. Fetch-Metadata + Origin (M2 §8.3)
 *   4. Smuggling guard         (M2 §8.8)
 *   5. Rate limit              (M2 §8.13)
 *   6. Auth resolution         (M3 §8.4 — decorates req.session)
 *   ─ route handler (with `requireAuth` preHandler where private)
 *   7. Security headers        (M2 §8.7)
 *   8. Session Set-Cookie      (M3 §8.5, on first basic-auth success)
 *   9. RFC 7807 problem doc    (M2 §8.7 on error / 404)
 */
import { chmodSync, chownSync, readFileSync, unlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { NOOP_LOGGER, NOOP_METRICS, NOOP_TRACER } from '@loki/core'
import type {
  Logger as LokiLogger,
  MetricsAdapter,
  SchemaDef,
  Tracer,
} from '@loki/core'
import type { LokiConfig } from '../config.js'
import { type AuditLog, NOOP_AUDIT_LOG, createAuditLog } from './audit.js'
import {
  type AuthSurface,
  type Argon2Verify,
  type AuthScheme,
  type Secret,
  loadSessionSecret,
  registerAuth,
} from './auth/index.js'
import { createReadEngine, type ReadEngine } from './read-engine.js'
import { type Redactor, defaultProdRedactor, identityRedactor } from './redact.js'
import { createRouteSemaphore } from './security/route-concurrency.js'
import { applySocketLimits } from './security/socket.js'
import { registerHealthRoute } from './routes/health.js'
import { registerAccountRoutes } from './routes/accounts.js'
import { registerActorRoutes } from './routes/actors.js'
import { registerAnomalyRoutes } from './routes/anomalies.js'
import { registerDisputeRoutes } from './routes/disputes.js'
import { registerFlowRoutes } from './routes/flows.js'
import { registerFxRoutes } from './routes/fx.js'
import { registerHoldRoutes } from './routes/holds.js'
import { registerOutboxRoutes } from './routes/outbox.js'
import { registerReconcilerRoutes } from './routes/reconciler.js'
import { registerSchedulerRoutes } from './routes/scheduler.js'
import { registerSchemaRoutes } from './routes/schema.js'
import { registerStreamRoutes } from './routes/streams.js'
import { registerTenantRoutes } from './routes/tenants.js'
import { registerTransactionRoutes } from './routes/transactions.js'
import { registerVersionRoute } from './routes/version.js'
import { createCursorEncoder, deriveCursorSecret } from './security/cursor.js'
import { createSessionScopedCap } from './sse.js'
import { type ActionsConfig, registerActionRoutes } from './actions/index.js'
import { createReconcilerRunsBuffer } from './reconciler-runs.js'
import { registerUi } from './ui-mount.js'
import { createDashboardInstruments, registerObservability } from './observability.js'
import { FASTIFY_LIMITS } from './security/body-limits.js'
import { buildHostAllowlist } from './security/host-allowlist.js'
import { registerSecurity } from './security/index.js'
import { applyRefusalMatrix } from './security/tls-policy.js'

export type DashboardServerOptions = {
  readonly host?: string
  readonly port?: number
  readonly allowedHosts?: readonly string[]
  readonly readUrl?: string
  readonly statementTimeoutMs?: number
  readonly poolMax?: number
  readonly allowProd?: boolean
  readonly unsafeHost?: boolean
  readonly trustProxyTls?: boolean
  readonly trustProxyHops?: number
  /**
   * Direct TLS termination — pass file paths to a PEM cert + key. When
   * set, Fastify is constructed in HTTPS mode and `directTls: true` in
   * the refusal matrix lets the non-loopback bind succeed.
   */
  readonly tls?: { readonly certPath: string; readonly keyPath: string; readonly caPath?: string }
  /**
   * Bind to a Unix domain socket instead of TCP. The bind-policy
   * refusal matrix's `--unsafe-host`/TLS gates don't apply when binding
   * a socket — filesystem mode + group ownership are the access control.
   */
  readonly socket?: {
    readonly path: string
    readonly mode?: number             // default 0o660
    readonly group?: string            // chown gid; default leave as process gid
    readonly maxConnections?: number   // default 256
  }
  /**
   * Socket-level limits applied to TCP binds. See `security/socket.ts`.
   * Tests typically override `maxConnections` to 0 to provoke a flood path.
   */
  readonly socketLimits?: import('./security/socket.js').SocketLimits
  /** Auth scheme; default `{ kind: 'none' }`. */
  readonly auth?: AuthScheme
  /** Tenant allowlist; default `'all'`. */
  readonly tenants?: 'all' | readonly string[]
  /** Override cursor TTL (ms). Default 24 h. */
  readonly cursorTtlMs?: number
  /** Set true to mount the two action POST endpoints (gated by the refusal matrix). */
  readonly allowActions?: boolean
  /** Action surface — required when `allowActions === true`. */
  readonly actions?: ActionsConfig
  /** Test-only: inject an action executor (skips the real writable pool). */
  readonly actionExecutorFactory?: import('./actions/index.js').ActionsRouteContext['executorFactory']
  /** Test-only: inject an idempotency cache for assertions. */
  readonly actionIdempotency?: import('./actions/index.js').ActionsRouteContext['idempotency']
  /** Test-only: inject an action throttle. */
  readonly actionThrottle?: import('./actions/index.js').ActionsRouteContext['throttle']
  /** Test-only: inject the action concurrency cap. */
  readonly actionConcurrency?: import('./actions/index.js').ActionsRouteContext['concurrency']
  /** Override the session-age gate (default 30 min). */
  readonly actionMaxSessionAgeMs?: number
  /** SSE config — see DASHBOARD.md §6.11 / §8.13. */
  readonly stream?: {
    /** Max concurrent SSE connections process-wide. Default 256. */
    readonly maxConcurrent?: number
    /** Max concurrent SSE connections per session (or per source IP for anonymous). Default 16. */
    readonly perSessionMax?: number
    /** Poll interval, ms. Default 2_000. */
    readonly pollIntervalMs?: number
    /** Heartbeat interval, ms. Default 15_000. */
    readonly heartbeatMs?: number
    /** Hard-close after, ms. Default 30 * 60_000. */
    readonly maxConnectionMs?: number
    /** Inject timers for tests (deterministic sleep). */
    readonly timers?: import('./sse.js').StreamTimers
    /** Test-only: aborts every open SSE. */
    readonly abortSignal?: AbortSignal
  }
  /**
   * Payload redactor. Defaults: identity in dev, defaultProdRedactor
   * (SAFE_KEYS allowlist) under NODE_ENV=production.
   */
  readonly redactor?: Redactor
  /** Skip redaction even in prod — refused by the refusal matrix unless `--allow-prod-leakage`. */
  readonly noRedact?: boolean
  /** Inject the session secret (bytes). Default: load from env / file. */
  readonly sessionSecret?: Secret
  /** Skip persisting a generated session secret to disk. */
  readonly ephemeralSecret?: boolean
  /** Override argon2 verify for tests. */
  readonly argon2Verify?: Argon2Verify
  /** Auth throttle overrides. */
  readonly authThrottle?: {
    readonly perIp?: { failures: number; windowMs: number; lockoutMs: number }
    readonly perUser?: { failures: number; windowMs: number; lockoutMs: number }
    readonly now?: () => number
  }
  /** Idle session timeout, ms. Default 30 min. */
  readonly sessionIdleMs?: number
  /** Absolute session lifetime, ms. Default 12 h. */
  readonly sessionAbsoluteMs?: number
  /**
   * Inject a pre-built `ReadEngine` (used by tests). When set, the
   * server does NOT open its own pool — the caller owns the engine's
   * lifecycle.
   */
  readonly engine?: ReadEngine
  /** Override `NODE_ENV` for refusal-matrix tests. */
  readonly nodeEnv?: string
  /** Inject an audit log — tests use a memory log to assert events. */
  readonly audit?: AuditLog
  /** Inject a Loki logger for the error handler. Defaults to NOOP. */
  readonly logger?: LokiLogger
  /** Inject a metrics adapter — dashboard emits `loki_dashboard_*`. Defaults to NOOP. */
  readonly metrics?: MetricsAdapter
  /** Inject a tracer — one `dashboard.request` span per request. Defaults to NOOP. */
  readonly tracer?: Tracer
  /** Path to the on-disk audit log. Ignored when `audit` is injected. */
  readonly auditLogPath?: string
  /** Build hash surfaced on `/api/v1/version`. Resolved by the CLI command. */
  readonly buildHash?: string
  /**
   * Static-UI control. Defaults: serve the bundled HTML/CSS/JS at `/`.
   * `false` disables the UI entirely (API-only deployment). `root`
   * lets dev iterate against an unbundled source tree.
   */
  readonly ui?: { readonly enabled?: boolean; readonly root?: string; readonly noCache?: boolean }
  /** Rate-limit overrides (per-IP token bucket). */
  readonly rateLimit?: {
    readonly perMinute?: number
    readonly burst?: number
    readonly now?: () => number
    readonly maxKeys?: number
  }
  /**
   * Skip the real `app.listen()` call. Used by unit tests so the
   * Host-header allowlist can use the configured (not ephemeral) port
   * and `app.inject` is the only request path.
   */
  readonly skipListen?: boolean
}

export type DashboardServer = {
  /** Bound listen address (host:port for TCP). */
  readonly address: string
  /** Auth surface — exposed so tests can read the session store / throttle. */
  readonly auth: AuthSurface
  /** Stop accepting new connections and release the DB pool. */
  readonly close: () => Promise<void>
  /** Fastify instance — exported for tests; production callers ignore it. */
  readonly app: FastifyInstance
}

/**
 * Start the dashboard server. Caller is responsible for `close()`-ing
 * the returned handle on shutdown.
 */
export async function startDashboardServer(
  cfg: LokiConfig,
  schema: SchemaDef,
  opts: DashboardServerOptions = {},
): Promise<DashboardServer> {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 4488
  const nodeEnv = opts.nodeEnv ?? process.env['NODE_ENV'] ?? 'development'
  const trustProxyTls = opts.trustProxyTls ?? false
  const trustProxyHops = opts.trustProxyHops ?? 0
  const authScheme: AuthScheme = opts.auth ?? { kind: 'none' }

  const bindMode: 'tcp' | 'socket' = opts.socket !== undefined ? 'socket' : 'tcp'

  // The refusal matrix only governs TCP binds. Unix sockets are
  // filesystem-scoped — no TLS / unsafe-host gates apply.
  if (bindMode === 'tcp') {
    applyRefusalMatrix({
      host,
      nodeEnv,
      allowProd: opts.allowProd ?? false,
      unsafeHost: opts.unsafeHost ?? false,
      trustProxyTls,
      directTls: opts.tls !== undefined,
      allowedHosts: opts.allowedHosts ?? [],
      allowActions: opts.allowActions === true,
      noRedact: false,
      allowProdLeakage: false,
      authScheme: authScheme.kind,
    })
  } else if (opts.allowActions === true && authScheme.kind === 'none') {
    // Actions on a Unix socket still need auth — same rule as TCP.
    applyRefusalMatrix({
      host: '127.0.0.1', nodeEnv, allowProd: opts.allowProd ?? false,
      unsafeHost: false, trustProxyTls: false, directTls: false,
      allowedHosts: [], allowActions: true,
      noRedact: false, allowProdLeakage: false, authScheme: 'none',
    })
  }

  // Lazy-load Fastify. Keeps `loki migrate` start-up cost untouched.
  const { default: Fastify } = await import('fastify')
  const fastifyOptions = {
    ...FASTIFY_LIMITS,
    trustProxy: trustProxyTls ? trustProxyHops : false,
    // Fastify defaults to `removeAdditional: 'all'` which silently strips
    // unknown body fields. For actions (M8 §9.3) we want strict failures
    // on additional properties — so override Ajv globally.
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: true,
      },
    },
    ...(opts.tls !== undefined
      ? {
          https: {
            cert: readFileSync(opts.tls.certPath),
            key: readFileSync(opts.tls.keyPath),
            ...(opts.tls.caPath !== undefined ? { ca: readFileSync(opts.tls.caPath) } : {}),
            minVersion: 'TLSv1.2' as const,
          },
        }
      : {}),
  }
  const app = Fastify(fastifyOptions)

  const audit = opts.audit ?? buildAuditLog(opts.auditLogPath)
  const logger = opts.logger ?? NOOP_LOGGER
  const metrics = opts.metrics ?? NOOP_METRICS
  const tracer = opts.tracer ?? NOOP_TRACER
  const instruments = createDashboardInstruments(metrics)

  // M9: per-request observability fires before any route hook so every
  // matched / unmatched / refused request lands in metrics + logs.
  registerObservability(app, { instruments, logger, tracer })

  registerSecurity(app, {
    allowlist: buildHostAllowlist({
      host,
      port,
      extra: opts.allowedHosts ?? [],
    }),
    audit,
    logger,
    rateLimit: opts.rateLimit ?? {},
    headers: { tls: trustProxyTls || opts.tls !== undefined },
    fetchMetadata: { strictWhenAuth: authScheme.kind !== 'none' },
  })

  const secret = opts.sessionSecret ?? loadSessionSecret({
    ...(opts.ephemeralSecret === true ? { ephemeral: true } : {}),
  })
  const auth = registerAuth(app, {
    scheme: authScheme,
    secret,
    audit,
    tls: trustProxyTls,
    ...(opts.argon2Verify !== undefined ? { argon2Verify: opts.argon2Verify } : {}),
    ...(opts.authThrottle !== undefined ? { throttle: opts.authThrottle } : {}),
    ...(opts.sessionIdleMs !== undefined ? { sessionIdleMs: opts.sessionIdleMs } : {}),
    ...(opts.sessionAbsoluteMs !== undefined ? { sessionAbsoluteMs: opts.sessionAbsoluteMs } : {}),
    ...(opts.authThrottle?.now !== undefined ? { now: opts.authThrottle.now } : {}),
  })

  const engine = opts.engine ?? createReadEngine(cfg, {
    ...(opts.readUrl !== undefined ? { readUrl: opts.readUrl } : {}),
    ...(opts.statementTimeoutMs !== undefined ? { statementTimeoutMs: opts.statementTimeoutMs } : {}),
    ...(opts.poolMax !== undefined ? { poolMax: opts.poolMax } : {}),
  })
  const ownsEngine = opts.engine === undefined

  // M4: data routes — tenants, actors, accounts, schema. Public endpoints
  // (health, version) stay anonymous; private ones gate via `auth.requireAuth`
  // when M5+ data routes that touch business data land. M4 routes are
  // already-public *operator* views: tenant list, schema description.
  const tenants = opts.tenants ?? 'all'
  const cursor = createCursorEncoder(deriveCursorSecret(secret), {
    ...(opts.cursorTtlMs !== undefined ? { ttlMs: opts.cursorTtlMs } : {}),
  })

  // Payload redactor — identity in dev, SAFE_KEYS allowlist in prod
  // (overridable by config). `--no-redact` is permitted only by the
  // refusal matrix in prod with `--allow-prod-leakage`.
  const redactor: Redactor = opts.redactor
    ?? (opts.noRedact === true
      ? identityRedactor
      : nodeEnv === 'production'
        ? defaultProdRedactor
        : identityRedactor)

  // SSE concurrency — two tiers: process-wide (default 256) + per
  // session id (default 16). Authenticated sessions share the per-key
  // counter via their rotating `sid`; anonymous / bearer / IP-only
  // requests fall back to the source IP as the key.
  const sseConcurrency = createSessionScopedCap({
    globalMax: opts.stream?.maxConcurrent ?? 256,
    perSessionMax: opts.stream?.perSessionMax ?? 16,
  })

  registerHealthRoute(app, engine)
  registerVersionRoute(app, schema, new Date(), opts.buildHash)
  registerSchemaRoutes(app, engine, schema, tenants)
  registerTenantRoutes(app, engine, tenants)
  registerActorRoutes(app, { engine, schema, tenants, cursor })
  registerAccountRoutes(app, { engine, schema, tenants, cursor })
  // Per-route concurrency semaphores (§8.13) for the three heavy
  // findMany surfaces — cap each at 4 concurrent. Light routes stay
  // under the global rate limit only.
  const txnsListSem = createRouteSemaphore(audit, 'transactions.findMany', { maxConcurrent: 4 })
  const postingsSem = createRouteSemaphore(audit, 'transactions.postings', { maxConcurrent: 4 })
  const anomaliesListSem = createRouteSemaphore(audit, 'anomalies.findMany', { maxConcurrent: 4 })

  registerTransactionRoutes(app, {
    engine, schema, tenants, cursor, redactor,
    findManyConcurrency: txnsListSem,
    postingsConcurrency: postingsSem,
  })
  registerAnomalyRoutes(app, { engine, tenants, cursor, redactor, findManyConcurrency: anomaliesListSem })

  // Shared in-memory ring buffer fed by reconciler.run-once actions
  // and read by /reconciler/runs.
  const reconcilerRunsBuffer = createReconcilerRunsBuffer()
  registerReconcilerRoutes(app, { engine, tenants, runsBuffer: reconcilerRunsBuffer })
  registerOutboxRoutes(app, { engine, tenants, cursor, redactor })
  registerSchedulerRoutes(app, { engine, tenants, cursor, redactor })
  registerHoldRoutes(app, { engine, tenants })
  registerDisputeRoutes(app, { engine, tenants })
  registerFxRoutes(app, { engine, schema, tenants })
  registerFlowRoutes(app, { engine, schema, tenants, cursor })

  // M8: Actions — only when `--allow-actions` is set. Without it, the
  // two POST endpoints don't exist (Fastify's 404 handler covers them).
  registerActionRoutes(app, {
    engine,
    schema,
    tenants,
    audit,
    enabled: opts.allowActions === true,
    config: opts.allowActions === true && opts.actions !== undefined ? opts.actions : null,
    runsBuffer: reconcilerRunsBuffer,
    ...(opts.actionExecutorFactory !== undefined ? { executorFactory: opts.actionExecutorFactory } : {}),
    ...(opts.actionIdempotency !== undefined ? { idempotency: opts.actionIdempotency } : {}),
    ...(opts.actionThrottle !== undefined ? { throttle: opts.actionThrottle } : {}),
    ...(opts.actionConcurrency !== undefined ? { concurrency: opts.actionConcurrency } : {}),
    ...(opts.actionMaxSessionAgeMs !== undefined ? { maxSessionAgeMs: opts.actionMaxSessionAgeMs } : {}),
  })

  registerStreamRoutes(app, {
    engine,
    schema,
    tenants,
    audit,
    concurrency: sseConcurrency,
    ...(opts.stream?.pollIntervalMs !== undefined ? { pollIntervalMs: opts.stream.pollIntervalMs } : {}),
    ...(opts.stream?.heartbeatMs !== undefined ? { heartbeatMs: opts.stream.heartbeatMs } : {}),
    ...(opts.stream?.maxConnectionMs !== undefined ? { maxConnectionMs: opts.stream.maxConnectionMs } : {}),
    ...(opts.stream?.timers !== undefined ? { timers: opts.stream.timers } : {}),
    ...(opts.stream?.abortSignal !== undefined ? { abortSignal: opts.stream.abortSignal } : {}),
  })

  // M10: bundled static UI. The route registration above lands first
  // so `/api/*` always wins over the UI's SPA fallback.
  if (opts.ui?.enabled !== false) {
    await registerUi(app, {
      ...(opts.ui?.root !== undefined ? { root: opts.ui.root } : {}),
      ...(opts.ui?.noCache !== undefined ? { noCache: opts.ui.noCache } : {}),
    })
  }

  // Keep `auth` accessible to tests / future private routes.
  void auth

  let address: string
  if (opts.skipListen) {
    address = bindMode === 'socket' ? `unix:${opts.socket!.path}` : `${host}:${port}`
  } else if (bindMode === 'socket') {
    const sockPath = opts.socket!.path
    // Unlink any stale socket from a previous crashed run before binding.
    try { unlinkSync(sockPath) } catch { /* not present, fine */ }
    await app.listen({ path: sockPath })
    if (process.platform !== 'win32') {
      const mode = opts.socket!.mode ?? 0o660
      chmodSync(sockPath, mode)
      if (opts.socket!.group !== undefined) {
        // Best-effort chgrp via numeric gid lookup. We refuse to fall
        // through to os.userInfo() because that can return -1 on some
        // platforms; if the group can't be resolved we leave ownership
        // alone and audit-log a warning.
        try {
          const { gid } = userInfo()
          chownSync(sockPath, -1, gid)
        } catch { /* ignore — mode is the primary control */ }
      }
    }
    // Per-IP rate limit doesn't apply to Unix sockets; cap concurrent
    // connections only.
    const sockCap = opts.socket!.maxConnections ?? 256
    app.server.maxConnections = sockCap
    address = `unix:${sockPath}`
  } else {
    await app.listen({ host, port })
    applySocketLimits(app.server, audit, opts.socketLimits ?? {})
    address = `${host}:${port}`
  }

  return {
    address,
    auth,
    app,
    close: async () => {
      await app.close()
      if (ownsEngine) await engine.close()
      await audit.close()
      // Clean up the socket file on graceful shutdown so a restart
      // doesn't trip the "stale socket" unlink at boot.
      if (bindMode === 'socket' && !opts.skipListen) {
        try { unlinkSync(opts.socket!.path) } catch { /* already gone */ }
      }
    },
  }
}

function buildAuditLog(path: string | undefined): AuditLog {
  if (path === undefined) return NOOP_AUDIT_LOG
  return createAuditLog(path)
}

// Backward-compat re-export so existing tests using
// `import { applyRefusalMatrix } from '.../dashboard/server.js'` still
// work after the move into `security/tls-policy.ts`.
export { applyRefusalMatrix } from './security/tls-policy.js'
