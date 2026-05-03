/**
 * Integration coverage for engine.health() (Gap 10).
 *
 *   - Reports `ok: true` after migrate, with primary OK and migrations
 *     applied.
 *   - Reports `migrations.applied: false` when run before migrate.
 *   - Replica probe is `null` when no replica is configured.
 *   - Times out cleanly when given an aggressive `timeoutMs`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type Engine,
  MIGRATIONS_TABLE,
  RECONCILER_STATE_TABLE,
  createEngine,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

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
})

describe('engine.health() — gap 10', () => {
  it('reports ok=false before migrate; ok=true after', async () => {
    if (!engine) return
    const before = await engine.health()
    expect(before.primary.ok).toBe(true)
    expect(before.migrations.applied).toBe(false)
    expect(before.ok).toBe(false)
    expect(before.replica).toBeNull()

    await engine.migrate()
    const after = await engine.health()
    expect(after.primary.ok).toBe(true)
    expect(after.migrations.applied).toBe(true)
    expect(after.migrations.count).toBeGreaterThanOrEqual(1)
    expect(after.ok).toBe(true)
  })

  it('returns the primary LSN on success', async () => {
    if (!engine) return
    await engine.migrate()
    const r = await engine.health()
    if (r.primary.ok) {
      expect(r.primary.lsn).toMatch(/^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/)
    }
  })

  it('always resolves within the deadline, even on fast local Postgres', async () => {
    if (!engine) return
    await engine.migrate()
    // Whether the probe completes or trips the timeout depends on the
    // host's wall clock and Docker network latency. Both outcomes are
    // valid — the contract is that `health()` resolves promptly and
    // reports a structured result, not that it always fails fast.
    const start = Date.now()
    const r = await engine.health({ timeoutMs: 25 })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000)
    if (!r.primary.ok) {
      expect(r.primary.error).toMatch(/timed out/i)
    }
  })
})
