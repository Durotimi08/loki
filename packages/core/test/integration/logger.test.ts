/**
 * Integration coverage for the engine's operational logger.
 *
 * The engine emits records at three high-leverage sites:
 *   - construction → "engine constructed"
 *   - migrations apply / rollback → info on success, error on throw
 *   - reconciler pass → debug on clean, info on anomalies, warn on critical
 *   - outbox dispatch failures → warn on transient, error on terminal
 *
 * The logger contract is "structured records with fields"; tests
 * capture every record into a plain JS array and assert the shape.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  type LogFields,
  type Logger,
  MIGRATIONS_TABLE,
  RECONCILER_STATE_TABLE,
  createEngine,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

let engine: Engine | null = null
let dbUrl: string | null = null

type Record = { level: string; message: string; fields: LogFields }

function captureLogger(): { logger: Logger; records: Record[] } {
  const records: Record[] = []
  const make = (bound: LogFields): Logger => ({
    debug: (m, f) => records.push({ level: 'debug', message: m, fields: { ...bound, ...f } }),
    info: (m, f) => records.push({ level: 'info', message: m, fields: { ...bound, ...f } }),
    warn: (m, f) => records.push({ level: 'warn', message: m, fields: { ...bound, ...f } }),
    error: (m, fOrErr) => {
      const fields = fOrErr instanceof Error ? { error: fOrErr.message } : { ...(fOrErr ?? {}) }
      records.push({ level: 'error', message: m, fields: { ...bound, ...fields } })
    },
    child: (extra) => make({ ...bound, ...extra }),
  })
  return { logger: make({}), records }
}

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
})

describe('engine operational logger', () => {
  it('logs engine construction, migration, and close', async () => {
    if (!dbUrl) return
    const cap = captureLogger()
    engine = createEngine({
      schema: chidoriSchema,
      connection: { url: dbUrl },
      logger: cap.logger,
    })
    await engine.migrate()
    await engine.close()
    engine = null

    const messages = cap.records.map((r) => r.message)
    expect(messages).toContain('engine constructed')
    expect(messages).toContain('migrations applied')
    expect(messages).toContain('engine closing')

    // Construction record carries the schema version + flag fields.
    const constructed = cap.records.find((r) => r.message === 'engine constructed')
    expect(constructed?.fields).toMatchObject({
      schemaVersion: chidoriSchema.version,
      readYourWrites: 'off',
      payloadCrypto: false,
      component: 'loki',
    })

    // Migration record carries the count + duration.
    const migrated = cap.records.find((r) => r.message === 'migrations applied')
    expect(typeof migrated?.fields.count).toBe('number')
    expect((migrated?.fields.count as number) >= 1).toBe(true)
    expect(typeof migrated?.fields.durationMs).toBe('number')
  })

  it('logs reconciliation passes at debug when clean', async () => {
    if (!dbUrl) return
    const cap = captureLogger()
    engine = createEngine({
      schema: chidoriSchema,
      connection: { url: dbUrl },
      logger: cap.logger,
    })
    await engine.migrate()
    await engine.admin.tenants.create({ id: 'org-log', name: 'LogTest' })
    cap.records.length = 0 // ignore startup chatter

    const result = await engine.reconciler.runOnce({ tenantId: 'org-log' })
    expect(result.anomalies).toEqual([])

    const reconRecord = cap.records.find((r) => r.message.startsWith('reconciliation pass'))
    expect(reconRecord).toBeDefined()
    expect(reconRecord?.level).toBe('debug') // clean → debug
    expect(reconRecord?.fields.anomalies).toBe(0)
    expect(reconRecord?.fields.tenantId).toBe('org-log')
  })

  it('logs reconciler at warn when critical anomalies are present', async () => {
    if (!dbUrl) return
    const cap = captureLogger()
    engine = createEngine({
      schema: chidoriSchema,
      connection: { url: dbUrl },
      logger: cap.logger,
    })
    await engine.migrate()
    await engine.admin.tenants.create({ id: 'org-log2', name: 'LogTest2' })

    // Drive a transition, then tamper with its to_state to force a
    // hash_chain_break — that's a critical anomaly.
    const c = engine.forTenant('org-log2')
    const user = { type: 'User', id: 'u-l' }
    const driver = { type: 'Driver', id: 'd-l' }
    const company = { type: 'Company', id: 'co-l' }
    await c.accounts.create({ actor: user, name: 'wallet' })
    await c.accounts.create({ actor: driver, name: 'balance' })
    await c.accounts.create({ actor: company, name: 'revenue' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = 'u-l'`,
    )
    const txn = await c.transactions.create({
      type: 'DeliveryPayment',
      by: user,
      participants: { user, driver, company },
      idempotencyKey: 'log:create',
    })
    const r = await c.transactions.transition({
      id: txn.record.id,
      name: 'pay',
      by: user,
      idempotencyKey: 'log:pay',
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    })
    await engine.connection.sql.unsafe(
      `update "txn_transitions" set to_state = 'failed' where id = '${r.transition.id}'`,
    )

    cap.records.length = 0
    await engine.reconciler.runOnce({ tenantId: 'org-log2' })

    const reconRecord = cap.records.find((r) => r.message.startsWith('reconciliation pass'))
    expect(reconRecord?.level).toBe('warn')
    expect((reconRecord?.fields.anomalies as number) >= 1).toBe(true)
  })
})
