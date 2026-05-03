import { describe, expect, it, vi } from 'vitest'
import { type ShutdownTarget, gracefulShutdown } from '../src/index.js'

describe('gracefulShutdown', () => {
  it('stops every worker in order, then closes the engine', async () => {
    const order: string[] = []
    const w = (label: string): ShutdownTarget => ({
      stop: async () => {
        order.push(`stop:${label}`)
      },
    })
    const engine = {
      close: vi.fn(async () => {
        order.push('close:engine')
      }),
    }
    await gracefulShutdown(engine, [w('a'), w('b'), w('c')])
    expect(order).toEqual(['stop:a', 'stop:b', 'stop:c', 'close:engine'])
    expect(engine.close).toHaveBeenCalledOnce()
  })

  it('continues past a worker that throws and still closes the engine', async () => {
    const calls: string[] = []
    const ok = (label: string): ShutdownTarget => ({
      stop: async () => {
        calls.push(`stop:${label}`)
      },
    })
    const broken: ShutdownTarget = {
      stop: async () => {
        calls.push('stop:broken')
        throw new Error('boom')
      },
    }
    const engine = {
      close: async () => {
        calls.push('close:engine')
      },
    }
    const steps: string[] = []
    await gracefulShutdown(engine, [ok('a'), broken, ok('c')], {
      onStep: (s) => steps.push(s),
    })
    expect(calls).toEqual(['stop:a', 'stop:broken', 'stop:c', 'close:engine'])
    expect(steps.some((s) => /boom/.test(s))).toBe(true)
  })

  it('honours the timeout when a worker hangs', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const fast: ShutdownTarget = {
        stop: async () => {
          calls.push('stop:fast')
        },
      }
      const hangs: ShutdownTarget = {
        stop: () => new Promise<void>(() => {}), // never resolves
      }
      const engine = {
        close: async () => {
          calls.push('close')
        },
      }
      const onTimeout = vi.fn()
      const promise = gracefulShutdown(engine, [fast, hangs], {
        timeoutMs: 100,
        onTimeout,
      })
      await vi.advanceTimersByTimeAsync(100)
      await promise
      expect(onTimeout).toHaveBeenCalledOnce()
      // `fast` ran but `engine.close` didn't — `hangs` blocked the chain.
      expect(calls).toEqual(['stop:fast'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards step messages to the supplied logger', async () => {
    const seen: string[] = []
    const w: ShutdownTarget = {
      stop: () => {},
    }
    await gracefulShutdown({ close: async () => {} }, [w], {
      onStep: (s) => seen.push(s),
    })
    expect(seen).toEqual(['stopping worker 1/1', 'closing engine', 'shutdown complete'])
  })
})
