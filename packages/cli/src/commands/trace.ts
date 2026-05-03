import { createEngine, sha256Hasher } from '@loki/core'
import type { LokiConfig } from '../config.js'
import type { Io } from '../io.js'

export type TraceAction =
  | { readonly kind: 'show'; readonly tenant: string; readonly txnId: string }
  | { readonly kind: 'verify'; readonly tenant: string; readonly txnId: string }

/**
 * `loki trace <txnId> --tenant <id>` — print the full transition trail
 * for a record. `--verify` recomputes the hash chain and reports any
 * tamper. Both are read-only.
 */
export async function runTrace(config: LokiConfig, action: TraceAction, io: Io): Promise<number> {
  const engine = createEngine({
    schema: config.schema,
    connection: config.connection,
    ...(config.migration ? { migration: config.migration } : {}),
  })
  try {
    const c = engine.forTenant(action.tenant)
    const record = await c.transactions.get(action.txnId)
    if (!record) {
      io.err(`No record with id "${action.txnId}" in tenant "${action.tenant}".`)
      return 1
    }

    if (action.kind === 'verify') {
      const result = await c.queries.verify(action.txnId, sha256Hasher)
      io.out(`Record:    ${record.id}`)
      io.out(`Type:      ${record.type}`)
      io.out(`State:     ${record.state}`)
      io.out(`Verified:  ${result.ok ? 'YES' : 'NO'}`)
      io.out(`Checked:   ${result.transitionsChecked} transition(s)`)
      if (!result.ok) {
        for (const issue of result.issues) {
          io.out(
            `  - ${issue.check} on transition ${issue.transitionId}: expected=${issue.expected} observed=${issue.observed}`,
          )
        }
      }
      return result.ok ? 0 : 1
    }

    const trail = await c.transactions.trace(action.txnId)
    io.out(`Record:    ${record.id}`)
    io.out(`Type:      ${record.type}`)
    io.out(`State:     ${record.state}`)
    io.out(`Version:   ${record.version}`)
    io.out(`Created:   ${record.createdAt.toISOString()}`)
    io.out(`Updated:   ${record.updatedAt.toISOString()}`)
    io.out('')
    io.out(`Transitions (${trail.length}):`)
    for (const t of trail) {
      const fromTo = `${t.fromState ?? '<init>'} → ${t.toState}`
      io.out(`  [${t.id}] ${t.name} (${fromTo}) by ${t.actor.type}:${t.actor.id}`)
      io.out(`           ${t.occurredAt.toISOString()} — schema_version=${t.schemaVersion}`)
    }
    return 0
  } finally {
    await engine.close()
  }
}
