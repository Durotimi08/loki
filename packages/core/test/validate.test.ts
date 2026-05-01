import { describe, expect, it } from 'vitest'
import type { SchemaIssueCode } from '../src/index.js'
import {
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
  validateSchema,
} from '../src/index.js'

const Org = defineTenant('Org')
const Alice = defineActor('Alice', { accounts: { w: { currency: 'NGN' } } })
const Bob = defineActor('Bob', { accounts: { w: { currency: 'NGN' } } })

function build(transactions: Parameters<typeof defineSchema>[0]['transactions']) {
  return defineSchema({
    tenant: Org,
    actors: [Alice, Bob],
    transactions,
    skipValidation: true,
  })
}

function codes(issues: readonly { code: SchemaIssueCode }[]): SchemaIssueCode[] {
  return issues.map((i) => i.code)
}

describe('validateSchema — names', () => {
  it('flags duplicate actor names', () => {
    const schema = defineSchema({
      tenant: Org,
      actors: [Alice, Alice],
      transactions: [],
      skipValidation: true,
    })
    const result = validateSchema(schema)
    expect(result.ok).toBe(false)
    expect(codes(result.issues)).toContain('duplicate_actor')
  })

  it('flags reserved tenant name', () => {
    const reserved = defineTenant('__none__')
    const schema = defineSchema({
      tenant: reserved,
      actors: [Alice],
      transactions: [],
      skipValidation: true,
    })
    const result = validateSchema(schema)
    expect(codes(result.issues)).toContain('reserved_name')
  })

  it('flags non-identifier names', () => {
    const bad = defineTenant('has space')
    const schema = defineSchema({
      tenant: bad,
      actors: [Alice],
      transactions: [],
      skipValidation: true,
    })
    const result = validateSchema(schema)
    expect(codes(result.issues)).toContain('invalid_actor_name')
  })
})

describe('validateSchema — accounts', () => {
  it('flags zero / negative shards', () => {
    const Bad = defineActor('Bad', { accounts: { x: { currency: 'NGN', shards: 0 } } })
    const schema = defineSchema({
      tenant: Org,
      actors: [Bad],
      transactions: [],
      skipValidation: true,
    })
    expect(codes(validateSchema(schema).issues)).toContain('invalid_shards')
  })

  it('flags empty currency', () => {
    const Bad = defineActor('Bad', { accounts: { x: { currency: '' } } })
    const schema = defineSchema({
      tenant: Org,
      actors: [Bad],
      transactions: [],
      skipValidation: true,
    })
    expect(codes(validateSchema(schema).issues)).toContain('invalid_currency')
  })

  it('flags missing parent reference', () => {
    const Bad = defineActor('Bad', {
      accounts: { x: { currency: 'NGN', parent: 'missing' } },
    })
    const schema = defineSchema({
      tenant: Org,
      actors: [Bad],
      transactions: [],
      skipValidation: true,
    })
    expect(codes(validateSchema(schema).issues)).toContain('invalid_account_parent')
  })

  it('accepts a valid parent reference', () => {
    const Good = defineActor('Good', {
      accounts: {
        wallet: { currency: 'NGN' },
        wallet_locked: { currency: 'NGN', parent: 'wallet' },
      },
    })
    const schema = defineSchema({
      tenant: Org,
      actors: [Good],
      transactions: [],
      skipValidation: true,
    })
    expect(validateSchema(schema).ok).toBe(true)
  })
})

describe('validateSchema — states and transitions', () => {
  it('flags initial state not present in states', () => {
    const t = defineTransaction('T', {
      states: ['a', 'b'],
      initial: 'c' as 'a' | 'b',
      participants: {},
      transitions: {},
    })
    const schema = build([t])
    expect(codes(validateSchema(schema).issues)).toContain('initial_not_in_states')
  })

  it('flags terminal state not present in states', () => {
    const t = defineTransaction('T', {
      states: ['a', 'b'],
      initial: 'a',
      terminal: ['c' as 'a' | 'b'],
      participants: {},
      transitions: {},
    })
    expect(codes(validateSchema(build([t])).issues)).toContain('terminal_not_in_states')
  })

  it('flags initial state that is also terminal', () => {
    const t = defineTransaction('T', {
      states: ['a'],
      initial: 'a',
      terminal: ['a'],
      participants: {},
      transitions: {},
    })
    expect(codes(validateSchema(build([t])).issues)).toContain('initial_in_terminal')
  })

  it('flags transition with unknown from-state', () => {
    const t = defineTransaction('T', {
      states: ['a', 'b'],
      initial: 'a',
      participants: {},
      transitions: {
        go: { from: 'zzz' as any, to: 'b', by: [] },
      },
    })
    expect(codes(validateSchema(build([t])).issues)).toContain('unknown_state')
  })

  it('flags transitions firing from a terminal state', () => {
    const t = defineTransaction('T', {
      states: ['a', 'b'],
      initial: 'a',
      terminal: ['b'],
      participants: {},
      transitions: {
        go_back: { from: 'b', to: 'a', by: [] },
      },
    })
    expect(codes(validateSchema(build([t])).issues)).toContain('transition_from_terminal')
  })

  it('flags unreachable states', () => {
    const t = defineTransaction('T', {
      states: ['a', 'b', 'orphan'],
      initial: 'a',
      participants: {},
      transitions: {
        go: { from: 'a', to: 'b', by: [] },
      },
    })
    const result = validateSchema(build([t]))
    expect(codes(result.issues)).toContain('unreachable_state')
  })

  it('treats <none>-rooted transitions as reachability roots', () => {
    const t = defineTransaction('T', {
      states: ['held', 'released', 'refunded'],
      initial: 'held',
      terminal: ['released', 'refunded'],
      participants: {},
      transitions: {
        hold: { from: '__none__', to: 'held', by: [] },
        release: { from: 'held', to: 'released', by: [] },
        refund: { from: 'held', to: 'refunded', by: [] },
      },
    })
    expect(validateSchema(build([t])).ok).toBe(true)
  })
})

describe('validateSchema — postings and keys', () => {
  it('flags string postings that are not invert:<name>', () => {
    const t = defineTransaction('T', {
      states: ['a', 'b'],
      initial: 'a',
      participants: {},
      transitions: {
        go: { from: 'a', to: 'b', by: [], postings: 'something:weird' as any },
      },
    })
    expect(codes(validateSchema(build([t])).issues)).toContain('unknown_invert_target')
  })

  it('flags invert references to nonexistent transitions', () => {
    const t = defineTransaction('T', {
      states: ['a', 'b'],
      initial: 'a',
      participants: {},
      transitions: {
        go: { from: 'a', to: 'b', by: [], postings: 'invert:does_not_exist' },
      },
    })
    expect(codes(validateSchema(build([t])).issues)).toContain('unknown_invert_target')
  })

  it('accepts invert references to existing transitions', () => {
    const t = defineTransaction('T', {
      states: ['a', 'b'],
      initial: 'a',
      participants: {},
      transitions: {
        go: { from: 'a', to: 'b', by: [], unlocks: ['back'] },
        back: {
          from: 'b',
          to: 'a',
          by: [],
          needs: 'back',
          postings: 'invert:go',
        },
      },
    })
    expect(validateSchema(build([t])).ok).toBe(true)
  })

  it('flags `needs` referencing a key that no transition unlocks', () => {
    const t = defineTransaction('T', {
      states: ['a', 'b'],
      initial: 'a',
      participants: {},
      transitions: {
        go: { from: 'a', to: 'b', by: [], needs: 'phantom' },
      },
    })
    expect(codes(validateSchema(build([t])).issues)).toContain('unknown_needs_key')
  })
})

describe('validateSchema — actor references in transitions', () => {
  it('flags transitions that reference actors not in the schema', () => {
    const Outsider = defineActor('Outsider')
    const t = defineTransaction('T', {
      states: ['a', 'b'],
      initial: 'a',
      participants: {},
      transitions: {
        go: { from: 'a', to: 'b', by: [Outsider] },
      },
    })
    const schema = defineSchema({
      tenant: Org,
      actors: [Alice, Bob],
      transactions: [t],
      skipValidation: true,
    })
    expect(codes(validateSchema(schema).issues)).toContain('unknown_actor')
  })

  it('flags participants referencing actors not in the schema', () => {
    const Outsider = defineActor('Outsider')
    const t = defineTransaction('T', {
      states: ['a', 'b'],
      initial: 'a',
      participants: { ghost: Outsider },
      transitions: {},
    })
    const schema = defineSchema({
      tenant: Org,
      actors: [Alice, Bob],
      transactions: [t],
      skipValidation: true,
    })
    expect(codes(validateSchema(schema).issues)).toContain('unknown_actor')
  })
})

describe('validateSchema — cumulative reporting', () => {
  it('accumulates multiple issues without short-circuiting', () => {
    const t = defineTransaction('Bad', {
      states: ['a'],
      initial: 'a',
      terminal: ['a'],
      participants: {},
      transitions: {
        go: { from: 'zzz' as any, to: 'yyy' as any, by: [], needs: 'phantom' },
      },
    })
    const schema = defineSchema({
      tenant: Org,
      actors: [Alice, Alice],
      transactions: [t],
      skipValidation: true,
    })
    const result = validateSchema(schema)
    expect(result.issues.length).toBeGreaterThan(2)
    const found = new Set(codes(result.issues))
    expect(found.has('duplicate_actor')).toBe(true)
    expect(found.has('initial_in_terminal')).toBe(true)
    expect(found.has('unknown_state')).toBe(true)
    expect(found.has('unknown_needs_key')).toBe(true)
  })
})
