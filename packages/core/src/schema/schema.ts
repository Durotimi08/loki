import type { ActorDef, SchemaDef, TenantDef, TransactionDef } from './types.js'
import { validateSchema } from './validate.js'

export type SchemaInputArgs<
  TTenant extends TenantDef,
  TActors extends readonly ActorDef[],
  TTransactions extends readonly TransactionDef[],
> = {
  readonly tenant: TTenant
  readonly actors: TActors
  readonly transactions: TTransactions
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
