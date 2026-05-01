import { randomUUID } from 'node:crypto'
import type { SqlTransaction } from './connection.js'
import type { AnomalyCheckName, AnomalyEvent, AnomalySeverity } from './hooks.js'

/**
 * Severity defaults — used by the reconciler when a check doesn't
 * specify its own. Hash-chain breaks and checksum mismatches are
 * critical because they imply someone wrote outside the engine.
 */
export const DEFAULT_SEVERITY: Readonly<Record<AnomalyCheckName, AnomalySeverity>> = {
  balance_drift: 'error',
  unbalanced_postings: 'critical',
  hash_chain_break: 'critical',
  checksum_mismatch: 'critical',
  state_mismatch: 'error',
  fabricated_key: 'critical',
}

export type AnomalyDraft = {
  readonly tenantId: string
  readonly check: AnomalyCheckName
  readonly severity?: AnomalySeverity
  readonly txnId?: string
  readonly txnType?: string
  readonly accountId?: string
  readonly expected: unknown
  readonly observed: unknown
  readonly context?: Record<string, unknown>
}

/**
 * Insert an anomaly row and return the corresponding hook event.
 * Caller is responsible for routing the event to the hook registry.
 */
export async function recordAnomaly(
  tx: SqlTransaction,
  draft: AnomalyDraft,
): Promise<AnomalyEvent> {
  const id = randomUUID()
  const detectedAt = new Date()
  const severity = draft.severity ?? DEFAULT_SEVERITY[draft.check]

  await tx`
    insert into "txn_anomalies" (
      id, tenant_id, detected_at, check_name, txn_id, account_id,
      expected, observed, severity
    ) values (
      ${id},
      ${draft.tenantId},
      ${detectedAt},
      ${draft.check},
      ${draft.txnId ?? null},
      ${draft.accountId ?? null},
      ${tx.json(toJsonValue(draft.expected) as never)},
      ${tx.json(toJsonValue(draft.observed) as never)},
      ${severity}
    )
  `

  return {
    id,
    tenantId: draft.tenantId,
    check: draft.check,
    severity,
    detectedAt,
    ...(draft.txnId !== undefined ? { txnId: draft.txnId } : {}),
    ...(draft.txnType !== undefined ? { txnType: draft.txnType } : {}),
    ...(draft.accountId !== undefined ? { accountId: draft.accountId } : {}),
    expected: draft.expected,
    observed: draft.observed,
    ...(draft.context !== undefined ? { context: draft.context } : {}),
  }
}

/**
 * Mark an anomaly resolved. Used by self-correction when a reversal
 * transition repairs the underlying problem (M5+).
 */
export async function markResolved(
  tx: SqlTransaction,
  anomalyId: string,
  resolvedBy: string,
  resolution: string,
): Promise<void> {
  await tx`
    update "txn_anomalies"
    set resolved_at = now(), resolved_by = ${resolvedBy}, resolution = ${resolution}
    where id = ${anomalyId}
  `
}

/**
 * Convert a value to something postgres.js's `json()` can serialize:
 * bigints become strings, Buffers/Uint8Arrays become hex strings,
 * Dates become ISO strings, everything else passes through.
 */
function toJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('hex')
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) out[k] = toJsonValue(v[k])
    return out
  }
  return value
}
