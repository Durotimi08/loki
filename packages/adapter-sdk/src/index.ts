// `@loki/adapter-sdk` — public surface for building adapters.
//
// An adapter bridges Loki to an external system. The SDK provides the
// `defineAdapter()` helper that compiles a declaration into a runtime
// helper the engine drives via the outbox worker (outbound) or via a
// consumer-wired HTTP handler (inbound). See §9.
//
// First-party adapters (`@loki/adapter-stripe`, `@loki/adapter-paystack`,
// `@loki/adapter-mocked`, …) ship as separate packages and import this
// SDK.

export const ADAPTER_SDK_PACKAGE = '@loki/adapter-sdk'

export { defineAdapter } from './define-adapter.js'
export type {
  Adapter,
  AdapterDefinition,
  InboundContext,
  InboundMapper,
  InboundResult,
  OutboundContext,
  OutboundHandler,
  TransitionAction,
} from './types.js'
