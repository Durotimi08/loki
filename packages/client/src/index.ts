// `@loki/client` — typed runtime client.
//
// Wraps the generic `engine.forTenant(...).transactions.*` surface in a
// schema-driven facade where each transaction type gets its own
// namespace (`client.deliveryPayment.create / transition / get /
// trace`) with payload types narrowed per transition.

export const CLIENT_PACKAGE = '@loki/client'

export { defineClient } from './define-client.js'
export type {
  CreateInput,
  DataOf,
  Decapitalize,
  ParticipantsInput,
  StatesOf,
  TransactionClient,
  TransitionInput,
  TransitionNames,
  TypedClient,
} from './types.js'
