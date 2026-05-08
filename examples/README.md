# Loki examples

Runnable starters that show how to wire `@loki/core` into common money-movement workloads. Each one is a self-contained TypeScript project; clone, set `DATABASE_URL`, install, run.

| folder | what | scope |
|---|---|---|
| [delivery-app/](./delivery-app) | Two-sided marketplace: user pays, driver gets paid, company keeps a fee. Mirror of the §15.1 example. | The minimal happy path. Posting math, capability keys, refund. |
| [subscription/](./subscription) | Recurring billing with prorated upgrades, cancellations, and retries. | Scheduled transitions, outbox webhooks, idempotent retries. |
| [escrow-with-stripe/](./escrow-with-stripe) | Escrow flow with a Stripe adapter — fund, hold, release or refund. | Adapters, holds, dispute lifecycle. |

## Running an example

Every example follows the same shape:

```sh
cd examples/<folder>
pnpm install
export DATABASE_URL="postgres://loki:loki@localhost:5432/loki_examples"
pnpm migrate    # one-time
pnpm start      # runs the demo flow against your DB
```

## What each example covers vs. doesn't

These are **starters** for adopting Loki — not full applications. Each:

- ✅ Defines a complete schema, runs migrations, drives the happy path.
- ✅ Shows the typed runtime API you'd hit from a request handler.
- ✅ Wires the reconciler + outbox worker + graceful shutdown.
- ❌ Does NOT include the HTTP layer, request auth, or front-end.
- ❌ Does NOT include real PSP credentials. The Stripe example uses `@loki/adapter-mocked` for everything an HTTP boundary would do.

If you find a workflow that's not represented here and is broadly useful, open an issue with the schema sketch.
