/**
 * Reconciler schedule (batch 20) — pure-logic tests for `nextFireMs`.
 * No DB; the integration side of `start()` is exercised via existing
 * reconciler integration tests.
 */
import { describe, expect, it } from 'vitest'
import { type ReconcilerSchedule, nextFireMs } from '../src/index.js'

describe('nextFireMs — continuous', () => {
  it('returns the configured intervalMs', () => {
    expect(nextFireMs({ kind: 'continuous', intervalMs: 60_000 }, new Date())).toBe(60_000)
  })

  it('floors at 1ms to avoid a 0-delay tight loop', () => {
    expect(nextFireMs({ kind: 'continuous', intervalMs: 0 }, new Date())).toBe(1)
  })
})

describe('nextFireMs — daily', () => {
  it('schedules for later today when the time has not yet passed', () => {
    const now = new Date(Date.UTC(2026, 4, 1, 5, 0, 0)) // 05:00 UTC
    const schedule: ReconcilerSchedule = { kind: 'daily', at: '07:00', tz: 'utc' }
    const ms = nextFireMs(schedule, now)
    // 2 hours = 7_200_000 ms.
    expect(ms).toBe(2 * 60 * 60 * 1000)
  })

  it('rolls to tomorrow when the time has already passed', () => {
    const now = new Date(Date.UTC(2026, 4, 1, 8, 0, 0)) // 08:00 UTC
    const schedule: ReconcilerSchedule = { kind: 'daily', at: '07:00', tz: 'utc' }
    const ms = nextFireMs(schedule, now)
    // 23 hours from now to tomorrow 07:00.
    expect(ms).toBe(23 * 60 * 60 * 1000)
  })

  it('honours seconds in the time string', () => {
    const now = new Date(Date.UTC(2026, 4, 1, 7, 0, 0))
    const ms = nextFireMs({ kind: 'daily', at: '07:00:30', tz: 'utc' }, now)
    expect(ms).toBe(30_000)
  })

  it('rejects out-of-range times', () => {
    const now = new Date()
    expect(() => nextFireMs({ kind: 'daily', at: '25:00', tz: 'utc' }, now)).toThrow(
      /Invalid time-of-day/,
    )
    expect(() => nextFireMs({ kind: 'daily', at: '07:60', tz: 'utc' }, now)).toThrow(
      /Invalid time-of-day/,
    )
  })
})

describe('nextFireMs — weekly', () => {
  it('schedules for the same day later today when the clock has not passed', () => {
    // 2026-05-03 is a Sunday (dayOfWeek = 0)
    const now = new Date(Date.UTC(2026, 4, 3, 1, 0, 0))
    const ms = nextFireMs({ kind: 'weekly', dayOfWeek: 0, at: '02:00', tz: 'utc' }, now)
    expect(ms).toBe(60 * 60 * 1000)
  })

  it('schedules for the same day next week when the clock has already passed', () => {
    const now = new Date(Date.UTC(2026, 4, 3, 3, 0, 0)) // 03:00 Sun
    const ms = nextFireMs({ kind: 'weekly', dayOfWeek: 0, at: '02:00', tz: 'utc' }, now)
    // Next Sunday 02:00 is 7 days minus 1 hour away.
    expect(ms).toBe(7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000)
  })

  it('schedules for the right weekday', () => {
    // 2026-05-03 is Sunday → next Wednesday (dayOfWeek=3) is +3 days.
    const now = new Date(Date.UTC(2026, 4, 3, 0, 0, 0))
    const ms = nextFireMs({ kind: 'weekly', dayOfWeek: 3, at: '00:00', tz: 'utc' }, now)
    expect(ms).toBe(3 * 24 * 60 * 60 * 1000)
  })
})

describe('nextFireMs — monthly', () => {
  it('schedules for later this month when the day/clock has not passed', () => {
    const now = new Date(Date.UTC(2026, 4, 1, 0, 0, 0))
    const ms = nextFireMs({ kind: 'monthly', dayOfMonth: 5, at: '00:00', tz: 'utc' }, now)
    expect(ms).toBe(4 * 24 * 60 * 60 * 1000)
  })

  it('rolls to next month when the slot has already passed', () => {
    const now = new Date(Date.UTC(2026, 4, 6, 0, 0, 0))
    const ms = nextFireMs({ kind: 'monthly', dayOfMonth: 5, at: '00:00', tz: 'utc' }, now)
    // Next fire: June 5 00:00 UTC, which is 30 days away.
    expect(ms).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('clamps day=31 in a 30-day month to the last day', () => {
    const now = new Date(Date.UTC(2026, 5, 1, 0, 0, 0)) // June 1
    const ms = nextFireMs({ kind: 'monthly', dayOfMonth: 31, at: '00:00', tz: 'utc' }, now)
    // June has 30 days, so the next fire is June 30 00:00 UTC = 29 days away.
    expect(ms).toBe(29 * 24 * 60 * 60 * 1000)
  })

  it('rejects out-of-range dayOfMonth', () => {
    const now = new Date()
    expect(() =>
      nextFireMs({ kind: 'monthly', dayOfMonth: 0, at: '00:00', tz: 'utc' }, now),
    ).toThrow(/Invalid dayOfMonth/)
    expect(() =>
      nextFireMs({ kind: 'monthly', dayOfMonth: 32, at: '00:00', tz: 'utc' }, now),
    ).toThrow(/Invalid dayOfMonth/)
  })
})
