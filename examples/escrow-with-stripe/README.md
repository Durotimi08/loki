# escrow-with-stripe — Loki example

End-to-end marketplace escrow flow. The buyer authorizes a charge in NGN; on capture, money moves into a platform escrow account; on release, NGN settles into the seller's EUR balance via the M16 FX rate hook (with a per-transaction platform fee). On dispute, the buyer is made whole via a reverse transition that also goes through the (mocked) PSP for an actual refund.

## What it shows

Every subsystem, end-to-end, in one runnable demo:

- **Adapter pipeline** (`engine.adapters` + `@loki/adapter-mocked`) — a `mockedpsp` adapter handles two intents (`mockedpsp.authorize` and `mockedpsp.refund`). The `authorize` transition emits `intent: 'mockedpsp.authorize'`; the adapter calls the mocked PSP, then drives `mark_authorized` (success) or `mark_auth_failed` (failure) on the same record. Same shape for refunds during `reverse`.
- **First-class holds** (`engine.holds`) — every authorize places a `txn_holds` row tracking the auth lifecycle. On capture we release the hold; on auth-failure we let `expireDue` flip it from `placed` → `expired`.
- **First-class disputes** (`engine.disputes`) — a dispute is opened against the captured transition, resolved in the customer's favor, and the reverse transition fires.
- **Capability keys for two outcomes** — capture mints both `release` and `reverse` keys; whichever follow-up runs first consumes its key. The other stays active until expired.
- **Multi-currency settlement** (`engine.fx`) — the `release` transition splits NGN into a platform fee (NGN-side) and an FX clearing leg that credits the seller's EUR balance. The transition payload pins the rate (`data.rate`, `data.baseCurrency`, `data.quoteCurrency`, `data.rateSource`); the reconciler's `fx_rate_drift` check verifies it later.
- **Per-currency balance** — each transition closes `sum(D) === sum(C)` per currency. The `release` transition has 5 postings: 3 NGN (D=150k vs C=10k+140k) + 2 EUR (D=84 vs C=84). The two `fx_clearing_*` accounts accumulate the cross-currency imbalance for out-of-band FX settlement.
- **Reconciler** — runs once at the end, reports zero anomalies on a clean flow.

## What it deliberately doesn't show

- HTTP / webhook signature verification. See `verifyInboundSignature` and `engine.adapters.handleInbound` for the inbound path; the demo only drives the outbound path.
- Real Stripe. The `@loki/adapter-mocked` PSP echoes deterministic outcomes the test queues. Swap in a real `defineAdapter({ name: 'stripe', outbound: { authorize: …, refund: … } })` for production — the engine surface stays identical.
- Time-bounded dispute window enforcement. The example opens a dispute and resolves it inline; in production the scheduler fires `disputes.expireDue` periodically.

## Schema at a glance

```
Buyer
  └─ wallet (NGN)

Seller
  └─ balance (EUR)

Platform
  ├─ escrow_ngn       (NGN)  — funds in flight
  ├─ revenue_ngn      (NGN)  — platform fee accrues here
  ├─ fx_clearing_ngn  (NGN)  — credit side of the FX conversion
  └─ fx_clearing_eur  (EUR)  — debit side of the FX conversion
```

Why two FX clearing accounts? Loki's `unbalanced_postings` invariant is per-currency; you can't write a single transition that debits NGN and credits EUR. The two clearing accounts let the `release` transition close both currencies internally; their net balance is the platform's outstanding FX position, settled separately when the platform actually moves money between reserves.

## State machine

```
pending
  │ authorize          (intent: mockedpsp.authorize)
  ▼
pending_auth
  │ mark_authorized    (adapter success)   →  authorized
  │ mark_auth_failed   (adapter failure)   →  auth_failed (terminal)
  ▼
authorized
  │ capture            (move buyer.wallet → platform.escrow)
  ▼
captured
  │ release            (NGN→EUR settle, FX rate pinned)   →  released (terminal)
  │ reverse            (refund buyer, intent: mockedpsp.refund)  →  reversed (terminal)
```

## Running it

```sh
cd examples/escrow-with-stripe
pnpm install
export DATABASE_URL="postgres://loki:loki@localhost:5432/loki_examples"
pnpm migrate            # one-time per database
pnpm start              # runs all three flows in sequence
```

You'll see (paraphrased):

```
──────────────  flow 1: happy path  ──────────────
record … created
authorize landed (record now in pending_auth)
hold … placed for 150000 kobo
adapter ran; record state = authorized
capture landed; hold released
release landed; seller credited 84 EUR-cents at rate 0.0006 (demo-feed)
verify: ok

──────────────  flow 2: failed auth  ──────────────
adapter rejected auth; record state = auth_failed
hold … expired (count=1)

──────────────  flow 3: dispute → reverse  ──────────────
captured
dispute … opened (deadline …)
dispute resolved: resolved_customer
record state = reversed
buyer's most recent posting amount: 150000 (sign per direction)

──────────────  reconcile  ──────────────
reconciler: 0 anomalies, 0 quarantined
```

Re-running `pnpm start` is safe — every transition uses an idempotency key, so the second invocation replays without changing state.
