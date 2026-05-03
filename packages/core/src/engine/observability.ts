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

/**
 * Bundle of pre-resolved instruments the engine touches at runtime.
 * Built once at engine construction so we don't string-match a name
 * on every transition.
 */
export type EngineInstruments = {
  readonly metrics: MetricsAdapter
  readonly tracer: Tracer
  readonly transitionDurationMs: Histogram
  readonly transitionErrors: Counter
  readonly reconcilerDurationMs: Histogram
  readonly reconcilerAnomalies: Counter
  readonly outboxSuccess: Counter
  readonly outboxFailure: Counter
  readonly schedulerFires: Counter
}

export function buildInstruments(metrics?: MetricsAdapter, tracer?: Tracer): EngineInstruments {
  const m = metrics ?? NOOP_METRICS
  const t = tracer ?? NOOP_TRACER
  return {
    metrics: m,
    tracer: t,
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
