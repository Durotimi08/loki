import { describe, expect, it } from 'vitest'
import { buildPartitionsOps } from '../src/index.js'

/**
 * H6 — `buildPartitionsOps` previously string-concatenated
 * `EnsureForOptions.tablePrefix` straight into DDL via `tx.unsafe(...)`,
 * letting a misconfigured ops invocation inject SQL. The fix validates
 * the prefix at the entry point before any DB call. We exercise the
 * validator directly here; the actual `CREATE TABLE` path is covered
 * by the integration suite.
 */

const fakeConnection = {
  sql: {} as never,
  readSql: null,
  hasReplica: false,
  withTenant: async () => undefined as never,
  withTenantReplica: async () => undefined as never,
  asAdmin: async () => undefined as never,
  close: async () => undefined,
}

describe('partitions — H6 prefix validation', () => {
  const ops = buildPartitionsOps(fakeConnection)

  it('rejects a prefix containing quote injection', async () => {
    await expect(
      ops.ensureFor(new Date('2026-01-15Z'), {
        tablePrefix: '"; DROP TABLE postings; --',
      }),
    ).rejects.toThrow(/tablePrefix/)
  })

  it('rejects a prefix with whitespace', async () => {
    await expect(
      ops.ensureFor(new Date('2026-01-15Z'), { tablePrefix: 'evil prefix' }),
    ).rejects.toThrow(/tablePrefix/)
  })

  it('rejects a prefix that starts with a digit', async () => {
    await expect(ops.ensureFor(new Date('2026-01-15Z'), { tablePrefix: '1foo' })).rejects.toThrow(
      /tablePrefix/,
    )
  })

  it('rejects similarly on list()', async () => {
    await expect(ops.list('postings', { tablePrefix: 'evil; --' })).rejects.toThrow(/tablePrefix/)
  })

  it('the empty prefix is fine (no validation tripped)', async () => {
    // `''` is allowed — but the asAdmin stub above doesn't actually run,
    // so the call resolves without DB work. We just want to make sure the
    // entry-point validator does NOT throw on empty input.
    await expect(ops.ensureFor(new Date('2026-01-15Z'), { tablePrefix: '' })).resolves.toBeDefined()
  })

  it('a valid identifier prefix passes the gate', async () => {
    await expect(
      ops.ensureFor(new Date('2026-01-15Z'), { tablePrefix: 'app_' }),
    ).resolves.toBeDefined()
  })
})
