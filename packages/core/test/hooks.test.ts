import { describe, expect, it, vi } from 'vitest'
import {
  type AnomalyEvent,
  type BeforeTransitionEvent,
  createHookRegistry,
  matchesHookFilter,
} from '../src/index.js'

describe('matchesHookFilter', () => {
  it('returns true when no filter is supplied', async () => {
    expect(await matchesHookFilter({ a: 1 }, undefined)).toBe(true)
  })

  it('matches partial-object filters by field equality', async () => {
    const event: { tenantId: string; txnType: string; name: string } = {
      tenantId: 'A',
      txnType: 'X',
      name: 'pay',
    }
    expect(await matchesHookFilter(event, { tenantId: 'A' })).toBe(true)
    expect(await matchesHookFilter(event, { tenantId: 'B' })).toBe(false)
    expect(await matchesHookFilter(event, { tenantId: 'A', txnType: 'X' })).toBe(true)
    expect(await matchesHookFilter(event, { tenantId: 'A', txnType: 'Y' })).toBe(false)
  })

  it('matches array filters as "any of"', async () => {
    const event: { severity: string } = { severity: 'critical' }
    expect(await matchesHookFilter(event, { severity: ['warn', 'critical'] })).toBe(true)
    expect(await matchesHookFilter(event, { severity: ['warn', 'error'] })).toBe(false)
  })

  it('runs predicate filters', async () => {
    const event = { value: 42 }
    expect(await matchesHookFilter(event, (e) => e.value > 10)).toBe(true)
    expect(await matchesHookFilter(event, (e) => e.value > 100)).toBe(false)
  })

  it('skips undefined fields in the filter', async () => {
    const filter: { tenantId: string; check?: string } = { tenantId: 'A' }
    expect(await matchesHookFilter({ tenantId: 'A', check: 'x' }, filter)).toBe(true)
  })
})

describe('createHookRegistry — registration + counts', () => {
  it('tracks registrations and unsubscribes', () => {
    const r = createHookRegistry()
    const unsub1 = r.beforeTransition(undefined, async () => {})
    const unsub2 = r.afterTransition(undefined, async () => {})
    r.onAnomaly(undefined, async () => {})
    r.onQuarantine(undefined, async () => {})
    r.onOutboxFailureTerminal(undefined, async () => {})
    r.onHookFailure(async () => {})

    expect(r.internals.counts()).toMatchObject({
      beforeTransition: 1,
      afterTransition: 1,
      onAnomaly: 1,
      onQuarantine: 1,
      onOutboxFailureTerminal: 1,
      onHookFailure: 1,
    })

    unsub1()
    unsub2()
    expect(r.internals.counts().beforeTransition).toBe(0)
    expect(r.internals.counts().afterTransition).toBe(0)
  })
})

describe('beforeTransition — sequential, throws abort the chain', () => {
  it('fires every registered handler in registration order', async () => {
    const r = createHookRegistry()
    const calls: string[] = []
    r.beforeTransition(undefined, async () => {
      calls.push('a')
    })
    r.beforeTransition(undefined, async () => {
      calls.push('b')
    })
    await r.internals.fireBeforeTransition(stubBeforeEvent())
    expect(calls).toEqual(['a', 'b'])
  })

  it('a throw stops the chain and propagates to the engine', async () => {
    const r = createHookRegistry()
    const calls: string[] = []
    r.beforeTransition(undefined, async () => {
      calls.push('a')
      throw new Error('boom')
    })
    r.beforeTransition(undefined, async () => {
      calls.push('b')
    })
    await expect(r.internals.fireBeforeTransition(stubBeforeEvent())).rejects.toThrow('boom')
    expect(calls).toEqual(['a'])
  })

  it('respects filters and only fires matching handlers', async () => {
    const r = createHookRegistry()
    const calls: string[] = []
    r.beforeTransition({ txnType: 'A' }, async () => {
      calls.push('a-handler')
    })
    r.beforeTransition({ txnType: 'B' }, async () => {
      calls.push('b-handler')
    })
    await r.internals.fireBeforeTransition(stubBeforeEvent({ txnType: 'A' }))
    expect(calls).toEqual(['a-handler'])
  })
})

describe('afterTransition / onAnomaly — concurrent, isolated failures', () => {
  it('fires all matching handlers; one throwing does not block others', async () => {
    const r = createHookRegistry()
    const a = vi.fn(async () => {})
    const b = vi.fn(async () => {
      throw new Error('boom')
    })
    const c = vi.fn(async () => {})
    const failures: unknown[] = []
    r.onHookFailure(async (e) => {
      failures.push(e)
    })
    r.onAnomaly(undefined, a)
    r.onAnomaly(undefined, b)
    r.onAnomaly(undefined, c)

    await r.internals.fireAnomaly(stubAnomalyEvent())
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
    expect(c).toHaveBeenCalledOnce()
    expect(failures).toHaveLength(1)
  })

  it('does not invoke onHookFailure recursively if it throws', async () => {
    const r = createHookRegistry()
    let failureCalls = 0
    r.onHookFailure(async () => {
      failureCalls++
      throw new Error('nope')
    })
    r.onAnomaly(undefined, async () => {
      throw new Error('boom')
    })
    await r.internals.fireAnomaly(stubAnomalyEvent())
    expect(failureCalls).toBe(1)
  })

  it('routes by severity filter', async () => {
    const r = createHookRegistry()
    const critical = vi.fn(async () => {})
    const errors = vi.fn(async () => {})
    r.onAnomaly({ severity: 'critical' }, critical)
    r.onAnomaly({ severity: 'error' }, errors)

    await r.internals.fireAnomaly(stubAnomalyEvent({ severity: 'critical' }))
    expect(critical).toHaveBeenCalledOnce()
    expect(errors).not.toHaveBeenCalled()
  })

  it('routes by check name filter', async () => {
    const r = createHookRegistry()
    const drift = vi.fn(async () => {})
    const chain = vi.fn(async () => {})
    r.onAnomaly({ check: 'balance_drift' }, drift)
    r.onAnomaly({ check: 'hash_chain_break' }, chain)

    await r.internals.fireAnomaly(stubAnomalyEvent({ check: 'balance_drift' }))
    expect(drift).toHaveBeenCalledOnce()
    expect(chain).not.toHaveBeenCalled()
  })

  it('routes by predicate', async () => {
    const r = createHookRegistry()
    const merchant = vi.fn(async () => {})
    r.onAnomaly((a) => (a.context as { tag?: string } | undefined)?.tag === 'merchant', merchant)
    await r.internals.fireAnomaly(stubAnomalyEvent({ context: { tag: 'merchant' } }))
    expect(merchant).toHaveBeenCalledOnce()

    await r.internals.fireAnomaly(stubAnomalyEvent({ context: { tag: 'other' } }))
    expect(merchant).toHaveBeenCalledOnce()
  })
})

// =============================================================================
// fixtures
// =============================================================================

function stubBeforeEvent(over?: Partial<BeforeTransitionEvent>): BeforeTransitionEvent {
  return {
    tenantId: 't',
    record: {
      id: 'r-1',
      tenantId: 't',
      type: 'A',
      state: 'pending',
      version: 0,
      activeKeys: [],
      participants: {},
      createdBy: { type: 'User', id: 'u' },
      compromised: false,
      schemaVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    txnType: 'A',
    transitionName: 'pay',
    actor: { type: 'User', id: 'u' },
    data: {},
    idempotencyKey: 'k',
    ...over,
  }
}

function stubAnomalyEvent(over?: Partial<AnomalyEvent>): AnomalyEvent {
  return {
    id: 'a-1',
    tenantId: 't',
    check: 'balance_drift',
    severity: 'error',
    detectedAt: new Date(),
    expected: 100n,
    observed: 110n,
    ...over,
  }
}
