import { createEngine, installShutdownHandlers, sha256Hasher } from '@loki/core'
import { schema } from './schema.js'

/**
 * Demo flow:
 *
 *   1. Create one tenant ("chidori") and three accounts (user, driver, company).
 *   2. Pre-fund the user's wallet so the pay doesn't hit overdraft.
 *   3. Drive `pay` → consumes 1500 from user, credits driver 500 and company 1000.
 *   4. Use the `refund` capability key minted by `pay` to drive `refund`.
 *   5. Verify final balances are flat.
 *
 * The reconciler + outbox worker + scheduler are wired but quiescent — the
 * shutdown handlers prove the lifecycle plumbing is in place.
 */
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (!url) {
    console.error('Set DATABASE_URL first.')
    process.exit(1)
  }
  // Wire `metrics` and/or `tracer` here — Prom / OTel / your bridge.
  // Omit and the engine uses no-op shims (call sites compile to nothing).
  const engine = createEngine({
    schema,
    connection: { url },
  })

  const reconciler = engine.reconciler.start({
    schedule: { kind: 'continuous', intervalMs: 60_000 },
  })
  const outboxWorker = engine.outbox.startWorker({
    handler: async (event) => {
      console.log(`outbox dispatch: ${event.event} (txn=${event.txnId})`)
    },
  })
  installShutdownHandlers(engine, [outboxWorker, reconciler], {
    onStep: (s) => console.log(`[shutdown] ${s}`),
  })

  // Bootstrap the tenant if it doesn't already exist.
  const tenants = await engine.admin.tenants.list()
  if (!tenants.some((t) => t.id === 'chidori')) {
    await engine.admin.tenants.create({ id: 'chidori', name: 'Chidori Logistics' })
  }

  const c = engine.forTenant('chidori')
  const user = { type: 'User', id: 'u-1' }
  const driver = { type: 'Driver', id: 'd-1' }
  const company = { type: 'Company', id: 'co-1' }

  // Idempotent — same call on a re-run returns the existing account.
  await c.accounts.create({ actor: user, name: 'wallet' })
  await c.accounts.create({ actor: driver, name: 'balance' })
  await c.accounts.create({ actor: company, name: 'revenue' })

  // Pre-fund the wallet via admin SQL. In a real app this is a
  // separate transition (e.g. a `WalletTopUp` type that posts a
  // credit from a "system" account).
  await engine.connection.sql.unsafe(
    `update "accounts" set balance = 5000 where owner_actor_type = 'User' and owner_actor_id = '${user.id}'`,
  )

  const txn = await c.transactions.create({
    type: 'DeliveryPayment',
    by: user,
    participants: { user, driver, company },
    idempotencyKey: 'd9001:create',
  })
  console.log(`record ${txn.record.id} created in state=${txn.record.state}`)

  const r = await c.transactions.transition({
    id: txn.record.id,
    name: 'pay',
    by: user,
    data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    idempotencyKey: 'd9001:pay',
  })
  console.log(`pay landed: ${r.transition.id}; refund key=${r.unlocked['refund']}`)

  // Spin the outbox once so the demo handler logs the event.
  await engine.outbox.drainOnce({
    handler: async (event) => {
      console.log(`outbox handler saw: ${event.event}`)
    },
  })

  // Refund. Note the `withKey: r.unlocked['refund']` — that's how
  // capability keys gate state transitions.
  await c.transactions.transition({
    id: txn.record.id,
    name: 'refund',
    by: company,
    withKey: r.unlocked['refund'],
    data: { reason: 'driver no-show' },
    idempotencyKey: 'd9001:refund',
  })
  console.log('refunded')

  // Sanity: verify the chain. `sha256Hasher` is the engine default;
  // pass whatever you used in `createEngine({ hasher })`.
  const verify = await c.queries.verify(txn.record.id, sha256Hasher)
  console.log('verify result:', verify.ok ? 'ok' : verify)

  // Lifecycle helpers — close cleanly.
  await reconciler.stop()
  await outboxWorker.stop()
  await engine.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
