import { defineActor, defineSchema, defineTenant, defineTransaction } from '@loki/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'

/**
 * Stand-in for a Standard Schema validator (zod / valibot / arktype).
 * Real apps plug in the real thing.
 */
const stub = <T>(): StandardSchemaV1<T, T> => ({
  '~standard': {
    version: 1,
    vendor: 'loki-example',
    validate: (value: unknown) => ({ value: value as T }),
    types: { input: undefined as unknown as T, output: undefined as unknown as T },
  },
})

// =============================================================================
// Actors
// =============================================================================
//
// The escrow demo deliberately spans two currencies so the FX hook
// has a real role. NGN flows from buyer; EUR flows to seller.
// Platform-side accounts split into NGN- and EUR-denominated buckets
// because Loki's `unbalanced_postings` invariant enforces sum(D) ===
// sum(C) **per currency** — you can't have a single transition with
// 1500 NGN debited and 0.84 EUR credited; each currency must close
// internally. The two `fx_clearing_*` accounts accumulate the
// cross-currency imbalance, settled out-of-band when the platform
// actually moves money between FX reserves.

export const Org = defineTenant('Org')

export const Buyer = defineActor('Buyer', {
  accounts: {
    wallet: { currency: 'NGN' },
  },
})

export const Seller = defineActor('Seller', {
  accounts: {
    balance: { currency: 'EUR' },
  },
})

export const Platform = defineActor('Platform', {
  accounts: {
    // Funds the buyer authorized + we eventually captured.
    escrow_ngn: { currency: 'NGN' },
    // Platform's NGN-side revenue (per-transaction fee).
    revenue_ngn: { currency: 'NGN' },
    // FX clearing — these accounts accumulate the cross-currency
    // imbalance that the platform settles separately.
    fx_clearing_ngn: { currency: 'NGN' },
    fx_clearing_eur: { currency: 'EUR' },
  },
})

// `System` is a marker actor for adapter-driven transitions. The
// mocked PSP defaults to `{ type: 'System', id: 'mockedpsp' }` when
// it drives the follow-up `mark_authorized` / `mark_auth_failed`
// transitions; declaring System keeps that path typed.
export const System = defineActor('System')

// `Funder` is the demo's stand-in for the buyer's external funding
// source (a bank, a card top-up). Its `source` account can run
// negative — every top-up debits Funder.source by the deposited
// amount and credits Buyer.wallet, so the reconciler sees balanced
// postings instead of drift from a raw-SQL pre-fund.
export const Funder = defineActor('Funder', {
  accounts: {
    source: { currency: 'NGN', allowOverdraft: true },
  },
})

// =============================================================================
// Escrow transaction
// =============================================================================
//
// Lifecycle:
//
//   pending
//     │ authorize           (intent: 'mockedpsp.authorize')
//     ▼
//   pending_auth
//     │ mark_authorized      (adapter success)            ──► authorized
//     │ mark_auth_failed     (adapter failure)            ──► auth_failed
//     ▼
//   authorized
//     │ capture              (move buyer.wallet → escrow)
//     ▼
//   captured
//     │ release              (NGN → EUR settlement, FX rate pinned)
//     │ reverse              (refund buyer, undo capture)
//     ▼
//   released | reversed
//
// Holds (engine.holds.*) and disputes (engine.disputes.*) are
// orchestrated *alongside* the state machine — see main.ts.

// =============================================================================
// WalletTopUp transaction — credit the buyer's wallet from Funder.source
// =============================================================================

export const WalletTopUp = defineTransaction('WalletTopUp', {
  states: ['pending', 'completed'],
  initial: 'pending',
  terminal: ['completed'],
  participants: { buyer: Buyer, funder: Funder },
  transitions: (t) => ({
    deposit: t({
      from: 'pending',
      to: 'completed',
      by: [System],
      payload: stub<{ amount_ngn: bigint; source: string }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.funder.source, amount: data.amount_ngn },
        { direction: 'C', account: participants.buyer.wallet, amount: data.amount_ngn },
      ],
      emit: 'wallet.topped_up',
    }),
  }),
})

export const Escrow = defineTransaction('Escrow', {
  states: [
    'pending',
    'pending_auth',
    'authorized',
    'auth_failed',
    'captured',
    'released',
    'reversed',
  ],
  initial: 'pending',
  terminal: ['auth_failed', 'released', 'reversed'],
  participants: { buyer: Buyer, seller: Seller, platform: Platform },
  transitions: (t) => ({
    // ----------------------------------------------------------------
    // 1. authorize — buyer initiates. Adapter calls PSP to AUTH.
    // ----------------------------------------------------------------
    authorize: t({
      from: 'pending',
      to: 'pending_auth',
      by: [Buyer],
      payload: stub<{ amount_ngn: bigint; orderId: string }>(),
      // No postings — AUTH doesn't move money. The hold record (in
      // txn_holds) tracks the authorization separately.
      // The intent routes the outbox row through the mocked PSP
      // adapter; the adapter calls confirm/fail, which drives the
      // mark_authorized / mark_auth_failed transition.
      intent: 'mockedpsp.authorize',
      emit: 'escrow.auth_requested',
    }),

    mark_authorized: t({
      from: 'pending_auth',
      to: 'authorized',
      by: [System],
      payload: stub<{ pspReference: string }>(),
      // Still no postings — we just record the AUTH succeeded.
      emit: 'escrow.authorized',
    }),

    mark_auth_failed: t({
      from: 'pending_auth',
      to: 'auth_failed',
      by: [System],
      payload: stub<{ reason: string }>(),
      emit: 'escrow.auth_failed',
    }),

    // ----------------------------------------------------------------
    // 2. capture — move money from buyer's wallet into escrow. This
    //    is the first transition that actually changes balances.
    // ----------------------------------------------------------------
    capture: t({
      from: 'authorized',
      to: 'captured',
      by: [Platform],
      payload: stub<{ amount_ngn: bigint }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.buyer.wallet, amount: data.amount_ngn },
        { direction: 'C', account: participants.platform.escrow_ngn, amount: data.amount_ngn },
      ],
      // Two outcomes possible from `captured`: settlement or reversal.
      // Two distinct keys are minted; whichever fires first consumes
      // its key, the other one stays active until expired.
      unlocks: ['release', 'reverse'],
      emit: 'escrow.captured',
    }),

    // ----------------------------------------------------------------
    // 3a. release — split the captured NGN into platform fee + EUR
    //     payout to seller. Rate pinned in payload; reconciler verifies.
    // ----------------------------------------------------------------
    release: t({
      from: 'captured',
      to: 'released',
      by: [Platform],
      needs: 'release',
      payload: stub<{
        // NGN amount being converted to EUR (post-fee)
        amount_ngn: bigint
        platform_fee_ngn: bigint
        // EUR amount the seller receives, in minor units (cents)
        seller_amount_eur: bigint
        // Rate as decimal string. The reconciler's fx_rate_drift
        // check compares this to the most recent fx_rates row.
        rate: string
        baseCurrency: string
        quoteCurrency: string
        rateSource: string
      }>(),
      // Per-currency balance:
      //   NGN: D escrow=total      vs C revenue=fee + C fx_clearing=remainder
      //   EUR: D fx_clearing=eur   vs C seller=eur
      postings: ({ data, participants }) => [
        // NGN side — three postings, must sum to zero.
        {
          direction: 'D',
          account: participants.platform.escrow_ngn,
          amount: data.amount_ngn + data.platform_fee_ngn,
        },
        {
          direction: 'C',
          account: participants.platform.revenue_ngn,
          amount: data.platform_fee_ngn,
        },
        {
          direction: 'C',
          account: participants.platform.fx_clearing_ngn,
          amount: data.amount_ngn,
        },
        // EUR side — two postings, must sum to zero.
        {
          direction: 'D',
          account: participants.platform.fx_clearing_eur,
          amount: data.seller_amount_eur,
        },
        {
          direction: 'C',
          account: participants.seller.balance,
          amount: data.seller_amount_eur,
        },
      ],
      // Sanity: seller_amount_eur must approximate amount_ngn * rate.
      // Per-currency balance is engine-enforced; this is the inter-
      // currency check that the engine can't do without rate context.
      invariant: ({ data }) => {
        const rate = Number.parseFloat(data.rate)
        if (!Number.isFinite(rate) || rate <= 0) return false
        const expectedEur = Math.round(Number(data.amount_ngn) * rate)
        const actualEur = Number(data.seller_amount_eur)
        // Allow ±1 minor-unit slack for rounding.
        return Math.abs(expectedEur - actualEur) <= 1
      },
      emit: 'escrow.released',
    }),

    // ----------------------------------------------------------------
    // 3b. reverse — refund the buyer. invert:capture moves money
    //     back from escrow to wallet.
    // ----------------------------------------------------------------
    reverse: t({
      from: 'captured',
      to: 'reversed',
      by: [Platform],
      needs: 'reverse',
      payload: stub<{ reason: string; disputeId?: string }>(),
      postings: 'invert:capture',
      // Routes through the mocked PSP to issue an actual refund. In
      // production this would hit Stripe's `refunds.create`.
      intent: 'mockedpsp.refund',
      emit: 'escrow.reversed',
    }),
  }),
})

export const schema = defineSchema({
  tenant: Org,
  actors: [Buyer, Seller, Platform, System, Funder],
  transactions: [WalletTopUp, Escrow],
})
