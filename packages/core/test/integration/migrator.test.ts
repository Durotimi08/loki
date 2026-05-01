import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ENGINE_TABLES,
  MIGRATIONS_TABLE,
  MigrationMismatchError,
  createEngine,
  createMigrator,
  openConnection,
  planInitialMigration,
} from '../../src/index.js'
import { chidoriSchema } from '../fixtures.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

describe('migrator — bootstrap apply / rollback', () => {
  let dbUrl: string | null = null

  beforeAll(async () => {
    const db = await ensurePostgres()
    dbUrl = db?.url ?? null
  })

  afterAll(async () => {
    await teardownPostgres()
  })

  it('applies the bootstrap plan, creating every engine table', async () => {
    if (!dbUrl) {
      console.warn('[skip] no Postgres available')
      return
    }
    const engine = createEngine({ schema: chidoriSchema, connection: { url: dbUrl } })
    try {
      const applied = await engine.migrate()
      expect(applied).toHaveLength(1)
      expect(applied[0]?.id).toBe('0001_init')

      // Every engine table should exist.
      const tables = await engine.connection.sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
      `
      const names = new Set(tables.map((t) => t.table_name))
      for (const name of ENGINE_TABLES) {
        expect(names.has(name)).toBe(true)
      }
      expect(names.has(MIGRATIONS_TABLE)).toBe(true)
    } finally {
      // Clean up so the next test starts from zero.
      await engine.rollback()
      await dropMigrations(engine.connection.sql)
      await engine.close()
    }
  })

  it('is idempotent: applying twice in a row does nothing the second time', async () => {
    if (!dbUrl) {
      console.warn('[skip] no Postgres available')
      return
    }
    const engine = createEngine({ schema: chidoriSchema, connection: { url: dbUrl } })
    try {
      const first = await engine.migrate()
      const second = await engine.migrate()
      expect(first).toHaveLength(1)
      expect(second).toHaveLength(0)
    } finally {
      await engine.rollback()
      await dropMigrations(engine.connection.sql)
      await engine.close()
    }
  })

  it('detects checksum drift between recorded and current SQL', async () => {
    if (!dbUrl) {
      console.warn('[skip] no Postgres available')
      return
    }
    const engine = createEngine({ schema: chidoriSchema, connection: { url: dbUrl } })
    try {
      await engine.migrate()
      // Manually corrupt the recorded checksum.
      await engine.connection.sql.unsafe(
        `update ${MIGRATIONS_TABLE} set checksum = 'tampered' where id = '0001_init'`,
      )
      // The next apply attempt should refuse and surface MigrationMismatchError.
      await expect(engine.migrate()).rejects.toBeInstanceOf(MigrationMismatchError)
    } finally {
      await engine.rollback()
      await dropMigrations(engine.connection.sql)
      await engine.close()
    }
  })

  it('rollback drops every engine table', async () => {
    if (!dbUrl) {
      console.warn('[skip] no Postgres available')
      return
    }
    const connection = openConnection({ url: dbUrl })
    const migrator = createMigrator(connection)
    const plan = planInitialMigration(chidoriSchema)
    try {
      await migrator.apply([plan])
      await migrator.rollback(plan)
      const tables = await connection.sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
      `
      const names = new Set(tables.map((t) => t.table_name))
      for (const name of ENGINE_TABLES) {
        expect(names.has(name)).toBe(false)
      }
    } finally {
      await dropMigrations(connection.sql)
      await connection.close()
    }
  })
})

async function dropMigrations(sql: import('postgres').Sql): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE}`)
}
