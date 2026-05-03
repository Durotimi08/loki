# escrow-with-stripe — Loki example

Marketplace escrow flow:

1. Buyer authorizes a charge against their card via Stripe (`AUTH`).
2. Funds are held in a Loki hold record against an escrow account.
3. On marketplace approval, the hold is released into the seller's balance + a fee into the platform's revenue.
4. On dispute, the hold is reversed back to the buyer.

> **Status:** schema and adapter wiring sketched here. The implementation in `src/` uses `@loki/adapter-mocked` to stand in for Stripe — no real keys required.

## Schema sketch

```ts
const Escrow = defineTransaction('Escrow', {
  states: ['authorized', 'captured', 'released', 'reversed', 'expired'],
  initial: 'authorized',
  terminal: ['released', 'reversed', 'expired'],
  participants: { buyer: Buyer, seller: Seller, platform: Platform },
  transitions: (t) => ({
    capture: t({
      from: 'authorized',
      to: 'captured',
      by: [Platform],
      payload: stub<{ amount: bigint }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.buyer.wallet, amount: data.amount },
        { direction: 'C', account: participants.platform.escrow, amount: data.amount },
      ],
      // intent: routes to the Stripe adapter via engine.adapters
      intent: 'stripe.capture',
      unlocks: ['release', 'reverse'],
    }),
    release: t({
      from: 'captured',
      to: 'released',
      by: [Platform],
      needs: 'release',
      payload: stub<{ sellerShare: bigint; platformShare: bigint }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.platform.escrow, amount: data.sellerShare + data.platformShare },
        { direction: 'C', account: participants.seller.balance, amount: data.sellerShare },
        { direction: 'C', account: participants.platform.revenue, amount: data.platformShare },
      ],
      invariant: ({ data }) => data.sellerShare > 0n && data.platformShare >= 0n,
      emit: 'escrow.released',
    }),
    reverse: t({
      from: 'captured',
      to: 'reversed',
      by: [Platform],
      needs: 'reverse',
      payload: stub<{ reason: string }>(),
      postings: 'invert:capture',
      intent: 'stripe.refund',
      emit: 'escrow.reversed',
    }),
  }),
})
```

## What it shows

- **`intent` vs `emit`** — `capture` declares `intent: 'stripe.capture'`, which the engine routes through the registered Stripe adapter. The adapter calls Stripe with a deterministic idempotency key (`<outboxId>:confirm`), then drives a follow-up Loki transition (`mark_captured` or `mark_capture_failed`). `emit` is fire-and-forget; `intent` is a contract.
- **Capability keys for two outcomes** — `capture` mints both `release` and `reverse`; only one can be consumed (whichever transition fires first marks it consumed).
- **Holds + disputes integration** — see `engine.holds.place / release / expireDue` and `engine.disputes.open / resolve`. The escrow flow uses `engine.holds` for the in-flight authorization; a dispute opened against the captured transition pauses the release.
- **Mocked PSP** — the example uses `@loki/adapter-mocked.createMockedPsp()` so it runs against any local Postgres without real Stripe keys. Swap to the real `defineAdapter({ name: 'stripe', ... })` for production.

## What it deliberately doesn't show

- Stripe webhook signature verification — see `engine.adapters.handleInbound` and `verifyInboundSignature`.
- Multi-currency settlement (the seller's balance might be in a different currency than the platform's revenue) — that's the M16 FX rate hook.

## Running it

```sh
pnpm install
export DATABASE_URL="postgres://loki:loki@localhost:5432/loki_examples"
pnpm migrate
pnpm start              # drives auth → capture → release; then a reversal
```

The mocked PSP echoes every action to stdout so you can see the adapter contract in action.
