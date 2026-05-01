import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { AccountDef, AccountOptions, ActorDef } from './types.js'

export type ActorInput<TAccounts extends Readonly<Record<string, AccountOptions>>> = {
  readonly fields?: StandardSchemaV1
  readonly accounts?: TAccounts
}

type ExpandAccounts<
  TActorName extends string,
  TAccounts extends Readonly<Record<string, AccountOptions>>,
> = {
  readonly [K in keyof TAccounts & string]: AccountDef<TActorName, K>
}

/**
 * Declares an actor primitive — a typed party that can drive transitions.
 *
 * Accounts attached to the actor are declared inline as a name → options
 * map. They are expanded into `AccountDef` objects so the rest of the
 * schema can reference them by full identity.
 *
 * @example
 *   const Driver = defineActor('Driver', {
 *     fields: z.object({ name: z.string() }),
 *     accounts: {
 *       balance:   { currency: 'NGN' },
 *       reserved:  { currency: 'NGN' },
 *     },
 *   })
 *
 *   // Driver.accounts.balance is a typed AccountDef<'Driver', 'balance'>
 */
export function defineActor<
  const TName extends string,
  const TAccounts extends Readonly<Record<string, AccountOptions>> = Readonly<
    Record<string, AccountOptions>
  >,
>(
  name: TName,
  input: ActorInput<TAccounts> = {},
): ActorDef<TName, ExpandAccounts<TName, TAccounts>> {
  const accounts = {} as Record<string, AccountDef<TName>>
  const specs = (input.accounts ?? {}) as Readonly<Record<string, AccountOptions>>
  for (const accountName of Object.keys(specs)) {
    const opts = specs[accountName] as AccountOptions
    accounts[accountName] = {
      _kind: 'account',
      actorName: name,
      name: accountName,
      currency: opts.currency,
      shards: opts.shards ?? 1,
      ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
    }
  }

  return {
    _kind: 'actor',
    name,
    ...(input.fields !== undefined ? { fields: input.fields } : {}),
    accounts: accounts as ExpandAccounts<TName, TAccounts>,
  }
}
