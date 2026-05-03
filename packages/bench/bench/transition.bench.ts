/**
 * Performance benchmarks (Gap 11). Each `bench(...)` block measures
 * one of the §12.1 budget items in `project.md`:
 *
 *   - transition write — target p99 < 10 ms
 *   - balance read     — target p99 <  1 ms
 *   - reconciler O(Δ)  — target single-pass cost bounded by the
 *                        last sweep's delta
 *   - outbox dispatch  — single drainOnce() iteration cost
 *
 * The benches print to stdout; CI can scrape the verbose reporter
 * output to track regressions over time. Numbers are unverified and
 * deeply hardware-dependent — the budgets in `project.md` are
 * aspirational targets, not guarantees.
 *
 * Skipped silently when no Postgres is reachable so a bench run
 * doesn't fail in unrelated CI matrices.
 */
import { type Engine, MIGRATIONS_TABLE, RECONCILER_STATE_TABLE, createEngine } from '@loki/core'
import { afterAll, beforeAll, bench, describe } from 'vitest'
import { benchSchema } from '../src/schema.js'
import { ensurePostgres, teardownPostgres } from '../src/setup.js'

const TENANT = 'bench-org'
let engine: Engine | null = null
let dbUrl: string | null = null
let recordIdCache: string | null = null

beforeAll(async () => {
  const db = await ensurePostgres()
  dbUrl = db?.url ?? null
  if (!dbUrl) return
  engine = createEngine({ schema: benchSchema, connection: { url: dbUrl } })
  await engine.connection.sql.unsafe(`drop table if exists ${MIGRATIONS_TABLE}`)
  await engine.connection.sql.unsafe(`drop table if exists ${RECONCILER_STATE_TABLE}`)
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'Bench' })
  // Pre-fund a wallet so transitions don't hit overdraft after a few
  // iterations. 100M units is enough headroom for thousands of pays.
  const c = engine.forTenant(TENANT)
  const user = { type: 'User', id: 'u-bench' }
  const driver = { type: 'Driver', id: 'd-bench' }
  const company = { type: 'Company', id: 'co-bench' }
  await c.accounts.create({ actor: user, name: 'wallet' })
  await c.accounts.create({ actor: driver, name: 'balance' })
  await c.accounts.create({ actor: company, name: 'revenue' })
  await engine.connection.sql.unsafe(
    `update "accounts" set balance = 100000000 where owner_actor_type = 'User' and owner_actor_id = '${user.id}'`,
  )
  // Pre-create one record we'll reuse for the transition bench.
  const txn = await c.transactions.create({
    type: 'Pay',
    by: user,
    participants: { user, driver, company },
    idempotencyKey: 'bench:create',
  })
  recordIdCache = txn.record.id
}, 120_000)

afterAll(async () => {
  if (engine) await engine.close()
  await teardownPostgres()
})

describe('engine — transition write', () => {
  let counter = 0
  bench(
    'transactions.transition (1 record, 1 transition each)',
    async () => {
      if (!engine || !recordIdCache) return
      const c = engine.forTenant(TENANT)
      // Each iteration drives a fresh `create` + `pay` because a
      // `Pay` only allows one `pay` per record. The cost is dominated
      // by the genesis write + the pay write.
      const idx = ++counter
      const user = { type: 'User', id: 'u-bench' }
      const driver = { type: 'Driver', id: 'd-bench' }
      const company = { type: 'Company', id: 'co-bench' }
      const txn = await c.transactions.create({
        type: 'Pay',
        by: user,
        participants: { user, driver, company },
        idempotencyKey: `bench:tx:${idx}`,
      })
      await c.transactions.transition({
        id: txn.record.id,
        name: 'pay',
        by: user,
        idempotencyKey: `bench:tx:${idx}:pay`,
        data: { amount: 100n, driverShare: 80n, companyShare: 20n },
      })
    },
    { time: 1500 },
  )
})

describe('engine — read paths', () => {
  bench(
    'queries.account.history (1 record window)',
    async () => {
      if (!engine || !recordIdCache) return
      const c = engine.forTenant(TENANT)
      await c.queries.account.history(
        { actor: { type: 'User', id: 'u-bench' }, name: 'wallet', currency: 'USD' },
        { limit: 50 },
      )
    },
    { time: 1500 },
  )

  bench(
    'transactions.trace (1 record)',
    async () => {
      if (!engine || !recordIdCache) return
      const c = engine.forTenant(TENANT)
      await c.transactions.trace(recordIdCache)
    },
    { time: 1500 },
  )
})

describe('engine — reconciler', () => {
  bench(
    'reconciler.runOnce (incremental; bounded by Δ-since-last-sweep)',
    async () => {
      if (!engine) return
      await engine.reconciler.runOnce({ tenantId: TENANT })
    },
    { time: 1500 },
  )
})

describe('engine — outbox', () => {
  bench(
    'outbox.drainOnce (no-op handler)',
    async () => {
      if (!engine) return
      await engine.outbox.drainOnce({ handler: () => {} })
    },
    { time: 1500 },
  )
})
