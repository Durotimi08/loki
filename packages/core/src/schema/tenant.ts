import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { TenantDef } from './types.js'

export type TenantInput = {
  readonly fields?: StandardSchemaV1
}

/**
 * Declares the top-level tenant primitive. Every actor, account,
 * transaction, posting, key, and outbox event lives under exactly
 * one tenant. See `project.md` §7.
 *
 * The optional `fields` Standard Schema validates tenant rows when
 * they are created (`ledger.tenant.create`).
 *
 * @example
 *   const Org = defineTenant('Org', {
 *     fields: z.object({ name: z.string(), region: z.string() }),
 *   })
 */
export function defineTenant<const TName extends string>(
  name: TName,
  input: TenantInput = {},
): TenantDef<TName> {
  return {
    _kind: 'tenant',
    name,
    ...(input.fields !== undefined ? { fields: input.fields } : {}),
  }
}
