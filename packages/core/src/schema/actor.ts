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
    const shards = opts.shards ?? 1
    // Default `false` — for a money-movement library, the safe
    // posture is "refuse to take an account negative unless the
    // schema explicitly opts in." Liability accounts, FX clearing,
    // and external-funding sources opt in via `allowOverdraft: true`.
    const allowOverdraft = opts.allowOverdraft ?? false
    if (!allowOverdraft && shards > 1) {
      // Cross-shard balance check would race with concurrent
      // single-shard writes — the constraint is unenforceable. Refuse
      // the combination so an operator never thinks they have an
      // overdraft guard when they don't.
      throw new Error(
        `${name}.${accountName}: allowOverdraft: false cannot combine with shards > 1. Pick one.`,
      )
    }
    accounts[accountName] = {
      _kind: 'account',
      actorName: name,
      name: accountName,
      currency: opts.currency,
      shards,
      allowOverdraft,
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
