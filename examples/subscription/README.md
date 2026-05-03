# subscription — Loki example

Recurring billing with proration on upgrade, idempotent retries on PSP failure, and scheduled cancellations.

> **Status:** schema sketched; the implementation lives in `src/`. This README is the authoritative tour — the code is straight TypeScript, no HTTP or frontend.

## Schema sketch

```ts
const Subscription = defineTransaction('Subscription', {
  states: ['trialing', 'active', 'past_due', 'cancelled', 'expired'],
  initial: 'trialing',
  terminal: ['cancelled', 'expired'],
  participants: { customer: Customer, plan: Plan, processor: Processor },
  transitions: (t) => ({
    activate: t({
      from: ['trialing', 'past_due'],
      to: 'active',
      by: [Processor],
      payload: stub<{ amount: bigint; periodStart: Date; periodEnd: Date }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.customer.wallet, amount: data.amount },
        { direction: 'C', account: participants.plan.revenue, amount: data.amount },
      ],
      emit: 'subscription.activated',
    }),
    upgrade: t({
      from: 'active',
      to: 'active',
      by: [Customer],
      payload: stub<{ newAmount: bigint; prorationCharge: bigint; newPeriodEnd: Date }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.customer.wallet, amount: data.prorationCharge },
        { direction: 'C', account: participants.plan.revenue, amount: data.prorationCharge },
      ],
      // The cron-style scheduled `renewal` keeps firing — the upgrade
      // doesn't move state, just bumps the next-period amount.
      emit: 'subscription.upgraded',
    }),
    fail_charge: t({
      from: 'active',
      to: 'past_due',
      by: [Processor],
      payload: stub<{ reason: string }>(),
      emit: 'subscription.payment_failed',
    }),
    cancel: t({
      from: ['active', 'past_due', 'trialing'],
      to: 'cancelled',
      by: [Customer],
      emit: 'subscription.cancelled',
    }),
  }),
})
```

## What it shows

- **Multi-source `from`** — `activate` accepts both `trialing` and `past_due`, so a retry after a PSP-side decline lands cleanly.
- **Same-state transitions** — `upgrade` keeps the record `active` but writes a proration posting. The audit trail still shows the upgrade as a discrete event.
- **Scheduled transitions** — `engine.scheduler.create({ runAt: nextRenewalAt, name: 'activate' })` schedules the next charge. The scheduler worker fires at `runAt`; if the call fails it retries via the existing outbox semantics.
- **Idempotency under retry** — the PSP-side adapter passes a deterministic idempotency key (`renewal:<subscriptionId>:<periodStart>`); a duplicate fire is a no-op replay.

## What it deliberately doesn't show

- Plan management / pricing logic — that's a separate `Plan` aggregate the application owns.
- Tax handling — usually a per-region calculation that runs before `activate`.

## Running it

```sh
pnpm install
export DATABASE_URL="postgres://loki:loki@localhost:5432/loki_examples"
pnpm migrate
pnpm start              # drives one full cycle: activate → upgrade → fail → recover → cancel
```

> The demo uses an in-memory clock so the scheduled renewal fires immediately. Your application would use the real clock and the scheduler worker.
