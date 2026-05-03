import { createMockedPsp } from '@loki/adapter-mocked'
import { type Engine, createEngine, sha256Hasher } from '@loki/core'
import { schema } from './schema.js'

/**
 * End-to-end escrow demo. Three flows fire against a single Engine:
 *
 *   1. Happy path:       authorize → mark_authorized → capture → release
 *                         + multi-currency settlement (NGN → EUR)
 *   2. Failed auth:      authorize → mark_auth_failed
 *                         + hold expired
 *   3. Dispute reverse:  authorize → mark_authorized → capture
 *                         + dispute opened → resolved-customer → reverse
 *
 * Every flow exercises one or more of the subsystems the README
 * promises:
 *
 *   - `engine.adapters` — mocked PSP routes outbox rows for the
 *     authorize and reverse intents, using `confirm` / `fail` to drive
 *     follow-up transitions on the same record.
 *   - `engine.holds`    — a hold record is placed alongside `authorize`
 *     and released or expired depending on the outcome.
 *   - `engine.disputes` — a dispute is opened post-capture; resolving
 *     to the customer triggers the `reverse` transition.
 *   - `engine.fx`       — a published NGN→EUR rate is pinned in the
 *     `release` transition's payload; the reconciler later verifies
 *     it via the `fx_rate_drift` check.
 *
 * Run:
 *
 *     export DATABASE_URL="postgres://loki:loki@localhost:5432/loki_examples"
 *     pnpm migrate
 *     pnpm start
 */

const TENANT = 'platform'

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (!url) {
    console.error('Set DATABASE_URL first.')
    process.exit(1)
  }

  const engine = createEngine({ schema, connection: { url } })

  try {
    await ensureTenant(engine)
    await registerMockedPsp(engine)
    await publishFxRate(engine)

    console.log('\n──────────────  flow 1: happy path  ──────────────')
    await runHappyPath(engine)

    console.log('\n──────────────  flow 2: failed auth  ──────────────')
    await runFailedAuth(engine)

    console.log('\n──────────────  flow 3: dispute → reverse  ──────────────')
    await runDisputeReverse(engine)

    console.log('\n──────────────  reconcile  ──────────────')
    const recon = await engine.reconciler.runOnce({ tenantId: TENANT })
    console.log(
      `reconciler: ${recon.anomalies.length} anomalies, ${recon.quarantined.length} quarantined`,
    )
    if (recon.anomalies.length > 0) {
      for (const a of recon.anomalies) {
        console.log(`  • ${a.check} (${a.severity}) txn=${a.txnId ?? '-'}`)
      }
    }
  } finally {
    await engine.close()
  }
}

// =============================================================================
// One-time setup
// =============================================================================

async function ensureTenant(engine: Engine): Promise<void> {
  const tenants = await engine.admin.tenants.list()
  if (!tenants.some((t) => t.id === TENANT)) {
    await engine.admin.tenants.create({ id: TENANT, name: 'Demo Platform' })
  }
}

let pspRef: ReturnType<typeof createMockedPsp> | null = null

async function registerMockedPsp(engine: Engine): Promise<void> {
  // The adapter publishes one outbound action per intent the schema
  // declares. The schema uses `intent: 'mockedpsp.authorize'` and
  // `intent: 'mockedpsp.refund'`, so we register handlers for both.
  pspRef = createMockedPsp({
    name: 'mockedpsp',
    transitions: {
      authorize: {
        success: 'mark_authorized',
        failure: 'mark_auth_failed',
      },
      // Refund's success/failure transitions are no-ops for the demo
      // — the `reverse` transition itself already moved money. In a
      // real Stripe integration you'd land a `mark_refunded` /
      // `mark_refund_failed` follow-up here.
      refund: {
        success: 'mark_authorized', // reused as a no-op confirm
        failure: 'mark_auth_failed',
      },
    },
  })
  // Avoid double-register on hot-reload.
  if (!engine.adapters.get('mockedpsp')) {
    engine.adapters.register(pspRef.adapter)
  }
}

async function publishFxRate(engine: Engine): Promise<void> {
  // 1 NGN = 0.0006 EUR (illustrative). Published once for the demo;
  // a real deployment would publish every time a feed updates and
  // let the reconciler verify pinned rates against the current row.
  const existing = await engine.fx.lookup({
    tenantId: TENANT,
    baseCurrency: 'NGN',
    quoteCurrency: 'EUR',
  })
  if (existing) return
  await engine.fx.publish({
    tenantId: TENANT,
    baseCurrency: 'NGN',
    quoteCurrency: 'EUR',
    rate: '0.0006',
    source: 'demo-feed',
  })
}

// =============================================================================
// Flow 1: happy path — authorize, capture, release with FX settlement
// =============================================================================

async function runHappyPath(engine: Engine): Promise<void> {
  const c = engine.forTenant(TENANT)
  const buyer = { type: 'Buyer', id: 'b-happy' }
  const seller = { type: 'Seller', id: 's-happy' }
  const platform = { type: 'Platform', id: 'plat' }

  await ensureAccountsForBuyer(engine, buyer.id)
  await ensureAccountsForSeller(engine, seller.id)
  await ensurePlatformAccounts(engine, platform.id)

  // Pre-fund the buyer's wallet with 200,000 kobo (= 2,000 NGN).
  await topUp(engine, buyer.id, 200_000n)

  const txn = await c.transactions.create({
    type: 'Escrow',
    by: buyer,
    participants: { buyer, seller, platform },
    idempotencyKey: 'happy:create',
  })
  console.log(`record ${txn.record.id} created`)

  // ─── authorize ───
  if (!pspRef) throw new Error('PSP not registered')
  pspRef.queue('authorize', {
    kind: 'success',
    data: { pspReference: 'pi_demo_happy' },
  })

  await c.transactions.transition({
    id: txn.record.id,
    name: 'authorize',
    by: buyer,
    idempotencyKey: 'happy:authorize',
    data: { amount_ngn: 150_000n, orderId: 'order-happy' },
  })
  console.log('authorize landed (record now in pending_auth)')

  // Place a hold mirroring the AUTH. In production this happens
  // alongside the transition — for the example we do it post-commit.
  const buyerWalletId = await accountId(engine, buyer.id, 'Buyer', 'wallet')
  const hold = await engine.holds.place({
    tenantId: TENANT,
    holdAccountId: buyerWalletId,
    amount: 150_000n,
    txnId: txn.record.id,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })
  console.log(`hold ${hold.id} placed for ${hold.amount} kobo`)

  // ─── adapter delivers the success outcome ───
  // drainOnce processes every queued outbox row through the registered
  // adapter. The mocked PSP picks the queued 'success' outcome and
  // calls confirm('mark_authorized'), driving the follow-up transition.
  await engine.outbox.drainOnce()
  const afterAuth = await c.transactions.get(txn.record.id)
  console.log(`adapter ran; record state = ${afterAuth?.state}`)

  // ─── capture ───
  // First load the record to find the unlocked refund/release keys
  // from the *capture* transition (which is what we run next).
  await c.transactions.transition({
    id: txn.record.id,
    name: 'capture',
    by: platform,
    idempotencyKey: 'happy:capture',
    data: { amount_ngn: 150_000n },
  })
  // Release the hold record — the money has now moved into escrow.
  await engine.holds.release({ id: hold.id })
  console.log('capture landed; hold released')

  // Find the keys minted by capture so we can drive `release`.
  const captureTrail = await c.transactions.trace(txn.record.id)
  const captureTransition = captureTrail.find((t) => t.name === 'capture')
  if (!captureTransition) throw new Error('capture transition missing')

  // Read the keys directly from the DB. (We could expose this via
  // the typed surface; for the example a raw SELECT is fine.)
  const releaseKeyId = await keyId(engine, txn.record.id, 'release')
  if (!releaseKeyId) throw new Error('release key missing — capture should have unlocked it')

  // ─── release with FX settlement ───
  // Look up the current rate, pin it in payload. The reconciler will
  // verify this rate matches the published fx_rates row at occurred_at.
  const fx = await engine.fx.lookup({
    tenantId: TENANT,
    baseCurrency: 'NGN',
    quoteCurrency: 'EUR',
  })
  if (!fx) throw new Error('FX rate missing')
  const platformFeeNgn = 10_000n // 100 NGN
  const sellerNgn = 150_000n - platformFeeNgn // 1,400 NGN
  // 140000 kobo * 0.0006 ≈ 84 EUR-cents (= 0.84 EUR).
  const sellerEur = BigInt(Math.round(Number(sellerNgn) * Number.parseFloat(fx.rate)))

  await c.transactions.transition({
    id: txn.record.id,
    name: 'release',
    by: platform,
    idempotencyKey: 'happy:release',
    withKey: releaseKeyId,
    data: {
      amount_ngn: sellerNgn,
      platform_fee_ngn: platformFeeNgn,
      seller_amount_eur: sellerEur,
      rate: fx.rate,
      baseCurrency: 'NGN',
      quoteCurrency: 'EUR',
      rateSource: fx.source,
    },
  })
  console.log(
    `release landed; seller credited ${sellerEur} EUR-cents at rate ${fx.rate} (${fx.source})`,
  )

  // Sanity — the chain still verifies.
  const verify = await c.queries.verify(txn.record.id, sha256Hasher)
  console.log(`verify: ${verify.ok ? 'ok' : 'FAILED'}`)
}

// =============================================================================
// Flow 2: failed auth — adapter rejects the authorize call
// =============================================================================

async function runFailedAuth(engine: Engine): Promise<void> {
  const c = engine.forTenant(TENANT)
  const buyer = { type: 'Buyer', id: 'b-fail' }
  const seller = { type: 'Seller', id: 's-fail' }
  const platform = { type: 'Platform', id: 'plat' }

  await ensureAccountsForBuyer(engine, buyer.id)
  await ensureAccountsForSeller(engine, seller.id)
  await ensurePlatformAccounts(engine, platform.id)
  // No top-up — the wallet stays at 0. AUTH still works because no
  // postings move money at the authorize step.

  const txn = await c.transactions.create({
    type: 'Escrow',
    by: buyer,
    participants: { buyer, seller, platform },
    idempotencyKey: 'fail:create',
  })

  if (!pspRef) throw new Error('PSP not registered')
  pspRef.queue('authorize', {
    kind: 'failure',
    data: { reason: 'card_declined' },
  })

  await c.transactions.transition({
    id: txn.record.id,
    name: 'authorize',
    by: buyer,
    idempotencyKey: 'fail:authorize',
    data: { amount_ngn: 100_000n, orderId: 'order-fail' },
  })

  const buyerWalletId = await accountId(engine, buyer.id, 'Buyer', 'wallet')
  const hold = await engine.holds.place({
    tenantId: TENANT,
    holdAccountId: buyerWalletId,
    amount: 100_000n,
    txnId: txn.record.id,
    // 1ms in the past — `expireDue` will pick it up immediately.
    expiresAt: new Date(Date.now() - 1),
  })

  // Drain — adapter calls fail() → mark_auth_failed lands.
  await engine.outbox.drainOnce()
  const after = await c.transactions.get(txn.record.id)
  console.log(`adapter rejected auth; record state = ${after?.state}`)

  // Expire the hold so it doesn't sit `placed` forever.
  const expired = await engine.holds.expireDue()
  console.log(`hold ${hold.id} expired (count=${expired.expired.length})`)
}

// =============================================================================
// Flow 3: dispute — buyer disputes after capture; reverse fires
// =============================================================================

async function runDisputeReverse(engine: Engine): Promise<void> {
  const c = engine.forTenant(TENANT)
  const buyer = { type: 'Buyer', id: 'b-dispute' }
  const seller = { type: 'Seller', id: 's-dispute' }
  const platform = { type: 'Platform', id: 'plat' }

  await ensureAccountsForBuyer(engine, buyer.id)
  await ensureAccountsForSeller(engine, seller.id)
  await ensurePlatformAccounts(engine, platform.id)
  await topUp(engine, buyer.id, 200_000n)

  const txn = await c.transactions.create({
    type: 'Escrow',
    by: buyer,
    participants: { buyer, seller, platform },
    idempotencyKey: 'dispute:create',
  })

  if (!pspRef) throw new Error('PSP not registered')
  pspRef.queue('authorize', {
    kind: 'success',
    data: { pspReference: 'pi_demo_dispute' },
  })

  await c.transactions.transition({
    id: txn.record.id,
    name: 'authorize',
    by: buyer,
    idempotencyKey: 'dispute:authorize',
    data: { amount_ngn: 150_000n, orderId: 'order-dispute' },
  })
  await engine.outbox.drainOnce()

  await c.transactions.transition({
    id: txn.record.id,
    name: 'capture',
    by: platform,
    idempotencyKey: 'dispute:capture',
    data: { amount_ngn: 150_000n },
  })
  console.log('captured')

  // Open a dispute against the capture transition.
  const captureTrail = await c.transactions.trace(txn.record.id)
  const captureTransition = captureTrail.find((t) => t.name === 'capture')
  if (!captureTransition) throw new Error('capture transition missing')
  const dispute = await engine.disputes.open({
    tenantId: TENANT,
    originalTransitionId: captureTransition.id,
    reason: 'unauthorized charge',
    deadlineAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })
  console.log(`dispute ${dispute.id} opened (deadline ${dispute.deadlineAt?.toISOString()})`)

  // Resolve in customer's favor and drive the reverse transition.
  const resolved = await engine.disputes.resolve({
    id: dispute.id,
    outcome: 'customer',
    resolution: 'unauthorized — refund',
  })
  console.log(`dispute resolved: ${resolved.status}`)

  // Find the reverse key, fire reverse. This reverses the capture
  // postings and routes through the mocked PSP for the actual refund.
  const reverseKeyId = await keyId(engine, txn.record.id, 'reverse')
  if (!reverseKeyId) throw new Error('reverse key missing')
  pspRef.queue('refund', {
    kind: 'success',
    data: { pspReference: 'rfnd_demo_dispute' },
  })
  await c.transactions.transition({
    id: txn.record.id,
    name: 'reverse',
    by: platform,
    idempotencyKey: 'dispute:reverse',
    withKey: reverseKeyId,
    data: { reason: 'dispute', disputeId: dispute.id },
  })
  await engine.outbox.drainOnce()

  const final = await c.transactions.get(txn.record.id)
  console.log(`record state = ${final?.state}`)

  // Verify buyer was made whole.
  const buyerBalance = await c.queries.account.history({
    actor: buyer,
    name: 'wallet',
    currency: 'NGN',
  })
  const lastBalance = buyerBalance.items[0]
  console.log(`buyer's most recent posting amount: ${lastBalance?.amount} (sign per direction)`)
}

// =============================================================================
// Helpers — account / hold / key plumbing
// =============================================================================

async function ensureAccountsForBuyer(engine: Engine, id: string): Promise<void> {
  const c = engine.forTenant(TENANT)
  await c.accounts.create({ actor: { type: 'Buyer', id }, name: 'wallet' })
}

async function ensureAccountsForSeller(engine: Engine, id: string): Promise<void> {
  const c = engine.forTenant(TENANT)
  await c.accounts.create({ actor: { type: 'Seller', id }, name: 'balance' })
}

async function ensurePlatformAccounts(engine: Engine, id: string): Promise<void> {
  const c = engine.forTenant(TENANT)
  const platform = { type: 'Platform', id }
  await c.accounts.create({ actor: platform, name: 'escrow_ngn' })
  await c.accounts.create({ actor: platform, name: 'revenue_ngn' })
  await c.accounts.create({ actor: platform, name: 'fx_clearing_ngn' })
  await c.accounts.create({ actor: platform, name: 'fx_clearing_eur' })
}

async function topUp(engine: Engine, buyerId: string, kobo: bigint): Promise<void> {
  // Real top-up: a typed `WalletTopUp` transaction debits a Funder
  // account (which allows overdraft) and credits the buyer's wallet.
  // The reconciler then sees balanced postings, no drift.
  const c = engine.forTenant(TENANT)
  const buyer = { type: 'Buyer', id: buyerId }
  const funder = { type: 'Funder', id: 'demo-bank' }
  await c.accounts.create({ actor: funder, name: 'source' })
  const top = await c.transactions.create({
    type: 'WalletTopUp',
    by: { type: 'System', id: 'topup' },
    participants: { buyer, funder },
    idempotencyKey: `topup:create:${buyerId}:${kobo.toString()}`,
  })
  await c.transactions.transition({
    id: top.record.id,
    name: 'deposit',
    by: { type: 'System', id: 'topup' },
    idempotencyKey: `topup:deposit:${buyerId}:${kobo.toString()}`,
    data: { amount_ngn: kobo, source: 'demo-bank' },
  })
}

async function accountId(
  engine: Engine,
  ownerId: string,
  ownerType: string,
  name: string,
): Promise<string> {
  const [row] = await engine.connection.sql<{ id: string }[]>`
    select id from accounts
    where tenant_id = ${TENANT}
      and owner_actor_type = ${ownerType}
      and owner_actor_id = ${ownerId}
      and name = ${name}
    limit 1
  `
  if (!row) throw new Error(`account ${ownerType}/${ownerId}/${name} not found`)
  return row.id
}

async function keyId(engine: Engine, txnId: string, name: string): Promise<string | null> {
  // Prefer an `active` key (fresh run), fall back to consumed (idempotent
  // replay). On replay the engine doesn't re-check the key — it returns
  // the cached transition result — so we just need a stable id to pass.
  const [row] = await engine.connection.sql<{ id: string; status: string }[]>`
    select id, status from txn_keys
    where tenant_id = ${TENANT}
      and txn_id = ${txnId}
      and name = ${name}
    order by case status when 'active' then 0 else 1 end
    limit 1
  `
  return row?.id ?? null
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
