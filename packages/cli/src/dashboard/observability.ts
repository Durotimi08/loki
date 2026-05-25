/**
 * Per-request observability — DASHBOARD.md §10.
 *
 * Wires three plug-ins:
 *
 *   - `engine.instruments.logger` (or an injected one): info-level
 *     structured log per finished request, error-level on 5xx.
 *   - `MetricsAdapter`: counters + histogram per request. Metric names
 *     follow the doc spec (`loki_dashboard_*`).
 *   - `Tracer`: one `dashboard.request` span per request, attributed
 *     with method/route/status/tenant.
 *
 * Defaults are the engine's no-op shims so a dashboard with no observer
 * adapter pays nothing.
 */
import type {
  Counter,
  Gauge,
  Histogram,
  Logger,
  MetricsAdapter,
  Span,
  Tracer,
} from '@loki/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export type DashboardInstruments = {
  /** Per-request counter, labels: `method`, `route`, `status`. */
  readonly requestsTotal: Counter
  /** Per-request histogram (seconds), labels: `method`, `route`. */
  readonly requestDurationSec: Histogram
  /** Open SSE connections gauge, labels: `stream`. */
  readonly sseActive: Gauge
}

export function createDashboardInstruments(metrics: MetricsAdapter): DashboardInstruments {
  return {
    requestsTotal: metrics.counter(
      'loki_dashboard_requests_total',
      'HTTP requests served by the dashboard',
    ),
    requestDurationSec: metrics.histogram(
      'loki_dashboard_request_duration_seconds',
      'Dashboard request duration',
      [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    ),
    sseActive: metrics.gauge('loki_dashboard_sse_active', 'Currently open SSE connections'),
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the observability `onRequest` hook. */
    _lokiSpan?: Span | undefined
    _lokiStartedAt?: number | undefined
  }
}

export type RegisterObservabilityOptions = {
  readonly instruments: DashboardInstruments
  readonly logger: Logger
  readonly tracer: Tracer
  /** Inject `process.hrtime`/`Date.now` shim for tests. */
  readonly now?: () => number
}

/**
 * Install request-lifecycle hooks. Records:
 *   - `loki_dashboard_requests_total{method, route, status}`
 *   - `loki_dashboard_request_duration_seconds{method, route}`
 *   - one `dashboard.request` span (status + duration recorded on end)
 *   - one info-level log line per request (warn on 4xx, error on 5xx)
 */
export function registerObservability(
  app: FastifyInstance,
  opts: RegisterObservabilityOptions,
): void {
  const now = opts.now ?? Date.now

  app.addHook('onRequest', async (req: FastifyRequest) => {
    req._lokiStartedAt = now()
    req._lokiSpan = opts.tracer.startSpan('dashboard.request', {
      method: req.method,
      path: req.url,
    })
  })

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const started = req._lokiStartedAt ?? now()
    const durationMs = Math.max(0, now() - started)
    const route = routeOf(req)
    const status = reply.statusCode
    const labels = { method: req.method, route, status }

    opts.instruments.requestsTotal.inc(1, labels)
    opts.instruments.requestDurationSec.observe(durationMs / 1000, {
      method: req.method,
      route,
    })

    const span = req._lokiSpan
    if (span !== undefined) {
      span.setAttribute('route', route)
      span.setAttribute('status', status)
      span.setStatus(status >= 500 ? 'error' : 'ok')
      span.end()
    }

    const fields = {
      reqId: req.id,
      method: req.method,
      route,
      status,
      durationMs,
      ip: req.ip,
      subject: req.session?.subject ?? null,
    }
    if (status >= 500) opts.logger.error('dashboard request', fields)
    else if (status >= 400) opts.logger.warn('dashboard request', fields)
    else opts.logger.info('dashboard request', fields)
  })
}

/**
 * Normalise the routed URL so metric cardinality stays bounded.
 * Falls back to the raw URL when Fastify hasn't matched a route (404).
 */
function routeOf(req: FastifyRequest): string {
  // Fastify v5 exposes the matched-route URL on `req.routeOptions.url`.
  const routed = (req as { routeOptions?: { url?: string } }).routeOptions?.url
  if (typeof routed === 'string' && routed.length > 0) return routed
  return req.url.split('?')[0] ?? req.url
}
