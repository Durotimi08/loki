import type { Adapter, AdapterDefinition } from './types.js'

/**
 * Compile an `AdapterDefinition` into an `Adapter`. Validates the
 * declaration (no empty name, intent keys must match the adapter
 * prefix, no duplicate inbound events) and produces the runtime
 * helpers `engine.registerAdapter` expects.
 *
 * @example
 *   export const stripeAdapter = defineAdapter({
 *     name: 'stripe',
 *     outbound: {
 *       capture: async (event, { confirm, fail }) => {
 *         try {
 *           const r = await stripe.paymentIntents.capture(event.payload['paymentIntent'] as string)
 *           await confirm({ transition: 'mark_captured', data: { stripeId: r.id } })
 *         } catch (e) {
 *           if ((e as { code?: string }).code === 'card_declined') {
 *             await fail({ transition: 'mark_capture_failed', data: { reason: e.message } })
 *           } else {
 *             throw e // retry via outbox backoff
 *           }
 *         }
 *       },
 *     },
 *     inbound: {
 *       'payment_intent.succeeded': (event) => ({
 *         transition: 'mark_funded',
 *         txnId: event.metadata.txnId,
 *         idempotencyKey: `stripe:${event.id}`,
 *         data: { pspReference: event.id, amount: BigInt(event.amount) },
 *       }),
 *     },
 *   })
 */
export function defineAdapter(definition: AdapterDefinition): Adapter {
  if (!definition.name || !/^[a-z][a-z0-9_]*$/.test(definition.name)) {
    throw new Error(
      `Adapter name "${definition.name}" must match /^[a-z][a-z0-9_]*$/ (lowercase identifier).`,
    )
  }

  const prefix = `${definition.name}.`
  const intents = new Set<string>()
  for (const action of Object.keys(definition.outbound ?? {})) {
    if (action.length === 0) {
      throw new Error(`Adapter "${definition.name}" has an empty outbound action key.`)
    }
    intents.add(`${prefix}${action}`)
  }

  const inboundEvents = new Set(Object.keys(definition.inbound ?? {}))

  return {
    _kind: 'adapter',
    name: definition.name,
    intents,
    inboundEvents,

    matches(event) {
      if (event.intent === null || event.intent === undefined) return false
      return intents.has(event.intent)
    },

    async runOutbound(event, ctx) {
      if (event.intent === null || event.intent === undefined) {
        throw new Error(
          `Adapter "${definition.name}": outbox row ${event.id} has no intent — refusing to handle.`,
        )
      }
      if (!intents.has(event.intent)) {
        throw new Error(
          `Adapter "${definition.name}": no handler registered for intent "${event.intent}".`,
        )
      }
      const action = event.intent.slice(prefix.length)
      const handler = definition.outbound?.[action]
      if (!handler) {
        throw new Error(`Adapter "${definition.name}": handler for "${action}" missing at runtime.`)
      }
      await handler(event, ctx)
    },

    async runInbound(eventName, payload, _ctx) {
      const mapper = definition.inbound?.[eventName]
      if (!mapper) {
        throw new Error(`Adapter "${definition.name}": no inbound mapper for event "${eventName}".`)
      }
      const result = await mapper(payload)
      return result
    },
  }
}
