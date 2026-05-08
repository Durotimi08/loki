/**
 * Integration coverage for batch 8 — every new feature exercised end-
 * to-end against real Postgres:
 *
 *   - 5 new hook types (onIntegrityViolation / onReversal /
 *     onReconciliationComplete / onSchemaMigration / onTenantLifecycle)
 *   - reconciler: fabricated_key check, drift auto-repair
 *   - capability key TTL expiration
 *   - random shard routing
 *   - query API: verify, actor.trails, actor.accounts, account.aggregate
 *   - bulkTransition
 *   - tenant.export
 *   - saga runner (forward + compensation)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  type IntegrityViolationEvent,
  MIGRATIONS_TABLE,
  RECONCILER_STATE_TABLE,
  type ReconciliationCompleteEvent,
  type ReversalEvent,
  type SchemaMigrationEvent,
  type TenantLifecycleEvent,
  createEngine,
  runSaga,
  sha256Hasher,
} from '../../src/index.js'
import { chidoriSchema, topUpWallet } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

const TENANT = 'org-batch8'
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
  await engine.admin.tenants.create({ id: TENANT, name: 'Batch8' })
})

const drivePay = async (
  e: Engine,
  suffix: string,
): Promise<{ recordId: string; refundKeyId: string }> => {
  const c = e.forTenant(TENANT)
  const user = { type: 'User', id: `u-${suffix}` }
  const driver = { type: 'Driver', id: `d-${suffix}` }
  const company = { type: 'Company', id: 'co-1' }
  await c.accounts.create({ actor: user, name: 'wallet' })
  await c.accounts.create({ actor: driver, name: 'balance' })
  await c.accounts.create({ actor: company, name: 'revenue' })
  await topUpWallet(e, TENANT, user.id, 1500n)
  const txn = await c.transactions.create({
    type: 'DeliveryPayment',
    by: user,
    participants: { user, driver, company },
    idempotencyKey: `${suffix}:create`,
  })
  const r = await c.transactions.transition({
    id: txn.record.id,
    name: 'pay',
    by: user,
    data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    idempotencyKey: `${suffix}:pay`,
  })
  return { recordId: txn.record.id, refundKeyId: r.unlocked['refund'] as string }
}

// =============================================================================
// New hook types
// =============================================================================

describe('hooks — new event types fire from the right call sites', () => {
  it('onSchemaMigration fires for migrate() and rollback()', async () => {
    if (!engine) return
    const seen: SchemaMigrationEvent[] = []
    engine.hooks.onSchemaMigration(undefined, async (e) => {
      seen.push(e)
    })
    // engine.migrate() in beforeEach already fired one. Roll back +
    // re-apply to capture both directions.
    await engine.rollback()
    await engine.migrate()
    const directions = seen.map((e) => e.direction)
    expect(directions).toContain('down')
    expect(directions).toContain('up')
  })

  it('onTenantLifecycle fires on create / suspend / activate / delete', async () => {
    if (!engine) return
    const seen: TenantLifecycleEvent[] = []
    engine.hooks.onTenantLifecycle(undefined, async (e) => {
      seen.push(e)
    })
    await engine.admin.tenants.create({ id: 'org-life', name: 'L' })
    await engine.admin.tenants.suspend('org-life')
    await engine.admin.tenants.activate('org-life')
    await engine.admin.tenants.delete('org-life')
    const actions = seen.map((e) => e.action)
    expect(actions).toEqual(['created', 'suspended', 'activated', 'deleted'])
  })

  it('onReconciliationComplete fires after every runOnce()', async () => {
    if (!engine) return
    const seen: ReconciliationCompleteEvent[] = []
    engine.hooks.onReconciliationComplete(undefined, async (e) => {
      seen.push(e)
    })
    await engine.reconciler.runOnce()
    await engine.reconciler.runOnce({ tenantId: TENANT })
    expect(seen).toHaveLength(2)
    expect(seen[0]?.fullSweep).toBe(true)
    expect(seen[1]?.tenantId).toBe(TENANT)
  })

  it('onIntegrityViolation is a critical-only subset of onAnomaly', async () => {
    if (!engine) return
    const violations: IntegrityViolationEvent[] = []
    engine.hooks.onIntegrityViolation(undefined, async (e) => {
      violations.push(e)
    })
    const { recordId } = await drivePay(engine, 'iv')
    // Tamper to provoke a hash chain break (critical).
    await engine.connection.sql.unsafe(
      `update "txn_transitions" set to_state = 'failed' where name = 'pay' and txn_id = '${recordId}'`,
    )
    await engine.reconciler.runOnce()
    expect(violations.length).toBeGreaterThan(0)
    for (const v of violations) expect(v.severity).toBe('critical')
  })

  it('onReversal fires when an `invert:` transition lands', async () => {
    if (!engine) return
    const seen: ReversalEvent[] = []
    engine.hooks.onReversal(undefined, async (e) => {
      seen.push(e)
    })
    const { recordId, refundKeyId } = await drivePay(engine, 'rev')
    await engine.forTenant(TENANT).transactions.transition({
      id: recordId,
      name: 'refund',
      by: { type: 'Company', id: 'co-1' },
      withKey: refundKeyId,
      data: { reason: 'qa' },
      idempotencyKey: 'rev:refund',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.transitionName).toBe('refund')
    expect(seen[0]?.automated).toBe(false)
  })
})

// =============================================================================
// Reconciler: fabricated_key + drift auto-repair
// =============================================================================

describe('reconciler — fabricated_key', () => {
  it('detects an `active` key whose granted_by_transition_id does not exist', async () => {
    if (!engine) return
    const { recordId } = await drivePay(engine, 'fab')
    // Production threat model: an admin role bypasses constraints
    // (e.g. via `ALTER TABLE ... DISABLE TRIGGER ALL`) and writes a
    // bogus row. Simulate by suspending the FK trigger for the insert.
    await engine.connection.sql.unsafe(`
      alter table "txn_keys" disable trigger all;
      insert into "txn_keys" (tenant_id, txn_id, name, granted_by_transition_id, status)
      values ('${TENANT}', '${recordId}', 'refund', '01HFAKEFAKEFAKEFAKEFAKEFAK', 'active');
      alter table "txn_keys" enable trigger all;
    `)
    const result = await engine.reconciler.runOnce({ quarantine: false })
    expect(result.anomalies.some((a) => a.check === 'fabricated_key')).toBe(true)
  })
})

describe('reconciler — drift auto-repair', () => {
  it('rebuilds balance from postings when repairBalanceDrift is set', async () => {
    if (!engine) return
    const { recordId: _ } = await drivePay(engine, 'repair')
    // Tamper the user's wallet balance directly. Postings sum says
    // -1500 (the pay debit); we shove it to 999 so drift is huge.
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 999 where owner_actor_type = 'User' and owner_actor_id = 'u-repair'`,
    )

    // Detect + repair in one pass — that's the production usage. The
    // per-check watermark only re-examines accounts whose postings
    // have moved since last sweep, so a detect-only pass followed by
    // a repair-only pass would skip the second one.
    const result = await engine.reconciler.runOnce({
      quarantine: false,
      repairBalanceDrift: true,
    })
    expect(result.anomalies.some((a) => a.check === 'balance_drift')).toBe(true)
    expect(result.repaired.length).toBeGreaterThan(0)

    // Drift gone; postings sum is the truth (1500n debited from a 0
    // starting balance → -1500n).
    const tenant = engine.forTenant(TENANT)
    expect(
      await tenant.accounts.balance({
        actor: { type: 'User', id: 'u-repair' },
        name: 'wallet',
        currency: 'NGN',
      }),
    ).toBe(-1500n)

    // A subsequent fullSweep confirms no drift remains (the watermarked
    // pass would skip the now-quiet account anyway).
    const clean = await engine.reconciler.runOnce({ quarantine: false, fullSweep: true })
    expect(clean.anomalies.some((a) => a.check === 'balance_drift')).toBe(false)
  })
})

// =============================================================================
// Capability key TTL
// =============================================================================

describe('capability key expiration', () => {
  it('engine refuses to consume an expired key', async () => {
    if (!engine) return
    const { recordId, refundKeyId } = await drivePay(engine, 'ttl')
    await engine.connection.sql.unsafe(
      `update "txn_keys" set expires_at = now() - interval '1 minute' where id = '${refundKeyId}'`,
    )
    await expect(
      engine.forTenant(TENANT).transactions.transition({
        id: recordId,
        name: 'refund',
        by: { type: 'Company', id: 'co-1' },
        withKey: refundKeyId,
        data: { reason: 'too-late' },
        idempotencyKey: 'ttl:refund',
      }),
    ).rejects.toThrow(/active or has already been consumed/i)
  })

  it('reconciler janitor flips stale active keys to expired', async () => {
    if (!engine) return
    const { refundKeyId } = await drivePay(engine, 'ttl-janitor')
    await engine.connection.sql.unsafe(
      `update "txn_keys" set expires_at = now() - interval '1 minute' where id = '${refundKeyId}'`,
    )
    const result = await engine.reconciler.runOnce({ quarantine: false })
    expect(result.expiredKeys).toBeGreaterThanOrEqual(1)
    const [row] = await engine.connection.sql<{ status: string }[]>`
      select status from "txn_keys" where id = ${refundKeyId}
    `
    expect(row?.status).toBe('expired')
  })
})

// =============================================================================
// Random shard routing
// =============================================================================

describe('random shard routing', () => {
  it('distributes postings across all 16 shards of Company.revenue', async () => {
    if (!engine) return
    // Drive enough payments that the random pick spreads across shards
    // with overwhelming probability (16 shards, 50 postings → expected
    // empty-shard probability ≈ (15/16)^50 ≈ 4%; we relax to ≥ 4 used
    // shards to keep the test deterministic without being flaky).
    for (let i = 0; i < 50; i++) {
      await drivePay(engine, `shard-${i}`)
    }
    const usedShards = await engine.connection.sql<{ shard_index: number }[]>`
      select distinct a.shard_index from "postings" p
      join "accounts" a on a.id = p.account_id
      where p.tenant_id = ${TENANT}
        and a.owner_actor_type = 'Company'
        and a.name = 'revenue'
    `
    expect(usedShards.length).toBeGreaterThanOrEqual(4)
    // Sum across shards still matches expected revenue.
    const tenant = engine.forTenant(TENANT)
    expect(
      await tenant.accounts.balance({
        actor: { type: 'Company', id: 'co-1' },
        name: 'revenue',
        currency: 'NGN',
      }),
    ).toBe(50n * 1000n)
  })
})

// =============================================================================
// Query API completions
// =============================================================================

describe('query API — verify, trails, accounts, aggregate', () => {
  it('verify(txnId) reports ok on an untampered record', async () => {
    if (!engine) return
    const { recordId } = await drivePay(engine, 'verify-ok')
    const result = await engine.forTenant(TENANT).queries.verify(recordId, sha256Hasher)
    expect(result.ok).toBe(true)
    expect(result.transitionsChecked).toBe(2) // _init + pay
  })

  it('verify(txnId) flags a tampered transition', async () => {
    if (!engine) return
    const { recordId } = await drivePay(engine, 'verify-bad')
    await engine.connection.sql.unsafe(
      `update "txn_transitions" set to_state = 'failed' where name = 'pay' and txn_id = '${recordId}'`,
    )
    const result = await engine.forTenant(TENANT).queries.verify(recordId, sha256Hasher)
    expect(result.ok).toBe(false)
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues[0]?.check).toBe('hash_chain_break')
  })

  it('actor().trails returns the full transition trail per record', async () => {
    if (!engine) return
    await drivePay(engine, 'trail')
    const tenant = engine.forTenant(TENANT)
    const page = await tenant.queries.actor({ type: 'User', id: 'u-trail' }).trails({ limit: 10 })
    expect(page.items.length).toBe(1)
    expect(page.items[0]?.trail.map((t) => t.name)).toEqual(['_init', 'pay'])
  })

  it('actor().accounts lists every account owned by an actor', async () => {
    if (!engine) return
    await drivePay(engine, 'acc')
    const accounts = await engine
      .forTenant(TENANT)
      .queries.actor({ type: 'Company', id: 'co-1' })
      .accounts()
    expect(accounts.length).toBe(16) // 16 revenue shards
    for (const a of accounts) expect(a.name).toBe('revenue')
  })

  it('account.aggregate returns count + sum_credit + sum_debit + min/max', async () => {
    if (!engine) return
    await drivePay(engine, 'agg-1')
    await drivePay(engine, 'agg-2')
    const driverBalance = {
      actor: { type: 'Driver', id: 'd-agg-1' },
      name: 'balance',
      currency: 'NGN',
    }
    const stats = await engine.forTenant(TENANT).queries.account.aggregate(driverBalance)
    expect(stats.count).toBe(1)
    expect(stats.sumCredit).toBe(500n)
    expect(stats.sumDebit).toBe(0n)
    expect(stats.minAmount).toBe(500n)
    expect(stats.maxAmount).toBe(500n)
  })
})

// =============================================================================
// Bulk write API
// =============================================================================

describe('bulkTransition', () => {
  it('runs N transitions and reports success/failure per item', async () => {
    if (!engine) return
    const tenant = engine.forTenant(TENANT)
    // Provision three records ready to receive `pay`.
    const created = []
    for (let i = 0; i < 3; i++) {
      const user = { type: 'User', id: `u-bulk-${i}` }
      const driver = { type: 'Driver', id: `d-bulk-${i}` }
      const company = { type: 'Company', id: 'co-1' }
      await tenant.accounts.create({ actor: user, name: 'wallet' })
      await tenant.accounts.create({ actor: driver, name: 'balance' })
      await tenant.accounts.create({ actor: company, name: 'revenue' })
      await topUpWallet(engine, TENANT, user.id, 1500n)
      const txn = await tenant.transactions.create({
        type: 'DeliveryPayment',
        by: user,
        participants: { user, driver, company },
        idempotencyKey: `bulk:${i}:create`,
      })
      created.push({ id: txn.record.id, user })
    }

    const results = await tenant.transactions.bulkTransition([
      // 0: ok
      {
        id: created[0]?.id as string,
        name: 'pay',
        by: created[0]?.user as { type: string; id: string },
        data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
        idempotencyKey: 'bulk:0:pay',
      },
      // 1: bad — refunding from `pending` is illegal
      {
        id: created[1]?.id as string,
        name: 'refund',
        by: { type: 'Company', id: 'co-1' },
        idempotencyKey: 'bulk:1:bad',
      },
      // 2: ok
      {
        id: created[2]?.id as string,
        name: 'pay',
        by: created[2]?.user as { type: string; id: string },
        data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
        idempotencyKey: 'bulk:2:pay',
      },
    ])
    expect(results).toHaveLength(3)
    expect(results[0]?.ok).toBe(true)
    expect(results[1]?.ok).toBe(false)
    expect(results[2]?.ok).toBe(true)
  })

  it('honours stopOnError', async () => {
    if (!engine) return
    const tenant = engine.forTenant(TENANT)
    const results = await tenant.transactions.bulkTransition(
      [
        {
          id: '00000000-0000-0000-0000-000000000000',
          name: 'pay',
          by: { type: 'User', id: 'phantom' },
          idempotencyKey: 'stop:1',
        },
        {
          id: '00000000-0000-0000-0000-000000000001',
          name: 'pay',
          by: { type: 'User', id: 'phantom' },
          idempotencyKey: 'stop:2',
        },
      ],
      { stopOnError: true },
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.ok).toBe(false)
  })
})

// =============================================================================
// Saga runner
// =============================================================================

describe('runSaga', () => {
  it('runs every step forward when each succeeds', async () => {
    if (!engine) return
    const tenant = engine.forTenant(TENANT)
    const { recordId, refundKeyId } = await drivePay(engine, 'saga-ok')
    const company = { type: 'Company', id: 'co-1' }

    const result = await runSaga({ client: tenant, by: company }, [
      {
        name: 'refund',
        forward: () =>
          tenant.transactions.transition({
            id: recordId,
            name: 'refund',
            by: company,
            withKey: refundKeyId,
            data: { reason: 'saga' },
            idempotencyKey: 'saga-ok:refund',
          }),
      },
    ])
    expect(result.ok).toBe(true)
  })

  it('compensates earlier steps when a later step fails', async () => {
    if (!engine) return
    const tenant = engine.forTenant(TENANT)
    const { recordId, refundKeyId } = await drivePay(engine, 'saga-comp')
    const company = { type: 'Company', id: 'co-1' }

    let compensateRan = false
    const result = await runSaga({ client: tenant, by: company }, [
      {
        name: 'refund',
        forward: () =>
          tenant.transactions.transition({
            id: recordId,
            name: 'refund',
            by: company,
            withKey: refundKeyId,
            data: { reason: 'saga' },
            idempotencyKey: 'saga-comp:refund',
          }),
        compensate: async () => {
          compensateRan = true
        },
      },
      {
        name: 'will-fail',
        forward: async () => {
          throw new Error('downstream blew up')
        },
      },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failedStep).toBe('will-fail')
      expect(result.compensated).toEqual(['refund'])
    }
    expect(compensateRan).toBe(true)
  })
})

// =============================================================================
// tenant.export
// =============================================================================

describe('tenant.export', () => {
  it('snapshots every row that belongs to the tenant', async () => {
    if (!engine) return
    await drivePay(engine, 'export')
    const snapshot = await engine.admin.tenants.export(TENANT)
    expect(snapshot.tenantId).toBe(TENANT)
    expect(snapshot.tables['tenants']).toHaveLength(1)
    expect(snapshot.tables['txn_records']?.length ?? 0).toBeGreaterThan(0)
    expect(snapshot.tables['txn_transitions']?.length ?? 0).toBeGreaterThan(0)
    expect(snapshot.tables['postings']?.length ?? 0).toBeGreaterThan(0)
    expect(snapshot.tables['accounts']?.length ?? 0).toBeGreaterThan(0)
    // bytea hashes are emitted as hex (JSON-safe).
    const t = (snapshot.tables['txn_transitions'] ?? []) as Record<string, unknown>[]
    if (t[0]) {
      expect(typeof t[0]['row_hash_hex']).toBe('string')
      expect((t[0]['row_hash_hex'] as string).length).toBe(64)
    }
  })

  it('throws when the tenant does not exist', async () => {
    if (!engine) return
    await expect(engine.admin.tenants.export('does-not-exist')).rejects.toThrow(/not found/)
  })
})
