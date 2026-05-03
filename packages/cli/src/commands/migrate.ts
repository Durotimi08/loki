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

export type EnforceOptions = {
  readonly enforcerName: string
  readonly tenant?: string
  readonly limit?: number
}

/**
 * `loki migrate enforce <name>` (§14.2) — surface records whose stored
 * transitions violate a newly-introduced invariant. The CLI does NOT
 * automatically drive reversal transitions; that's the operator's call
 * (eviction is schema-specific). Output is a list of (recordId,
 * transitionId, summary) ready to feed into a follow-up script.
 */
export async function runMigrateEnforce(
  config: LokiConfig,
  options: EnforceOptions,
  io: Io,
): Promise<number> {
  const enforcer = config.enforcers?.[options.enforcerName]
  if (!enforcer) {
    io.err(
      `migrate enforce: no enforcer named "${options.enforcerName}" in loki.config. Add one to \`enforcers: { ... }\`.`,
    )
    return 2
  }
  const engine = createEngine({
    schema: config.schema,
    connection: config.connection,
    ...(config.migration ? { migration: config.migration } : {}),
  })
  try {
    const hits = await engine.admin.schema.findViolations({
      ...(options.tenant ? { tenantId: options.tenant } : {}),
      txnType: enforcer.txnType,
      ...(enforcer.transitionName ? { transitionName: enforcer.transitionName } : {}),
      predicate: enforcer.predicate,
      ...(options.limit ? { limit: options.limit } : {}),
    })
    if (enforcer.description) io.out(`# ${enforcer.description}`)
    if (hits.length === 0) {
      io.out('No violations found.')
      return 0
    }
    io.out(`Found ${hits.length} violation(s):`)
    for (const hit of hits) {
      io.out(
        `  record=${hit.recordId} transition=${hit.transition.id} name=${hit.transition.name} actor=${hit.transition.actor.type}:${hit.transition.actor.id}`,
      )
    }
    // Exit 1 so CI gates can fail when violations exist.
    return 1
  } finally {
    await engine.close()
  }
}
