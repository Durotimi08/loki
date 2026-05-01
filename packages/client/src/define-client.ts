import type {
  CreateRecordInput,
  Engine,
  SchemaDef,
  TenantClient,
  TransitionInputArgs,
} from '@loki/core'
import type { TransactionClient, TypedClient } from './types.js'

/**
 * Build a typed runtime client from an `Engine` and a tenant id.
 * One property per declared transaction (`client.deliveryPayment`,
 * `client.subscription`, …) with `create` / `transition` / `get` /
 * `trace` methods scoped to that transaction's payload types.
 *
 * @example
 *   const engine = createEngine({ schema, connection })
 *   await engine.migrate()
 *   const client = defineClient(engine, 'org-acme')
 *
 *   const txn = await client.deliveryPayment.create({
 *     by:             user,
 *     idempotencyKey: 'd-9001:create',
 *     participants:   { user, driver, company },
 *   })
 *
 *   const r = await client.deliveryPayment.transition(txn.record.id, 'pay', {
 *     by:             user,
 *     idempotencyKey: 'd-9001:pay',
 *     data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
 *   })
 */
export function defineClient<S extends SchemaDef>(engine: Engine, tenantId: string): TypedClient<S>
export function defineClient<S extends SchemaDef>(
  engine: Engine,
  tenantId: string,
): TypedClient<S> {
  const tenant = engine.forTenant(tenantId)
  const schema = engine.schema as S

  const out: Record<string, unknown> = { tenantId }
  for (const tx of schema.transactions) {
    const key = decapitalize(tx.name)
    out[key] = buildTransactionClient(tenant, tx.name)
  }

  return out as TypedClient<S>
}

function buildTransactionClient(tenant: TenantClient, type: string): TransactionClient<never> {
  return {
    async create(input) {
      const args: CreateRecordInput = {
        type,
        by: input.by,
        idempotencyKey: input.idempotencyKey,
        ...(input.participants !== undefined ? { participants: input.participants } : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      }
      return tenant.transactions.create(args)
    },
    async transition(id, name, input) {
      const args: TransitionInputArgs = {
        id,
        name: name as string,
        by: input.by,
        idempotencyKey: input.idempotencyKey,
        ...(input.data !== undefined ? { data: input.data as Record<string, unknown> } : {}),
        ...(input.withKey !== undefined ? { withKey: input.withKey } : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      }
      return tenant.transactions.transition(args)
    },
    get(id) {
      return tenant.transactions.get(id)
    },
    trace(id) {
      return tenant.transactions.trace(id)
    },
  } as TransactionClient<never>
}

function decapitalize(s: string): string {
  if (s.length === 0) return s
  return `${s[0]?.toLowerCase() ?? ''}${s.slice(1)}`
}
