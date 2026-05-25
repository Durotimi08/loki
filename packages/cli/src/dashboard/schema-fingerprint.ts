/**
 * Stable hash of the static schema description. Surfaced on
 * `/api/v1/version` so a deployed dashboard can be matched to the
 * schema it was launched against. Changes whenever an actor / account /
 * transaction / transition / state is added or renamed.
 *
 * Implementation: SHA-256 over a deterministic JSON projection of the
 * schema (functions and the `meta` lookup maps are excluded — they're
 * derivative state). Sorted keys make the hash reproducible across
 * runtimes.
 */
import { createHash } from 'node:crypto'
import type { SchemaDef } from '@loki/core'

export type SchemaSnapshot = {
  readonly tenant: string
  readonly version: number
  readonly actors: readonly {
    readonly name: string
    readonly accounts: readonly {
      readonly name: string
      readonly currency: string
      readonly shards: number
      readonly allowOverdraft: boolean
    }[]
  }[]
  readonly transactions: readonly {
    readonly name: string
    readonly states: readonly string[]
    readonly initial: string
    readonly terminal: readonly string[]
    readonly transitions: readonly string[]
  }[]
  readonly projections: readonly string[]
}

export function describeSchema(schema: SchemaDef): SchemaSnapshot {
  return {
    tenant: schema.tenant.name,
    version: schema.version,
    actors: [...schema.actors]
      .map((a) => ({
        name: a.name,
        accounts: Object.values(a.accounts)
          .map((acc) => ({
            name: acc.name,
            currency: acc.currency,
            shards: acc.shards,
            allowOverdraft: acc.allowOverdraft,
          }))
          .sort(byName),
      }))
      .sort(byName),
    transactions: [...schema.transactions]
      .map((t) => ({
        name: t.name,
        states: [...t.states],
        initial: t.initial,
        terminal: [...t.terminal],
        transitions: Object.keys(t.transitions).sort(),
      }))
      .sort(byName),
    projections: schema.projections.map((p) => p.name).sort(),
  }
}

export function fingerprintSchema(schema: SchemaDef): string {
  const json = JSON.stringify(describeSchema(schema))
  return createHash('sha256').update(json).digest('hex').slice(0, 32)
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}
