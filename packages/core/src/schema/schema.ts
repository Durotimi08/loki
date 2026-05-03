import type {
  ActorDef,
  AliasMap,
  ProjectionDef,
  SchemaDef,
  TenantDef,
  TransactionDef,
} from './types.js'
import { validateSchema } from './validate.js'
export { diffSchemas } from './diff.js'
export type { ChangeKind, SchemaChange, SchemaDiff } from './diff.js'
export { defineProjection } from './projection.js'
export type { ProjectionInput } from './projection.js'

export type SchemaInputArgs<
  TTenant extends TenantDef,
  TActors extends readonly ActorDef[],
  TTransactions extends readonly TransactionDef[],
> = {
  readonly tenant: TTenant
  readonly actors: TActors
  readonly transactions: TTransactions
  /**
   * Schema version stamped on every record + transition written under
   * this schema. Bump on every rename / additive change. Defaults
   * to 1.
   */
  readonly version?: number
  /**
   * Per-version alias maps. Map old names from earlier versions to the
   * names this schema declares so old records keep their original
   * semantics while new code reads with the new names.
   */
  readonly aliases?: Readonly<Record<number, AliasMap>>
  /**
   * Materialized projections (§12.9). Each entry is built via
   * `defineProjection(name, ...)`; the engine creates a `proj_<name>`
   * table at migration time and maintains it synchronously inside the
   * transition tx.
   */
  readonly projections?: readonly ProjectionDef[]
  /**
   * Skip validation. Tests use this to assert that broken schemas are
   * detected at validation time without throwing during construction.
   * Production callers should leave this `false` (the default).
   */
  readonly skipValidation?: boolean
}

/**
 * Compose the schema. Validates structure, name uniqueness, state
 * legality, posting reachability, and key references. Throws
 * `SchemaError` on failure.
 *
 * @example
 *   export default defineSchema({
 *     tenant:       Org,
 *     actors:       [User, Driver, Company, System],
 *     transactions: [DeliveryPayment, Subscription],
 *   })
 */
export function defineSchema<
  const TTenant extends TenantDef,
  const TActors extends readonly ActorDef[],
  const TTransactions extends readonly TransactionDef[],
>(
  input: SchemaInputArgs<TTenant, TActors, TTransactions>,
): SchemaDef<TTenant, TActors, TTransactions> {
  const actorsByName = new Map<string, ActorDef>()
  for (const actor of input.actors) actorsByName.set(actor.name, actor)

  const transactionsByName = new Map<string, TransactionDef>()
  for (const txn of input.transactions) transactionsByName.set(txn.name, txn)

  const schema: SchemaDef<TTenant, TActors, TTransactions> = {
    _kind: 'schema',
    tenant: input.tenant,
    actors: input.actors,
    transactions: input.transactions,
    version: input.version ?? 1,
    aliases: input.aliases ?? {},
    projections: input.projections ?? [],
    meta: {
      actorsByName,
      transactionsByName,
    },
  }

  if (!input.skipValidation) {
    validateSchema(schema, { throwOnError: true })
  }

  return schema
}
