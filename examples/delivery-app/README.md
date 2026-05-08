# delivery-app — Loki example

Two-sided marketplace: a user pays for a delivery, the driver gets paid, the company keeps a fee. The user can refund within a window — the engine mints a one-shot capability key on `pay` that's required to drive `refund`.

The `§15.1` example from `project.md` reduced to its smallest runnable form.

## What it shows

- One transaction type, two transitions, three actors.
- Capability-key gating: `unlocks: ['refund']` on `pay`, `needs: 'refund'` on the refund.
- Sharded company.revenue (so a high-traffic merchant doesn't bottleneck on a single row).
- Idempotency — re-running `pnpm start` against the same DB is a no-op for the demo flow.
- Outbox handler that logs the `delivery.paid` and `delivery.refunded` events.
- Reconciler running in the background (60s interval, no anomalies expected on a clean flow).
- Lifecycle: `installShutdownHandlers` wires SIGTERM / SIGINT to stop the workers cleanly.

## What it deliberately doesn't show

- HTTP layer / request auth / front-end.
- Real PSP integration (Stripe, Paystack, etc). See `../escrow-with-stripe/` for an adapter-driven example.
- Multi-currency, FX, holds, disputes. See the corresponding sections in the project root README.

## Running it

```sh
pnpm install
export DATABASE_URL="postgres://loki:loki@localhost:5432/loki_examples"
pnpm migrate            # one-time per database
pnpm start              # runs the demo flow
```

You can re-run `pnpm start` repeatedly — every transition uses an idempotency key, so the second invocation is a no-op replay.
