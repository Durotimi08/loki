/**
 * H1 — Date in payload no longer causes false hash_chain_break.
 *
 * Pre-fix: payload with a Date stored as `{}` because
 * `Object.keys(date) === []`. Reconciler read `{}` back, recomputed
 * a different row_hash, fired false `hash_chain_break` on every
 * sweep. Same hazard for Uint8Array — its keys are also empty.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  MIGRATIONS_TABLE,
  RECONCILER_STATE_TABLE,
  createEngine,
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '../../src/index.js'
import { stubPayload } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-h1'
let engine: Engine | null = null
let dbUrl: string | null = null

const Org = defineTenant('Org')
const User = defineActor('User', { accounts: { wallet: { currency: 'NGN' } } })
const Driver = defineActor('Driver', { accounts: { balance: { currency: 'NGN' } } })

const Sched = defineTransaction('Sched', {
  states: ['pending', 'done'],
  initial: 'pending',
  terminal: ['done'],
  participants: { user: User, driver: Driver },
  transitions: (t) => ({
    finish: t({
      from: 'pending',
      to: 'done',
      by: [User],
      payload: stubPayload<{
        scheduledFor: Date
        signature: Uint8Array
        amount: bigint
      }>(),
    }),
  }),
})

const schema = defineSchema({
  tenant: Org,
  actors: [User, Driver],
  transactions: [Sched],
})

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
  engine = createEngine({ schema, connection: { url: dbUrl } })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'H1' })
})

describe('Date / Uint8Array in payload', () => {
  it('reconciler does not flag hash_chain_break when payload contains Date / bytes / bigint', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-h1' }
    const driver = { type: 'Driver', id: 'd-h1' }
    const txn = await c.transactions.create({
      type: 'Sched',
      by: user,
      participants: { user, driver },
      idempotencyKey: 'h1:create',
    })
    await c.transactions.transition({
      id: txn.record.id,
      name: 'finish',
      by: user,
      data: {
        scheduledFor: new Date('2026-06-15T08:00:00Z'),
        signature: new Uint8Array([1, 2, 3, 4]),
        amount: 1500n,
      },
      idempotencyKey: 'h1:finish',
    })

    // Full sweep — anything that misuses Date would surface as a
    // hash_chain_break here. With the H1 fix in place, zero anomalies.
    const result = await engine.reconciler.runOnce({
      tenantId: TENANT,
      fullSweep: true,
      quarantine: false,
    })
    expect(result.anomalies.filter((a) => a.check === 'hash_chain_break')).toHaveLength(0)
    expect(result.anomalies.filter((a) => a.check === 'checksum_mismatch')).toHaveLength(0)
  })

  it('Date in payload survives round-trip through JSONB as ISO string', async () => {
    if (!engine) return
    const c = engine.forTenant(TENANT)
    const user = { type: 'User', id: 'u-h1b' }
    const driver = { type: 'Driver', id: 'd-h1b' }
    const txn = await c.transactions.create({
      type: 'Sched',
      by: user,
      participants: { user, driver },
      idempotencyKey: 'h1b:create',
    })
    const when = new Date('2026-06-15T08:00:00.000Z')
    await c.transactions.transition({
      id: txn.record.id,
      name: 'finish',
      by: user,
      data: { scheduledFor: when, signature: new Uint8Array([0xff]), amount: 1n },
      idempotencyKey: 'h1b:finish',
    })

    const [row] = await engine.connection.sql<{ payload: Record<string, unknown> }[]>`
      select payload from "txn_transitions"
      where txn_id = ${txn.record.id} and name = 'finish'
    `
    expect(row?.payload).toBeDefined()
    const p = row?.payload as {
      scheduledFor: string
      signature: { $bytes: string }
      amount: { $bigint: string }
    }
    expect(p.scheduledFor).toBe('2026-06-15T08:00:00.000Z')
    expect(p.signature.$bytes).toBe('ff')
    expect(p.amount.$bigint).toBe('1')
  })
})
