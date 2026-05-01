import { createEngine } from '@loki/core'
import type { LokiConfig } from '../config.js'
import type { Io } from '../io.js'

export type ReconcileOptions = {
  readonly tenant?: string
  readonly quarantine?: boolean
}

export async function runReconcile(
  config: LokiConfig,
  options: ReconcileOptions,
  io: Io,
): Promise<number> {
  const engine = createEngine({
    schema: config.schema,
    connection: config.connection,
    ...(config.migration ? { migration: config.migration } : {}),
  })
  try {
    const result = await engine.reconciler.runOnce({
      ...(options.tenant !== undefined ? { tenantId: options.tenant } : {}),
      ...(options.quarantine !== undefined ? { quarantine: options.quarantine } : {}),
    })
    io.out(`Anomalies:   ${result.anomalies.length}`)
    io.out(`Quarantined: ${result.quarantined.length}`)
    for (const a of result.anomalies) {
      const txnPart = a.txnId ? ` txn=${a.txnId}` : ''
      const accountPart = a.accountId ? ` account=${a.accountId}` : ''
      io.out(`  [${a.severity}] ${a.check}${txnPart}${accountPart}`)
    }
    return result.anomalies.length === 0 ? 0 : 1
  } finally {
    await engine.close()
  }
}
