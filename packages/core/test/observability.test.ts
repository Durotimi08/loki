import { describe, expect, it } from 'vitest'
import {
  type Counter,
  type Gauge,
  type Histogram,
  type MetricLabels,
  type MetricsAdapter,
  NOOP_METRICS,
  NOOP_TRACER,
  type Span,
  type SpanStatus,
  type Tracer,
  buildInstruments,
} from '../src/index.js'

class RecordingMetrics implements MetricsAdapter {
  readonly counters = new Map<
    string,
    { name: string; events: { value: number; labels?: MetricLabels }[] }
  >()
  readonly histograms = new Map<
    string,
    { name: string; events: { value: number; labels?: MetricLabels }[] }
  >()
  readonly gauges = new Map<
    string,
    { name: string; events: { kind: string; value: number; labels?: MetricLabels }[] }
  >()

  counter(name: string): Counter {
    const entry = { name, events: [] as { value: number; labels?: MetricLabels }[] }
    this.counters.set(name, entry)
    return {
      inc: (value?: number, labels?: MetricLabels) => {
        entry.events.push({
          value: value ?? 1,
          ...(labels !== undefined ? { labels } : {}),
        })
      },
    }
  }

  histogram(name: string): Histogram {
    const entry = { name, events: [] as { value: number; labels?: MetricLabels }[] }
    this.histograms.set(name, entry)
    return {
      observe: (value: number, labels?: MetricLabels) => {
        entry.events.push({ value, ...(labels !== undefined ? { labels } : {}) })
      },
    }
  }

  gauge(name: string): Gauge {
    const entry = { name, events: [] as { kind: string; value: number; labels?: MetricLabels }[] }
    this.gauges.set(name, entry)
    return {
      set: (value: number, labels?: MetricLabels) =>
        entry.events.push({ kind: 'set', value, ...(labels !== undefined ? { labels } : {}) }),
      inc: (value?: number, labels?: MetricLabels) =>
        entry.events.push({
          kind: 'inc',
          value: value ?? 1,
          ...(labels !== undefined ? { labels } : {}),
        }),
      dec: (value?: number, labels?: MetricLabels) =>
        entry.events.push({
          kind: 'dec',
          value: value ?? 1,
          ...(labels !== undefined ? { labels } : {}),
        }),
    }
  }
}

describe('batch H — observability shims', () => {
  it('NOOP_METRICS supports the full surface without throwing', () => {
    const c = NOOP_METRICS.counter('x')
    c.inc()
    c.inc(5)
    c.inc(1, { label: 'v' })
    const h = NOOP_METRICS.histogram('y')
    h.observe(0)
    h.observe(123, { kind: 'fast' })
    const g = NOOP_METRICS.gauge('z')
    g.set(0)
    g.inc()
    g.dec(2)
  })

  it('NOOP_TRACER returns a fully-populated span', () => {
    const span = NOOP_TRACER.startSpan('test')
    span.setAttribute('a', 1)
    span.setStatus('error', 'whatever')
    span.recordException(new Error('boom'))
    span.end()
  })
})

describe('batch H — buildInstruments', () => {
  it('uses no-op shims when neither metrics nor tracer is supplied', () => {
    const instr = buildInstruments()
    expect(instr.metrics).toBe(NOOP_METRICS)
    expect(instr.tracer).toBe(NOOP_TRACER)
    expect(typeof instr.transitionDurationMs.observe).toBe('function')
  })

  it('threads metrics through to all engine instruments', () => {
    const m = new RecordingMetrics()
    const instr = buildInstruments(m)
    instr.transitionDurationMs.observe(42, { name: 'pay' })
    instr.transitionErrors.inc(1, { name: 'pay', error: 'OverdraftError' })
    instr.outboxSuccess.inc(1, { event: 'order.paid' })
    instr.outboxFailure.inc(1, { terminal: 'true' })
    instr.reconcilerDurationMs.observe(123)
    instr.reconcilerAnomalies.inc(1, { check: 'balance_drift', severity: 'error' })
    instr.schedulerFires.inc(1, { status: 'fired' })

    expect(m.histograms.get('loki_transition_duration_ms')?.events).toEqual([
      { value: 42, labels: { name: 'pay' } },
    ])
    expect(m.counters.get('loki_transition_errors_total')?.events).toEqual([
      { value: 1, labels: { name: 'pay', error: 'OverdraftError' } },
    ])
    expect(m.counters.get('loki_outbox_dispatch_success_total')?.events).toEqual([
      { value: 1, labels: { event: 'order.paid' } },
    ])
    expect(m.counters.get('loki_outbox_dispatch_failure_total')?.events).toEqual([
      { value: 1, labels: { terminal: 'true' } },
    ])
    expect(m.histograms.get('loki_reconciler_duration_ms')?.events).toEqual([{ value: 123 }])
    expect(m.counters.get('loki_reconciler_anomalies_total')?.events).toEqual([
      { value: 1, labels: { check: 'balance_drift', severity: 'error' } },
    ])
    expect(m.counters.get('loki_scheduler_fires_total')?.events).toEqual([
      { value: 1, labels: { status: 'fired' } },
    ])
  })

  it('falls back to NOOP_TRACER when only metrics is supplied', () => {
    const m = new RecordingMetrics()
    const instr = buildInstruments(m)
    expect(instr.tracer).toBe(NOOP_TRACER)
    expect(instr.metrics).toBe(m)
  })

  it('captures custom tracer', () => {
    const events: { name: string; ended: boolean }[] = []
    const tracer: Tracer = {
      startSpan(name: string): Span {
        const event = { name, ended: false }
        events.push(event)
        return {
          setAttribute: () => {},
          setStatus: (_s: SpanStatus) => {},
          recordException: () => {},
          end: () => {
            event.ended = true
          },
        }
      },
    }
    const instr = buildInstruments(undefined, tracer)
    const span = instr.tracer.startSpan('outer')
    span.end()
    expect(events).toEqual([{ name: 'outer', ended: true }])
  })
})
