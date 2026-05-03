import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type AnomalyEvent,
  type Engine,
  MIGRATIONS_TABLE,
  RECONCILER_STATE_TABLE,
  createEngine,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-recon'
let engine: Engine | null = null
let dbUrl: string | null = null

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
  engine = createEngine({ schema: chidoriSchema, connection: { url: dbUrl } })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'Recon' })
})

const drivePayment = async (e: Engine, suffix: string): Promise<{ recordId: string }> => {
  const client = e.forTenant(TENANT)
  const user = { type: 'User', id: `u-${suffix}` }
  const driver = { type: 'Driver', id: `d-${suffix}` }
  const company = { type: 'Company', id: 'co-1' }
  await client.accounts.create({ actor: user, name: 'wallet' })
  await client.accounts.create({ actor: driver, name: 'balance' })
  await client.accounts.create({ actor: company, name: 'revenue' })
  await e.connection.sql.unsafe(
    `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = '${user.id}' and name = 'wallet'`,
  )
  const txn = await client.transactions.create({
    type: 'DeliveryPayment',
    by: user,
    participants: { user, driver, company },
    idempotencyKey: `${suffix}:create`,
  })
  await client.transactions.transition({
    id: txn.record.id,
    name: 'pay',
    by: user,
    data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    idempotencyKey: `${suffix}:pay`,
  })
  return { recordId: txn.record.id }
}

describe('reconciler — clean state has no anomalies', () => {
  it('runs a full sweep on a freshly created record and reports zero anomalies', async () => {
    if (!engine) return
    // Pre-funding via raw UPDATE would itself be balance drift —
    // legitimate balances always come from postings. So the clean-state
    // assertion uses a plain create() (genesis transition only,
    // zero postings, zero balances).
    const client = engine.forTenant(TENANT)
    await client.transactions.create({
      type: 'DeliveryPayment',
      by: { type: 'User', id: 'u-clean' },
      participants: {
        user: { type: 'User', id: 'u-clean' },
        driver: { type: 'Driver', id: 'd-clean' },
        company: { type: 'Company', id: 'co-1' },
      },
      idempotencyKey: 'clean:create',
    })
    const result = await engine.reconciler.runOnce()
    if (result.anomalies.length > 0) {
      console.error('unexpected anomaly:', JSON.stringify(result.anomalies[0], null, 2))
    }
    expect(result.anomalies).toHaveLength(0)
    expect(result.quarantined).toHaveLength(0)
  })
})

describe('reconciler — balance_drift', () => {
  it('detects a manually-edited balance and reports an anomaly', async () => {
    if (!engine) return
    const captured: AnomalyEvent[] = []
    engine.hooks.onAnomaly({ check: 'balance_drift' }, async (a) => {
      captured.push(a)
    })

    await drivePayment(engine, 'drift')
    // Tamper: bump the user's wallet balance behind the engine's back.
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = balance + 999 where owner_actor_type = 'User' and owner_actor_id = 'u-drift' and name = 'wallet'`,
    )

    const result = await engine.reconciler.runOnce()
    expect(result.anomalies.some((a) => a.check === 'balance_drift')).toBe(true)
    expect(captured.length).toBeGreaterThanOrEqual(1)
    expect(captured[0]?.severity).toBe('error')
  })
})

describe('reconciler — checksum_mismatch', () => {
  it('detects deleted/inserted/edited postings via the stored checksum', async () => {
    if (!engine) return
    await drivePayment(engine, 'sum')
    // Tamper: edit a posting amount. The engine's stored
    // postings_checksum no longer matches.
    await engine.connection.sql.unsafe(
      `update "postings" set amount = amount + 1 where direction = 'C' and amount = 500`,
    )

    const result = await engine.reconciler.runOnce()
    expect(result.anomalies.some((a) => a.check === 'checksum_mismatch')).toBe(true)
    // checksum_mismatch is critical → the affected record gets quarantined.
    expect(result.quarantined.length).toBeGreaterThanOrEqual(1)
  })
})

describe('reconciler — unbalanced_postings', () => {
  it('reports a transition whose postings no longer balance', async () => {
    if (!engine) return
    await drivePayment(engine, 'bal')
    // Tamper: zero out one of the credits.
    await engine.connection.sql.unsafe(
      `update "postings" set amount = 0 where direction = 'C' and amount = 1000`,
    )

    const result = await engine.reconciler.runOnce()
    expect(result.anomalies.some((a) => a.check === 'unbalanced_postings')).toBe(true)
  })
})

describe('reconciler — hash_chain_break', () => {
  it('detects a tampered transition row via the chain', async () => {
    if (!engine) return
    await drivePayment(engine, 'chain')
    // Tamper: rewrite the to_state on the latest transition.
    await engine.connection.sql.unsafe(
      `update "txn_transitions" set to_state = 'failed' where name = 'pay'`,
    )

    const result = await engine.reconciler.runOnce()
    expect(result.anomalies.some((a) => a.check === 'hash_chain_break')).toBe(true)
    // Hash-chain break is critical → quarantine.
    expect(result.quarantined.length).toBeGreaterThanOrEqual(1)
  })
})

describe('reconciler — state_mismatch', () => {
  it('reports records whose state no longer matches the latest transition', async () => {
    if (!engine) return
    const { recordId } = await drivePayment(engine, 'state')
    // Tamper: rewrite the cached state on the record without writing a transition.
    await engine.connection.sql.unsafe(
      `update "txn_records" set state = 'failed' where id = '${recordId}'`,
    )

    const result = await engine.reconciler.runOnce()
    expect(result.anomalies.some((a) => a.check === 'state_mismatch')).toBe(true)
  })
})

describe('reconciler — quarantine', () => {
  it('marks records compromised on critical anomalies and refuses further transitions', async () => {
    if (!engine) return
    const { recordId } = await drivePayment(engine, 'q')
    await engine.connection.sql.unsafe(
      `update "txn_transitions" set to_state = 'failed' where name = 'pay'`,
    )

    const result = await engine.reconciler.runOnce()
    expect(result.quarantined).toContain(recordId)

    // Engine refuses subsequent transitions on the quarantined record.
    const client = engine.forTenant(TENANT)
    await expect(
      client.transactions.transition({
        id: recordId,
        name: 'cancel',
        by: { type: 'User', id: 'u-q' },
        idempotencyKey: 'q:cancel',
      }),
    ).rejects.toThrow(/quarantined|compromised/i)
  })
})
