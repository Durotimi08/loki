import type { ProjectionColumn, ProjectionDef } from './types.js'

export type ProjectionInput = {
  readonly source?: 'txn_transitions'
  readonly when?: { readonly actorType: string }
  readonly columns: readonly ProjectionColumn[]
}

/**
 * Declare a materialized projection. The engine creates `proj_<name>`
 * during migration and writes to it synchronously inside every
 * matching transition's tx — the projection cannot lag.
 *
 * Constraints:
 *   - `tenant_id` is always included (RLS depends on it).
 *   - `id` (transition id) is always included so the projection is
 *     joinable back to the source if you need the full row.
 *   - `columns` must reference real `txn_transitions` columns.
 */
export function defineProjection(name: string, input: ProjectionInput): ProjectionDef {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(
      `Projection name "${name}" is invalid. Use lowercase letters, digits, and underscores.`,
    )
  }
  // Always include tenant_id and id so the projection is queryable
  // under RLS and joinable to its source row.
  const required: readonly ProjectionColumn[] = ['id', 'tenant_id']
  const merged = Array.from(new Set([...required, ...input.columns]))
  return {
    _kind: 'projection',
    name,
    source: input.source ?? 'txn_transitions',
    ...(input.when ? { when: input.when } : {}),
    columns: merged as readonly ProjectionColumn[],
  }
}
