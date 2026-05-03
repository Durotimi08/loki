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
import { bufferedIo, run } from '../../src/index.js'
import type { LokiConfig } from '../../src/index.js'
import { ensurePostgres, teardownPostgres } from './setup.js'

// =============================================================================
// Fixture
// =============================================================================

const Org = defineTenant('Org')
const User = defineActor('User', { accounts: { wallet: { currency: 'NGN' } } })
const Driver = defineActor('Driver', { accounts: { balance: { currency: 'NGN' } } })

const Simple = defineTransaction('Simple', {
  states: ['pending', 'done'],
  initial: 'pending',
  terminal: ['done'],
  participants: { user: User, driver: Driver },
  transitions: (t) => ({
    finish: t({ from: 'pending', to: 'done', by: [User] }),
  }),
})

const schema = defineSchema({
  tenant: Org,
  actors: [User, Driver],
  transactions: [Simple],
})

// =============================================================================
// Setup — clean DB before every test.
// =============================================================================

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
})

const config = (): LokiConfig | null => (dbUrl ? { schema, connection: { url: dbUrl } } : null)

// =============================================================================
// Tests
// =============================================================================

describe('loki --help', () => {
  it('prints help and returns 0 with --help', async () => {
    const io = bufferedIo()
    const code = await run({ args: ['--help'], io })
    expect(code).toBe(0)
    expect(io.stdout()).toContain('Usage:')
    expect(io.stdout()).toContain('migrate')
    expect(io.stdout()).toContain('reconcile')
    expect(io.stdout()).toContain('tenant')
  })

  it('returns 2 when no command is given', async () => {
    const io = bufferedIo()
    const code = await run({ args: [], io })
    expect(code).toBe(2)
  })
})

describe('loki migrate', () => {
  it('plan prints up/down SQL without touching the database', async () => {
    const cfg = config()
    if (!cfg) return
    const io = bufferedIo()
    const code = await run({ args: ['migrate', 'plan'], io, config: cfg })
    expect(code).toBe(0)
    expect(io.stdout()).toContain('CREATE TABLE "tenants"')
    expect(io.stdout()).toContain('DROP TABLE IF EXISTS')
  })

  it('apply runs every migration, status reflects the result, rollback reverses', async () => {
    const cfg = config()
    if (!cfg || !engine) return
    const a = bufferedIo()
    expect(await run({ args: ['migrate', 'apply'], io: a, config: cfg })).toBe(0)
    expect(a.stdout()).toMatch(/Applied 0001_init/)

    const s = bufferedIo()
    expect(await run({ args: ['migrate', 'status'], io: s, config: cfg })).toBe(0)
    expect(s.stdout()).toContain('Applied: 1')
    expect(s.stdout()).toContain('Pending: 0')

    const r = bufferedIo()
    expect(await run({ args: ['migrate', 'rollback'], io: r, config: cfg })).toBe(0)
    expect(r.stdout()).toContain('Rolled back')
  })

  it('returns 2 on an unknown subcommand', async () => {
    const cfg = config()
    if (!cfg) return
    const io = bufferedIo()
    const code = await run({ args: ['migrate', 'phantom'], io, config: cfg })
    expect(code).toBe(2)
    expect(io.stderr()).toContain('expected one of apply | plan | rollback | status')
  })
})

describe('loki tenant', () => {
  it('create + list + suspend + activate + delete', async () => {
    const cfg = config()
    if (!cfg) return
    await run({ args: ['migrate', 'apply'], io: bufferedIo(), config: cfg })

    const c = bufferedIo()
    expect(
      await run({
        args: ['tenant', 'create', 'org-1', '--name', 'Acme'],
        io: c,
        config: cfg,
      }),
    ).toBe(0)
    expect(c.stdout()).toContain('Created tenant org-1')

    const l = bufferedIo()
    expect(await run({ args: ['tenant', 'list'], io: l, config: cfg })).toBe(0)
    expect(l.stdout()).toContain('org-1')
    expect(l.stdout()).toContain('Acme')
    expect(l.stdout()).toContain('active')

    const s = bufferedIo()
    expect(await run({ args: ['tenant', 'suspend', 'org-1'], io: s, config: cfg })).toBe(0)
    expect(s.stdout()).toContain('Suspended org-1')

    const a = bufferedIo()
    expect(await run({ args: ['tenant', 'activate', 'org-1'], io: a, config: cfg })).toBe(0)

    const d = bufferedIo()
    expect(await run({ args: ['tenant', 'delete', 'org-1'], io: d, config: cfg })).toBe(0)
    expect(d.stdout()).toContain('Deleted org-1')
  })

  it('returns 1 + an error message when getting a missing tenant', async () => {
    const cfg = config()
    if (!cfg) return
    await run({ args: ['migrate', 'apply'], io: bufferedIo(), config: cfg })
    const io = bufferedIo()
    const code = await run({ args: ['tenant', 'get', 'does-not-exist'], io, config: cfg })
    expect(code).toBe(1)
    expect(io.stderr()).toContain('No tenant')
  })

  it('returns 2 on usage errors', async () => {
    const cfg = config()
    if (!cfg) return
    const io = bufferedIo()
    expect(await run({ args: ['tenant', 'create', 'org'], io, config: cfg })).toBe(2)
    expect(io.stderr()).toContain('--name')
  })
})

describe('loki reconcile', () => {
  it('exits 0 on a clean database', async () => {
    const cfg = config()
    if (!cfg) return
    await run({ args: ['migrate', 'apply'], io: bufferedIo(), config: cfg })
    const io = bufferedIo()
    const code = await run({ args: ['reconcile'], io, config: cfg })
    expect(code).toBe(0)
    expect(io.stdout()).toContain('Anomalies:   0')
  })

  it('exits 1 + reports anomalies after a tampered balance', async () => {
    const cfg = config()
    if (!cfg || !engine) return
    await run({ args: ['migrate', 'apply'], io: bufferedIo(), config: cfg })
    await run({
      args: ['tenant', 'create', 'org-r', '--name', 'R'],
      io: bufferedIo(),
      config: cfg,
    })
    // Provision a record + a posting via the engine, then corrupt the balance.
    const client = engine.forTenant('org-r')
    const user = { type: 'User', id: 'u-r' }
    const driver = { type: 'Driver', id: 'd-r' }
    await client.accounts.create({ actor: user, name: 'wallet' })
    await client.accounts.create({ actor: driver, name: 'balance' })
    await client.transactions.create({
      type: 'Simple',
      by: user,
      participants: { user, driver },
      idempotencyKey: 'r:create',
    })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = balance + 999 where owner_actor_type = 'User' and owner_actor_id = 'u-r'`,
    )

    const io = bufferedIo()
    const code = await run({
      args: ['reconcile', '--tenant', 'org-r', '--no-quarantine'],
      io,
      config: cfg,
    })
    expect(code).toBe(1)
    expect(io.stdout()).toContain('balance_drift')
  })
})

describe('loki anomalies', () => {
  it('list reports drift detected by reconcile and resolve closes it', async () => {
    const cfg = config()
    if (!cfg || !engine) return
    await run({ args: ['migrate', 'apply'], io: bufferedIo(), config: cfg })
    await run({
      args: ['tenant', 'create', 'org-an', '--name', 'A'],
      io: bufferedIo(),
      config: cfg,
    })

    // Seed an anomaly: corrupt balance, then reconcile to record it.
    const client = engine.forTenant('org-an')
    await client.accounts.create({ actor: { type: 'User', id: 'u-1' }, name: 'wallet' })
    await engine.connection.sql.unsafe(
      `update "accounts" set balance = 999 where owner_actor_type = 'User' and owner_actor_id = 'u-1'`,
    )
    await run({
      args: ['reconcile', '--tenant', 'org-an', '--no-quarantine'],
      io: bufferedIo(),
      config: cfg,
    })

    const list = bufferedIo()
    expect(
      await run({
        args: ['anomalies', 'list', '--tenant', 'org-an'],
        io: list,
        config: cfg,
      }),
    ).toBe(0)
    expect(list.stdout()).toContain('balance_drift')

    // Pull the anomaly id out of the list output so we can resolve it.
    const idMatch = /^([0-9a-f-]{36})/m.exec(list.stdout())
    expect(idMatch).not.toBeNull()
    const id = (idMatch as RegExpExecArray)[1] as string

    const resolveIo = bufferedIo()
    expect(
      await run({
        args: [
          'anomalies',
          'resolve',
          id,
          '--tenant',
          'org-an',
          '--by',
          'tester',
          '--note',
          'manual fix',
        ],
        io: resolveIo,
        config: cfg,
      }),
    ).toBe(0)
    expect(resolveIo.stdout()).toContain('Resolved')

    const after = bufferedIo()
    await run({
      args: ['anomalies', 'list', '--tenant', 'org-an', '--unresolved'],
      io: after,
      config: cfg,
    })
    expect(after.stdout()).toContain('No anomalies.')
  })

  it('returns 2 when --tenant is missing', async () => {
    const cfg = config()
    if (!cfg) return
    await run({ args: ['migrate', 'apply'], io: bufferedIo(), config: cfg })
    const io = bufferedIo()
    expect(await run({ args: ['anomalies', 'list'], io, config: cfg })).toBe(2)
    expect(io.stderr()).toContain('--tenant')
  })
})

describe('loki trace', () => {
  it('prints the transition trail and verify reports OK on a clean record', async () => {
    const cfg = config()
    if (!cfg || !engine) return
    await run({ args: ['migrate', 'apply'], io: bufferedIo(), config: cfg })
    await run({
      args: ['tenant', 'create', 'org-tr', '--name', 'T'],
      io: bufferedIo(),
      config: cfg,
    })

    const client = engine.forTenant('org-tr')
    const user = { type: 'User', id: 'u-t' }
    const driver = { type: 'Driver', id: 'd-t' }
    await client.accounts.create({ actor: user, name: 'wallet' })
    await client.accounts.create({ actor: driver, name: 'balance' })
    const txn = await client.transactions.create({
      type: 'Simple',
      by: user,
      participants: { user, driver },
      idempotencyKey: 'trace:1',
    })
    await client.transactions.transition({
      id: txn.record.id,
      name: 'finish',
      by: user,
      idempotencyKey: 'trace:1:finish',
    })

    const showIo = bufferedIo()
    expect(
      await run({
        args: ['trace', txn.record.id, '--tenant', 'org-tr'],
        io: showIo,
        config: cfg,
      }),
    ).toBe(0)
    expect(showIo.stdout()).toContain(`Record:    ${txn.record.id}`)
    expect(showIo.stdout()).toContain('finish')

    const verifyIo = bufferedIo()
    expect(
      await run({
        args: ['trace', txn.record.id, '--tenant', 'org-tr', '--verify'],
        io: verifyIo,
        config: cfg,
      }),
    ).toBe(0)
    expect(verifyIo.stdout()).toContain('Verified:  YES')
  })

  it('exits 1 when the txnId is unknown', async () => {
    const cfg = config()
    if (!cfg) return
    await run({ args: ['migrate', 'apply'], io: bufferedIo(), config: cfg })
    await run({
      args: ['tenant', 'create', 'org-tr2', '--name', 'T2'],
      io: bufferedIo(),
      config: cfg,
    })
    const io = bufferedIo()
    const code = await run({
      args: ['trace', '00000000-0000-0000-0000-000000000000', '--tenant', 'org-tr2'],
      io,
      config: cfg,
    })
    expect(code).toBe(1)
    expect(io.stderr()).toContain('No record')
  })
})

describe('loki migrate enforce', () => {
  it('returns 1 + lists records that violate a configured invariant', async () => {
    const cfg = config()
    if (!cfg || !engine) return
    const enforced: LokiConfig = {
      ...cfg,
      enforcers: {
        finished_only: {
          txnType: 'Simple',
          // Predicate flags every `finish` transition as a violation.
          // In real life this would be a tighter `min_amount` style rule.
          predicate: (t) => t.name === 'finish',
          description: 'finished_only: every finish transition is suspect',
        },
      },
    }
    await run({ args: ['migrate', 'apply'], io: bufferedIo(), config: enforced })
    await run({
      args: ['tenant', 'create', 'org-en', '--name', 'En'],
      io: bufferedIo(),
      config: enforced,
    })
    const c = engine.forTenant('org-en')
    const user = { type: 'User', id: 'u-en' }
    const driver = { type: 'Driver', id: 'd-en' }
    await c.accounts.create({ actor: user, name: 'wallet' })
    await c.accounts.create({ actor: driver, name: 'balance' })
    const txn = await c.transactions.create({
      type: 'Simple',
      by: user,
      participants: { user, driver },
      idempotencyKey: 'en:1:create',
    })
    await c.transactions.transition({
      id: txn.record.id,
      name: 'finish',
      by: user,
      idempotencyKey: 'en:1:finish',
    })

    const io = bufferedIo()
    const code = await run({
      args: ['migrate', 'enforce', 'finished_only', '--tenant', 'org-en'],
      io,
      config: enforced,
    })
    expect(code).toBe(1)
    expect(io.stdout()).toContain('Found 1 violation')
    expect(io.stdout()).toContain(`record=${txn.record.id}`)
  })

  it('returns 2 when no enforcer with that name exists', async () => {
    const cfg = config()
    if (!cfg) return
    await run({ args: ['migrate', 'apply'], io: bufferedIo(), config: cfg })
    const io = bufferedIo()
    const code = await run({
      args: ['migrate', 'enforce', 'does_not_exist'],
      io,
      config: cfg,
    })
    expect(code).toBe(2)
    expect(io.stderr()).toContain('no enforcer')
  })
})

describe('loki tenant dashboard', () => {
  it('reports a per-tenant rollup', async () => {
    const cfg = config()
    if (!cfg || !engine) return
    await run({ args: ['migrate', 'apply'], io: bufferedIo(), config: cfg })
    await run({
      args: ['tenant', 'create', 'org-d', '--name', 'Dash'],
      io: bufferedIo(),
      config: cfg,
    })
    const client = engine.forTenant('org-d')
    const user = { type: 'User', id: 'u-d' }
    const driver = { type: 'Driver', id: 'd-d' }
    await client.accounts.create({ actor: user, name: 'wallet' })
    await client.accounts.create({ actor: driver, name: 'balance' })
    await client.transactions.create({
      type: 'Simple',
      by: user,
      participants: { user, driver },
      idempotencyKey: 'd:1',
    })

    const io = bufferedIo()
    expect(await run({ args: ['tenant', 'dashboard', 'org-d'], io, config: cfg })).toBe(0)
    expect(io.stdout()).toContain('Tenant: org-d (Dash)')
    expect(io.stdout()).toContain('Records:            1')
    expect(io.stdout()).toContain('Open anomalies:     0')
  })
})
