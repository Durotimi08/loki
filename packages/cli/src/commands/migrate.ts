import { createEngine } from '@loki/core'
import type { LokiConfig } from '../config.js'
import type { Io } from '../io.js'

export type MigrateAction = 'apply' | 'plan' | 'rollback' | 'status'

export async function runMigrate(
  config: LokiConfig,
  action: MigrateAction,
  io: Io,
): Promise<number> {
  const engine = createEngine({
    schema: config.schema,
    connection: config.connection,
    ...(config.migration ? { migration: config.migration } : {}),
  })
  try {
    switch (action) {
      case 'plan': {
        for (const plan of engine.migrations) {
          io.out(`-- Plan: ${plan.id} (UP)`)
          io.out(plan.toUpSql())
          io.out(`-- Plan: ${plan.id} (DOWN)`)
          io.out(plan.toDownSql())
        }
        return 0
      }
      case 'apply': {
        const applied = await engine.migrate()
        if (applied.length === 0) {
          io.out('No pending migrations.')
        } else {
          for (const a of applied) {
            io.out(
              `Applied ${a.id} (sha256:${a.checksum.slice(0, 12)}…) at ${a.applied_at.toISOString()}`,
            )
          }
        }
        return 0
      }
      case 'rollback': {
        await engine.rollback()
        io.out('Rolled back the most recent migration.')
        return 0
      }
      case 'status': {
        const status = await engine.migrator.status(engine.migrations)
        io.out(`Applied: ${status.applied.length}`)
        for (const a of status.applied) io.out(`  - ${a.id} (${a.applied_at.toISOString()})`)
        io.out(`Pending: ${status.pending.length}`)
        for (const p of status.pending) io.out(`  - ${p.id}`)
        return 0
      }
    }
  } finally {
    await engine.close()
  }
}
