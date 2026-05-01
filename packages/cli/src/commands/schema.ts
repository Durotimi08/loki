import { createEngine, diffSchemas } from '@loki/core'
import type { LokiConfig } from '../config.js'
import type { Io } from '../io.js'

export type SchemaAction =
  | { readonly kind: 'versions'; readonly tenant?: string }
  | { readonly kind: 'diff'; readonly fromConfig: string }

/**
 * `loki schema versions [--tenant <id>]` — counts records and
 * transitions per stored `schema_version`. Tells you whether it's
 * safe to delete compatibility code for an old version.
 *
 * `loki schema diff --from <other-config-path>` — classifies every
 * change between two schemas as additive / rename / restrictive /
 * destructive, and exits 1 if any destructive changes are present
 * without an alias map (so it can be used as a CI gate).
 */
export async function runSchema(config: LokiConfig, action: SchemaAction, io: Io): Promise<number> {
  switch (action.kind) {
    case 'versions': {
      const engine = createEngine({
        schema: config.schema,
        connection: config.connection,
        ...(config.migration ? { migration: config.migration } : {}),
      })
      try {
        const counts = await engine.admin.schema.versions(action.tenant)
        if (counts.length === 0) {
          io.out('No records yet.')
          return 0
        }
        io.out('VERSION  RECORDS  TRANSITIONS')
        for (const c of counts) {
          io.out(
            `${String(c.version).padStart(7)}  ${String(c.records).padStart(7)}  ${String(c.transitions).padStart(11)}`,
          )
        }
        return 0
      } finally {
        await engine.close()
      }
    }
    case 'diff': {
      // Load the comparison schema dynamically. We don't open a DB
      // connection here — `diffSchemas` is pure.
      const { loadConfig } = await import('../config.js')
      const other = await loadConfig({ path: action.fromConfig })
      const diff = diffSchemas(other.schema, config.schema)
      io.out(`v${diff.fromVersion} → v${diff.toVersion}`)
      io.out(
        `  additive=${diff.counts.additive} rename=${diff.counts.rename} restrictive=${diff.counts.restrictive} destructive=${diff.counts.destructive}`,
      )
      for (const change of diff.changes) {
        const tag = `[${change.kind}]`.padEnd(15)
        io.out(`  ${tag} ${change.description}`)
      }
      return diff.counts.destructive > 0 ? 1 : 0
    }
  }
}
