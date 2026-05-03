/**
 * Batch 21 — beforeTransition hook timeout. Pure unit test exercised
 * directly against `createHookRegistry`. Engine integration is covered
 * implicitly because every transition path goes through
 * `fireBeforeTransition`.
 */
import { describe, expect, it } from 'vitest'
import {
  type BeforeTransitionEvent,
  BeforeTransitionTimeoutError,
  createHookRegistry,
} from '../src/index.js'

const event: BeforeTransitionEvent = {
  tenantId: 'org-x',
  txnType: 'Sample',
  transitionName: 'pay',
  actor: { type: 'User', id: 'u-1' },
  data: {},
  idempotencyKey: 'k-1',
  // The real engine fills these from a loaded TxnRecord; for the
  // unit test a stub object is fine — `fireBeforeTransition` doesn't
  // read them, only the user's handler can.
  record: {
    id: 'r-1',
    tenantId: 'org-x',
    type: 'Sample',
    state: 'pending',
    version: 0,
    activeKeys: [],
    participants: {},
    createdByActorType: 'User',
    createdByActorId: 'u-1',
    compromised: false,
    schemaVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never,
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

describe('beforeTransition timeout', () => {
  it('aborts a handler that exceeds the configured timeout', async () => {
    const reg = createHookRegistry({ beforeTransitionTimeoutMs: 50 })
    reg.beforeTransition(undefined, async () => {
      await sleep(500)
    })
    await expect(reg.internals.fireBeforeTransition(event)).rejects.toBeInstanceOf(
      BeforeTransitionTimeoutError,
    )
  })

  it('lets fast handlers complete normally', async () => {
    const reg = createHookRegistry({ beforeTransitionTimeoutMs: 100 })
    let ran = false
    reg.beforeTransition(undefined, async () => {
      await sleep(5)
      ran = true
    })
    await reg.internals.fireBeforeTransition(event)
    expect(ran).toBe(true)
  })

  it('disables the timeout when set to null', async () => {
    const reg = createHookRegistry({ beforeTransitionTimeoutMs: null })
    reg.beforeTransition(undefined, async () => {
      await sleep(120)
    })
    // Should resolve, not throw — even though 120ms > the 1s default.
    await reg.internals.fireBeforeTransition(event)
  })

  it('uses a 1000ms default when no option is given', async () => {
    const reg = createHookRegistry()
    reg.beforeTransition(undefined, async () => {
      await sleep(2000)
    })
    await expect(reg.internals.fireBeforeTransition(event)).rejects.toBeInstanceOf(
      BeforeTransitionTimeoutError,
    )
  }, 10_000)

  it('preserves explicit RejectTransition throws (not timeouts)', async () => {
    const reg = createHookRegistry({ beforeTransitionTimeoutMs: 100 })
    reg.beforeTransition(undefined, async () => {
      throw new Error('rejected by hook')
    })
    await expect(reg.internals.fireBeforeTransition(event)).rejects.toThrow(/rejected by hook/)
  })
})
