import {
  type Engine,
  MIGRATIONS_TABLE,
  createEngine,
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
} from '@loki/core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defineClient } from '../../src/index.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

// =============================================================================
// Schema fixture (kept inside the client package so the integration
// test exercises the full inference path end to end).
// =============================================================================

const stub = <T>(): {
  '~standard': {
    version: 1
    vendor: 'loki-test'
    validate: (v: unknown) => { value: T }
    types: { input: T; output: T }
  }
} => ({
  '~standard': {
    version: 1,
    vendor: 'loki-test',
    validate: (v: unknown) => ({ value: v as T }),
    types: { input: undefined as unknown as T, output: undefined as unknown as T },
  },
})

const Org = defineTenant('Org')
const User = defineActor('User', { accounts: { wallet: { currency: 'NGN' } } })
const Driver = defineActor('Driver', { accounts: { balance: { currency: 'NGN' } } })
const Company = defineActor('Company', {
  accounts: { revenue: { currency: 'NGN', shards: 16 } },
})

const DeliveryPayment = defineTransaction('DeliveryPayment', {
  states: ['pending', 'completed', 'refunded'],
  initial: 'pending',
  terminal: ['refunded'],
  participants: { user: User, driver: Driver, company: Company },
  transitions: (t) => ({
    pay: t({
      from: 'pending',
      to: 'completed',
      by: [User],
      payload: stub<{ amount: bigint; driverShare: bigint; companyShare: bigint }>(),
      postings: ({ data, participants }) => [
        { direction: 'D', account: participants.user.wallet, amount: data.amount },
        { direction: 'C', account: participants.driver.balance, amount: data.driverShare },
        { direction: 'C', account: participants.company.revenue, amount: data.companyShare },
      ],
      unlocks: ['refund'],
      emit: 'delivery.paid',
    }),
    refund: t({
      from: 'completed',
      to: 'refunded',
      by: [Company],
      needs: 'refund',
      payload: stub<{ reason: string }>(),
      postings: 'invert:pay',
      emit: 'delivery.refunded',
    }),
  }),
})

const schema = defineSchema({
  tenant: Org,
  actors: [User, Driver, Company],
  transactions: [DeliveryPayment],
})

// =============================================================================
// Setup
// =============================================================================

const TENANT = 'org-typed'
let engine: Engine | null = null
let dbUrl: string | null = null

beforeAll(async () => {
  const db = await ensurePostgres()
  dbUrl = db?.url ?? null
})

afterAll(async () => {
  if (engine) await engine.close()
  await teardownPostgres()
})

beforeEach(async () => {
  if (!dbUrl) return
  if (engine) {
    try {
      await engine.rollback()
    } catch {
      /* fine */
    }
    await engine.connection.sql.unsafe(`drop table if exists ${MIGRATIONS_TABLE}`)
    await engine.close()
  }
  engine = createEngine({ schema, connection: { url: dbUrl } })
  await engine.migrate()
  await engine.admin.tenants.create({ id: TENANT, name: 'Typed' })
})

// =============================================================================
// Tests
// =============================================================================

describe('defineClient — Chidori delivery flow through the typed surface', () => {
  it('creates a record, drives `pay`, then `refund` with the unlocked key', async () => {
    if (!engine) return
    const client = defineClient<typeof schema>(engine, TENANT)
    expect(client.tenantId).toBe(TENANT)

    const user = { type: 'User', id: 'u-1' } as const
    const driver = { type: 'Driver', id: 'd-1' } as const
    const company = { type: 'Company', id: 'co-1' } as const

    // Provision accounts directly through the engine — `defineClient`
    // intentionally exposes only the per-transaction surface.
    const tenant = engine.forTenant(TENANT)
    await tenant.accounts.create({ actor: user, name: 'wallet' })
    await tenant.accounts.create({ actor: driver, name: 'balance' })
    await tenant.accounts.create({ actor: company, name: 'revenue' })

    const created = await client.deliveryPayment.create({
      by: user,
      idempotencyKey: 'typed:create',
      participants: { user, driver, company },
    })
    expect(created.replayed).toBe(false)
    expect(created.record.state).toBe('pending')

    const paid = await client.deliveryPayment.transition(created.record.id, 'pay', {
      by: user,
      idempotencyKey: 'typed:pay',
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    })
    expect(paid.record.state).toBe('completed')
    expect(paid.record.activeKeys).toContain('refund')

    const refunded = await client.deliveryPayment.transition(created.record.id, 'refund', {
      by: company,
      idempotencyKey: 'typed:refund',
      withKey: paid.unlocked['refund'] as string,
      data: { reason: 'driver no-show' },
    })
    expect(refunded.record.state).toBe('refunded')
    expect(refunded.transition.reverses).toBe(paid.transition.id)

    // Net-zero balances confirm the `invert:pay` resolution.
    expect(await tenant.accounts.balance({ actor: user, name: 'wallet', currency: 'NGN' })).toBe(0n)
    expect(await tenant.accounts.balance({ actor: driver, name: 'balance', currency: 'NGN' })).toBe(
      0n,
    )
    expect(
      await tenant.accounts.balance({ actor: company, name: 'revenue', currency: 'NGN' }),
    ).toBe(0n)

    // get + trace also work through the typed namespace.
    const cur = await client.deliveryPayment.get(created.record.id)
    expect(cur?.state).toBe('refunded')
    const trail = await client.deliveryPayment.trace(created.record.id)
    expect(trail.map((t) => t.name)).toEqual(['_init', 'pay', 'refund'])
  })

  it('idempotent replay returns the same transition row', async () => {
    if (!engine) return
    const client = defineClient<typeof schema>(engine, TENANT)
    const user = { type: 'User', id: 'u-2' } as const
    const driver = { type: 'Driver', id: 'd-2' } as const
    const company = { type: 'Company', id: 'co-1' } as const
    const tenant = engine.forTenant(TENANT)
    await tenant.accounts.create({ actor: user, name: 'wallet' })
    await tenant.accounts.create({ actor: driver, name: 'balance' })
    await tenant.accounts.create({ actor: company, name: 'revenue' })

    const created = await client.deliveryPayment.create({
      by: user,
      idempotencyKey: 'replay:create',
      participants: { user, driver, company },
    })
    const a = await client.deliveryPayment.transition(created.record.id, 'pay', {
      by: user,
      idempotencyKey: 'replay:pay',
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    })
    const b = await client.deliveryPayment.transition(created.record.id, 'pay', {
      by: user,
      idempotencyKey: 'replay:pay',
      data: { amount: 1500n, driverShare: 500n, companyShare: 1000n },
    })
    expect(a.transition.id).toBe(b.transition.id)
    expect(b.replayed).toBe(true)
  })
})
