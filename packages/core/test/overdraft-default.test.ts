import { describe, expect, it } from 'vitest'
import { defineActor } from '../src/index.js'

/**
 * Pin the `allowOverdraft` default at the schema layer.
 *
 * The integration suite exercises the runtime behaviour end-to-end,
 * but the actual claim of this change — "the default value the
 * schema builder bakes into every AccountDef is `false`" — is a
 * pure schema-DSL property. Test it directly so a future regression
 * (someone flipping the `?? false` back to `?? true`, say during a
 * "back-compat" sweep) trips immediately, without needing Postgres.
 */
describe('AccountDef — allowOverdraft default', () => {
  it('defaults to false when the option is omitted', () => {
    const Wallet = defineActor('Wallet', {
      accounts: { main: { currency: 'NGN' } },
    })
    expect(Wallet.accounts.main.allowOverdraft).toBe(false)
  })

  it('honours explicit allowOverdraft: true', () => {
    const Funder = defineActor('Funder', {
      accounts: { source: { currency: 'NGN', allowOverdraft: true } },
    })
    expect(Funder.accounts.source.allowOverdraft).toBe(true)
  })

  it('honours explicit allowOverdraft: false', () => {
    const Wallet = defineActor('Wallet', {
      accounts: { main: { currency: 'NGN', allowOverdraft: false } },
    })
    expect(Wallet.accounts.main.allowOverdraft).toBe(false)
  })

  it('refuses allowOverdraft: false (the default) with shards > 1', () => {
    // Sharded accounts cannot enforce overdraft because the cross-
    // shard balance check would race with single-shard writers. The
    // schema builder catches this at construction so an operator
    // never ends up thinking they have a guard they don't.
    expect(() =>
      defineActor('Bad', {
        accounts: { revenue: { currency: 'NGN', shards: 16 } },
      }),
    ).toThrow(/allowOverdraft: false cannot combine with shards/)
  })

  it('accepts allowOverdraft: true with shards > 1', () => {
    const Bus = defineActor('Bus', {
      accounts: { revenue: { currency: 'NGN', shards: 16, allowOverdraft: true } },
    })
    expect(Bus.accounts.revenue.shards).toBe(16)
    expect(Bus.accounts.revenue.allowOverdraft).toBe(true)
  })
})
