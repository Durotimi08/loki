import { describe, expect, it } from 'vitest'
import {
  SchemaError,
  defineSchema,
  defineTenant,
  defineTransaction,
  validateSchema,
} from '../src/index.js'
import { Company, Driver, Org, System, User, chidoriSchema } from './fixtures.js'

describe('defineSchema — Chidori fixture', () => {
  it('builds a schema with tenant, actors, and transactions', () => {
    expect(chidoriSchema._kind).toBe('schema')
    expect(chidoriSchema.tenant.name).toBe('Org')
    expect(chidoriSchema.actors).toHaveLength(4)
    expect(chidoriSchema.transactions).toHaveLength(1)
  })

  it('exposes a name index for actors and transactions', () => {
    expect(chidoriSchema.meta.actorsByName.get('User')).toBe(User)
    expect(chidoriSchema.meta.transactionsByName.get('DeliveryPayment')?.name).toBe(
      'DeliveryPayment',
    )
  })

  it('reports OK on a valid schema', () => {
    const result = validateSchema(chidoriSchema)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })
})

describe('defineSchema — failure modes', () => {
  it('throws SchemaError when validation fails on construction', () => {
    expect(() =>
      defineSchema({
        tenant: Org,
        actors: [User, User], // duplicate
        transactions: [],
      }),
    ).toThrow(SchemaError)
  })

  it('respects skipValidation for partial test schemas', () => {
    expect(() =>
      defineSchema({
        tenant: Org,
        actors: [User, User],
        transactions: [],
        skipValidation: true,
      }),
    ).not.toThrow()
  })

  it('SchemaError carries the full issue list', () => {
    try {
      defineSchema({
        tenant: Org,
        actors: [User, User, Driver, Driver],
        transactions: [],
      })
      expect.fail('expected SchemaError')
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaError)
      const err = e as SchemaError
      expect(err.issues.length).toBeGreaterThanOrEqual(2)
      expect(err.issues.every((i) => i.code === 'duplicate_actor')).toBe(true)
      expect(err.message).toContain('duplicate_actor')
    }
  })
})

describe('defineSchema — composition', () => {
  it('captures a transaction that references multiple actors', () => {
    const Subscription = defineTransaction('Subscription', {
      states: ['trialing', 'active', 'past_due', 'cancelled'],
      initial: 'trialing',
      terminal: ['cancelled'],
      participants: { user: User, company: Company },
      transitions: (t) => ({
        activate: t({
          from: 'trialing',
          to: 'active',
          by: [User],
          unlocks: ['renew', 'cancel'],
        }),
        renew: t({
          from: 'active',
          to: 'active',
          by: [System],
          needs: 'renew',
          unlocks: ['renew', 'cancel'],
        }),
        mark_past_due: t({
          from: 'active',
          to: 'past_due',
          by: [System],
        }),
        recover: t({
          from: 'past_due',
          to: 'active',
          by: [System],
          unlocks: ['renew', 'cancel'],
        }),
        cancel: t({
          from: ['active', 'past_due'],
          to: 'cancelled',
          by: [User],
          needs: 'cancel',
        }),
      }),
    })

    const schema = defineSchema({
      tenant: Org,
      actors: [User, Driver, Company, System],
      transactions: [Subscription],
    })

    expect(schema.meta.transactionsByName.get('Subscription')?.transitions.renew?.needs).toBe(
      'renew',
    )
  })

  it('supports the <none> sentinel for record-creating transitions', () => {
    const Escrow = defineTransaction('Escrow', {
      states: ['held', 'released', 'refunded'],
      initial: 'held',
      terminal: ['released', 'refunded'],
      participants: { buyer: User, seller: Driver, platform: Company },
      transitions: (t) => ({
        hold: t({
          from: '__none__',
          to: 'held',
          by: [User],
          unlocks: ['release', 'refund'],
        }),
        release: t({
          from: 'held',
          to: 'released',
          by: [System],
          needs: 'release',
        }),
        refund: t({
          from: 'held',
          to: 'refunded',
          by: [User, Company],
          needs: 'refund',
        }),
      }),
    })

    const schema = defineSchema({
      tenant: Org,
      actors: [User, Driver, Company, System],
      transactions: [Escrow],
    })

    expect(schema.meta.transactionsByName.get('Escrow')).toBeDefined()
  })

  it('builders are independent — defineActor/Tenant/Transaction never validate', () => {
    // A transaction that references a non-existent state is fine at the
    // builder level — only `defineSchema`/`validateSchema` enforces it.
    expect(() => {
      defineTransaction('Broken', {
        states: ['a', 'b'],
        initial: 'a',
        participants: {},
        transitions: (t) => ({
          go: t({
            from: 'unknown_from' as 'a' | 'b',
            to: 'b',
            by: [],
          }),
        }),
      })
    }).not.toThrow()

    const tenant = defineTenant('???')
    expect(tenant.name).toBe('???') // Builder is permissive; validate catches.
  })
})
