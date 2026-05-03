/**
 * Batch 10 — perf hardening (M15) integration coverage:
 *   - watermark advances per pass; subsequent passes only verify Δ
 *   - fullSweep option forces re-verification below the watermark
 *   - read-replica routing: withTenantReplica falls back to primary
 *     when no replica is configured, and reads come from `readUrl`
 *     when one is supplied
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  MIGRATIONS_TABLE,
  RECONCILER_STATE_TABLE,
  createEngine,
  openConnection,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-batch10'
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
  await engine.admin.tenants.create({ id: TENANT, name: 'B10' })
})

/**
 * Genesis-only record. No postings → no balance_drift to worry about,
 * so reconciler sweeps come back clean. Tests that need to surface
 * specific anomalies inject them directly into the transitions table.
 */
const createCleanRecord = async (e: Engine, suffix: string): Promise<{ recordId: string }> => {
  const client = e.forTenant(TENANT)
  const user = { type: 'User', id: `u-${suffix}` }
  const driver = { type: 'Driver', id: `d-${suffix}` }
  const company = { type: 'Company', id: 'co-1' }
  const txn = await client.transactions.create({
    type: 'DeliveryPayment',
    by: user,
    participants: { user, driver, company },
    idempotencyKey: `${suffix}:create`,
  })
  return { recordId: txn.record.id }
}

describe('reconciler — watermarked sweeps', () => {
  it('advances watermark per pass and skips already-verified rows', async () => {
    if (!engine) return
    await createCleanRecord(engine, 'wm1')

    // Pass 1: full sweep (no watermark). Records and seeds the watermark.
    const r1 = await engine.reconciler.runOnce({ tenantId: TENANT })
    expect(r1.anomalies).toHaveLength(0)

    const [row1] = await engine.connection.sql<{ watermark: string }[]>`
      select watermark from ${engine.connection.sql(RECONCILER_STATE_TABLE)} where key = ${`${TENANT}:transitions`}
    `
    expect(row1?.watermark).toBeTruthy()
    const wm1 = row1?.watermark as string

    // Inject a checksum mismatch into a transition BELOW the watermark.
    // Watermarked sweep should NOT see it because it only re-checks Δ.
    await engine.connection.sql.unsafe(`
      update "txn_transitions"
      set postings_checksum = decode('00', 'hex')
      where tenant_id = '${TENANT}'
    `)
    const r2 = await engine.reconciler.runOnce({ tenantId: TENANT })
    expect(r2.anomalies).toHaveLength(0)

    // Watermark should not regress.
    const [row2] = await engine.connection.sql<{ watermark: string }[]>`
      select watermark from ${engine.connection.sql(RECONCILER_STATE_TABLE)} where key = ${`${TENANT}:transitions`}
    `
    expect(row2?.watermark).toBe(wm1)
  })

  it('re-verifies cold rows when fullSweep is true', async () => {
    if (!engine) return
    await createCleanRecord(engine, 'wm2')

    // Seed watermark, then corrupt a below-watermark transition.
    await engine.reconciler.runOnce({ tenantId: TENANT })
    await engine.connection.sql.unsafe(`
      update "txn_transitions"
      set postings_checksum = decode('00', 'hex')
      where tenant_id = '${TENANT}'
    `)

    const r = await engine.reconciler.runOnce({
      tenantId: TENANT,
      fullSweep: true,
      quarantine: false,
    })
    expect(r.anomalies.some((a) => a.check === 'checksum_mismatch')).toBe(true)
  })

  it('detects new anomalies introduced above the watermark', async () => {
    if (!engine) return
    await createCleanRecord(engine, 'wm3a')
    await engine.reconciler.runOnce({ tenantId: TENANT })

    const [wmRow] = await engine.connection.sql<{ watermark: string }[]>`
      select watermark from ${engine.connection.sql(RECONCILER_STATE_TABLE)} where key = ${`${TENANT}:transitions`}
    `
    const wm = wmRow?.watermark
    // Add a fresh record AFTER the watermark, then corrupt its
    // transition. Watermarked sweep should pick this one up.
    const { recordId: rid } = await createCleanRecord(engine, 'wm3b')
    const transitions = await engine.connection.sql<{ id: string; tenant_id: string }[]>`
        select id, tenant_id from "txn_transitions" where txn_id = ${rid}
      `
    expect(transitions[0]?.id ?? '').toBeTruthy()
    expect((transitions[0]?.id ?? '') > (wm ?? '')).toBe(true)
    await engine.connection.sql.unsafe(`
      update "txn_transitions"
      set postings_checksum = decode('00', 'hex')
      where tenant_id = '${TENANT}' and txn_id = '${rid}'
    `)
    const r = await engine.reconciler.runOnce({ tenantId: TENANT, quarantine: false })
    expect(r.anomalies.some((a) => a.check === 'checksum_mismatch')).toBe(true)
  })
})

describe('connection — read-replica routing', () => {
  it('reports hasReplica=false and routes reads to primary by default', async () => {
    if (!dbUrl || !engine) return
    expect(engine.connection.hasReplica).toBe(false)

    // Reads still work via withTenantReplica, just routed to primary.
    const out = await engine.connection.withTenantReplica(TENANT, async (tx) => {
      const [row] = await tx<{ id: string }[]>`select id from "tenants" where id = ${TENANT}`
      return row?.id
    })
    expect(out).toBe(TENANT)
  })

  it('routes reads to the configured replica URL', async () => {
    if (!dbUrl || !engine) return
    // Use the same Postgres for both URLs in test (separate pool, same DB).
    const conn = openConnection({ url: dbUrl, readUrl: dbUrl })
    expect(conn.hasReplica).toBe(true)
    const out = await conn.withTenantReplica(TENANT, async (tx) => {
      const [row] = await tx<{ id: string }[]>`select id from "tenants" where id = ${TENANT}`
      return row?.id
    })
    expect(out).toBe(TENANT)
    await conn.close()
  })
})
