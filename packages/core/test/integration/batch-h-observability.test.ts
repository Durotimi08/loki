/**
 * Integration coverage for batch H — observability instruments fire
 * during real engine activity. We attach a recording metrics adapter
 * and assert at least one observation lands per instrument the engine
 * is wired to populate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Counter,
  type Engine,
  type Gauge,
  type Histogram,
  MIGRATIONS_TABLE,
  type MetricLabels,
  type MetricsAdapter,
  RECONCILER_STATE_TABLE,
  createEngine,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-obs'
let engine: Engine | null = null
let dbUrl: string | null = null

class Recorder implements MetricsAdapter {
  readonly counters = new Map<string, { value: number; labels?: MetricLabels }[]>()
  readonly histograms = new Map<string, { value: number; labels?: MetricLabels }[]>()
  readonly gauges = new Map<string, { kind: string; value: number }[]>()

  counter(name: string): Counter {
    const events: { value: number; labels?: MetricLabels }[] = []
    this.counters.set(name, events)
    return {
      inc: (value?: number, labels?: MetricLabels) =>
        events.push({ value: value ?? 1, ...(labels !== undefined ? { labels } : {}) }),
    }
  }

  histogram(name: string): Histogram {
    const events: { value: number; labels?: MetricLabels }[] = []
    this.histograms.set(name, events)
    return {
      observe: (value: number, labels?: MetricLabels) =>
        events.push({ value, ...(labels !== undefined ? { labels } : {}) }),
    }
  }

  gauge(name: string): Gauge {
    const events: { kind: string; value: number }[] = []
    this.gauges.set(name, events)
    return {
      set: (value: number) => events.push({ kind: 'set', value }),
      inc: (value?: number) => events.push({ kind: 'inc', value: value ?? 1 }),
      dec: (value?: number) => events.push({ kind: 'dec', value: value ?? 1 }),
    }
  }
}

let recorder: Recorder

beforeAll(async () => {
  const db = await ensurePostgres()
  dbUrl = db?.url ?? null
})
afterAll(async () => {
  if (engine) await engine.close()
  await teardownPostgres()
})
beforeEach(async () => {
  if (!dbUrl) return
  if (engine) {
    try {
      await engine.rollback()
    } catch {
      /* fine */
    }
    await engine.connection.sql.unsafe(`drop table if exists ${MIGRATIONS_TABLE}`)
    await engine.connection.sql.unsafe(`drop table if exists ${RECONCILER_STATE_TABLE}`)
    await engine.close()
  }
  recorder = new Recorder()
  engine = createEngine({
    schema: chidoriSchema,
    connection: { url: dbUrl },
    metrics: recorder,
  })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'Obs' })
})

describe('batch H — instruments fire during engine activity', () => {
  it('records transition_duration + transition_errors when a transition runs and fails', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-obs' }
    const driver = { type: 'Driver', id: 'd-obs' }
    const company = { type: 'Company', id: 'co-obs' }
    await c.accounts.create({ actor: user, name: 'wallet' })
    await c.accounts.create({ actor: driver, name: 'balance' })
    await c.accounts.create({ actor: company, name: 'revenue' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = 'u-obs'`,
    )
    const txn = await c.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'obs:create',
    })
    await c.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      idempotencyKey: 'obs:pay',
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    })
    const durations = recorder.histograms.get('loki_transition_duration_ms')
    expect(durations?.length).toBeGreaterThanOrEqual(1)

    // Now force an error: a duplicate idempotency key on a different record.
    await expect(
      c.transactions.transition({
        id: '00000000-0000-0000-0000-000000000000',
        name: 'pay',
        by: user,
        idempotencyKey: 'obs:pay',
        data: { amount: 1n, driverShare: 0n, companyShare: 1n },
      }),
    ).rejects.toThrow()

    const errors = recorder.counters.get('loki_transition_errors_total')
    expect(errors?.length).toBeGreaterThanOrEqual(1)
  })

  it('records reconciler_duration + reconciler_anomalies on a clean sweep + an anomalous sweep', async () => {
    if (!engine) return
    await engine.reconciler.runOnce()
    const durations = recorder.histograms.get('loki_reconciler_duration_ms')
    expect(durations?.length).toBeGreaterThanOrEqual(1)

    // Inject an anomaly and rerun.
    const c = engine.forTenant(TENANT)
    await c.accounts.create({ actor: { type: 'User', id: 'u-d' }, name: 'wallet' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 999 where owner_actor_type = 'User' and owner_actor_id = 'u-d'`,
    )
    const result = await engine.reconciler.runOnce({ tenantId: TENANT })
    expect(result.anomalies.length).toBeGreaterThanOrEqual(1)
    const anomalies = recorder.counters.get('loki_reconciler_anomalies_total')
    expect(anomalies?.length).toBeGreaterThanOrEqual(1)
  })
})
