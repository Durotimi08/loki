import { createEngine } from '@loki/core'
import type { LokiConfig } from '../config.js'
import type { Io } from '../io.js'

export type AnomaliesAction =
  | {
      readonly kind: 'list'
      readonly tenant?: string
      readonly severity?: 'warn' | 'error' | 'critical'
      readonly check?: string
      readonly unresolvedOnly?: boolean
      readonly limit?: number
    }
  | {
      readonly kind: 'resolve'
      readonly id: string
      readonly tenant: string
      readonly by: string
      readonly note: string
    }

export async function runAnomalies(
  config: LokiConfig,
  action: AnomaliesAction,
  io: Io,
): Promise<number> {
  const engine = createEngine({
    schema: config.schema,
    connection: config.connection,
    ...(config.migration ? { migration: config.migration } : {}),
  })
  try {
    switch (action.kind) {
      case 'list': {
        if (!action.tenant) {
          io.err('anomalies list: --tenant <id> is required (queries are tenant-scoped).')
          return 2
        }
        const c = engine.forTenant(action.tenant)
        const page = await c.queries.anomalies.findMany({
          where: {
            ...(action.severity ? { severity: [action.severity] } : {}),
            ...(action.check ? { check: action.check } : {}),
            ...(action.unresolvedOnly ? { resolved: false } : {}),
          },
          limit: action.limit ?? 50,
        })
        if (page.items.length === 0) {
          io.out('No anomalies.')
          return 0
        }
        for (const a of page.items) {
          const txnPart = a.txnId ? ` txn=${a.txnId}` : ''
          const accountPart = a.accountId ? ` account=${a.accountId}` : ''
          const status = a.resolvedAt ? `resolved by ${a.resolvedBy ?? '?'}` : 'open'
          io.out(
            `${a.id} [${a.severity}] ${a.check}${txnPart}${accountPart} (${status}) — ${a.detectedAt.toISOString()}`,
          )
        }
        if (page.nextCursor) {
          io.out(`(more results available — re-run with --limit > ${page.items.length})`)
        }
        return 0
      }
      case 'resolve': {
        await engine.connection.withTenant(action.tenant, async (tx) => {
          await tx`
            update "txn_anomalies"
            set resolved_at = now(),
                resolved_by = ${action.by},
                resolution = ${action.note}
            where id = ${action.id}
          `
        })
        io.out(`Resolved ${action.id}.`)
        return 0
      }
    }
  } finally {
    await engine.close()
  }
}
