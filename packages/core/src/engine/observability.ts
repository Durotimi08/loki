/**
 * Observability plug-in interfaces — Batch H.
 *
 * No vendor coupling. The shapes match Prometheus (counter/histogram/
 * gauge) and OpenTelemetry (`Tracer.startSpan`) so an adapter on top
 * of either is essentially a one-liner. Without a config, the engine
 * uses no-op shims so the call sites compile to nothing.
 */

export type MetricLabels = Readonly<Record<string, string | number | boolean>>

export type Counter = {
  inc(value?: number, labels?: MetricLabels): void
}

export type Histogram = {
  observe(value: number, labels?: MetricLabels): void
}

export type Gauge = {
  set(value: number, labels?: MetricLabels): void
  inc(value?: number, labels?: MetricLabels): void
  dec(value?: number, labels?: MetricLabels): void
}

export type MetricsAdapter = {
  counter(name: string, help?: string): Counter
  histogram(name: string, help?: string, buckets?: readonly number[]): Histogram
  gauge(name: string, help?: string): Gauge
}

export type SpanStatus = 'ok' | 'error'

export type Span = {
  setAttribute(key: string, value: string | number | boolean): void
  setStatus(status: SpanStatus, message?: string): void
  recordException(error: unknown): void
  end(): void
}

export type Tracer = {
  startSpan(name: string, attributes?: MetricLabels): Span
}

// ----------------------------------------------------------------------
// Logger — for the engine's OWN operational events (engine started,
// migration applied, outbox worker stopped, connection error).
//
// Why this exists when we already have hooks/metrics/tracer:
//
//   - Hooks fire on DOMAIN events (transitions, anomalies, reconciler
//     completions) — they're what application code subscribes to.
//   - Metrics aggregate numbers — counts, durations, gauges. You
//     can't search metrics by tenant id or correlate across services.
//   - Tracer is per-request — spans are tied to a specific operation.
//   - Logger is for everything else: the engine emitting "I started",
//     "the connection pool errored at 03:42", "scheduler worker
//     stopped". Structured records, with fields, that ship to your
//     log aggregator.
//
// The shape is a deliberate subset of pino / winston / bunyan so
// adapting any of them is a one-line wrapper.
//
// Production wiring belongs in the application, not here:
//
//   - Emit JSON to stdout (pino's default).
//   - Container runtime captures stdout.
//   - Log shipper (Fluent Bit / Vector / Datadog Agent) ships to
//     your aggregator (Datadog, Splunk, CloudWatch, Grafana Loki,
//     ELK).
//   - Retention policy lives on the aggregator (e.g. 30d hot, 1y
//     warm, archived). NEVER summarise inside the application.
//
// File-based logging (`log.txt`) is an anti-pattern in containerised
// deployments — the filesystem is ephemeral, files race under
// concurrent writers, and `grep` across N replicas isn't an
// operational story. If you need that for a single-node deployment,
// pipe stdout through `tee log.txt` at the OS level instead of
// teaching the engine to write a file.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>

export type Logger = {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  /**
   * `error` accepts an Error in either slot — `error('boom', new Error())`
   * or `error('boom', { tenant: 'x' }, new Error())`. The engine never
   * passes the second-slot variant, but the contract permits it so an
   * adapter can implement either calling convention.
   */
  error(message: string, fieldsOrError?: LogFields | Error, error?: Error): void
  /**
   * Return a child logger with `fields` merged into every record. Used
   * for per-request / per-tenant scoping: `logger.child({ tenantId })`
   * means every subsequent record carries `tenantId`.
   */
  child(fields: LogFields): Logger
}

// ----------------------------------------------------------------------
// No-op shims — used when `metrics` / `tracer` is `undefined`. Every
// method is an empty function so the V8 inliner can elide the call.
// ----------------------------------------------------------------------

const noopCounter: Counter = { inc() {} }
const noopHistogram: Histogram = { observe() {} }
const noopGauge: Gauge = { set() {}, inc() {}, dec() {} }
const noopSpan: Span = {
  setAttribute() {},
  setStatus() {},
  recordException() {},
  end() {},
}

export const NOOP_METRICS: MetricsAdapter = {
  counter: () => noopCounter,
  histogram: () => noopHistogram,
  gauge: () => noopGauge,
}

export const NOOP_TRACER: Tracer = {
  startSpan: () => noopSpan,
}

// Singleton noop logger; `child` returns the same instance so chained
// `.child({...}).child({...})` calls don't allocate.
export const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NOOP_LOGGER
  },
}

/**
 * Convenience factory: a structured-console logger suitable for
 * development. Each record is one JSON line on stdout (or stderr for
 * error-level), matching pino's default — which is what most log
 * shippers parse natively.
 *
 * Production code should swap this for a real logger (pino, winston,
 * bunyan, or whatever ships to your aggregator) by passing it into
 * `createEngine({ logger })`.
 *
 * Default level is `'info'`. `'debug'` records are silent unless you
 * pass `{ level: 'debug' }`.
 */
export function consoleLogger(opts: { readonly level?: LogLevel } = {}): Logger {
  const minLevel = opts.level ?? 'info'
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
  const threshold = order[minLevel]

  const emit = (level: LogLevel, message: string, fields?: LogFields, error?: Error): void => {
    if (order[level] < threshold) return
    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      msg: message,
      ...(fields ?? {}),
    }
    if (error) {
      record['err'] = {
        name: error.name,
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      }
    }
    const line = JSON.stringify(record)
    if (level === 'error' || level === 'warn') {
      // Keep error/warn on stderr so a process-supervisor can route
      // them differently from info chatter.
      process.stderr.write(`${line}\n`)
    } else {
      process.stdout.write(`${line}\n`)
    }
  }

  const make = (boundFields: LogFields): Logger => ({
    debug: (m, f) => emit('debug', m, { ...boundFields, ...(f ?? {}) }),
    info: (m, f) => emit('info', m, { ...boundFields, ...(f ?? {}) }),
    warn: (m, f) => emit('warn', m, { ...boundFields, ...(f ?? {}) }),
    error: (m, fOrErr, err) => {
      if (fOrErr instanceof Error) {
        emit('error', m, boundFields, fOrErr)
      } else {
        emit('error', m, { ...boundFields, ...(fOrErr ?? {}) }, err)
      }
    },
    child: (extra) => make({ ...boundFields, ...extra }),
  })

  return make({})
}

/**
 * Bundle of pre-resolved instruments the engine touches at runtime.
 * Built once at engine construction so we don't string-match a name
 * on every transition.
 */
export type EngineInstruments = {
  readonly metrics: MetricsAdapter
  readonly tracer: Tracer
  readonly logger: Logger
  readonly transitionDurationMs: Histogram
  readonly transitionErrors: Counter
  readonly reconcilerDurationMs: Histogram
  readonly reconcilerAnomalies: Counter
  readonly outboxSuccess: Counter
  readonly outboxFailure: Counter
  readonly schedulerFires: Counter
}

export function buildInstruments(
  metrics?: MetricsAdapter,
  tracer?: Tracer,
  logger?: Logger,
): EngineInstruments {
  const m = metrics ?? NOOP_METRICS
  const t = tracer ?? NOOP_TRACER
  const l = (logger ?? NOOP_LOGGER).child({ component: 'loki' })
  return {
    metrics: m,
    tracer: t,
    logger: l,
    transitionDurationMs: m.histogram(
      'loki_transition_duration_ms',
      'Wall time of a transition write, in milliseconds.',
    ),
    transitionErrors: m.counter(
      'loki_transition_errors_total',
      'Count of transition writes that threw, by error class.',
    ),
    reconcilerDurationMs: m.histogram(
      'loki_reconciler_duration_ms',
      'Wall time of a reconciliation pass, in milliseconds.',
    ),
    reconcilerAnomalies: m.counter(
      'loki_reconciler_anomalies_total',
      'Anomalies recorded by the reconciler, labeled by check + severity.',
    ),
    outboxSuccess: m.counter(
      'loki_outbox_dispatch_success_total',
      'Outbox events delivered successfully.',
    ),
    outboxFailure: m.counter(
      'loki_outbox_dispatch_failure_total',
      'Outbox events that errored, labeled by terminal=true|false.',
    ),
    schedulerFires: m.counter(
      'loki_scheduler_fires_total',
      'Scheduled-transition fires, labeled by status.',
    ),
  }
}
