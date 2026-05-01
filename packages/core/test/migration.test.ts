import { describe, expect, it } from 'vitest'
import {
  ENGINE_TABLES,
  TENANT_GUC,
  buildIndexesSql,
  buildRlsSql,
  buildRolesSql,
  buildTablesSql,
  defineActor,
  defineSchema,
  defineTenant,
  defineTransaction,
  planInitialMigration,
  resolveOptions,
} from '../src/index.js'
import { chidoriSchema } from './fixtures.js'

describe('planInitialMigration — Chidori fixture', () => {
  const plan = planInitialMigration(chidoriSchema)

  it('produces a stable id', () => {
    expect(plan.id).toBe('0001_init')
  })

  it('exposes both up and down statement lists', () => {
    expect(plan.up.length).toBeGreaterThan(0)
    expect(plan.down.length).toBeGreaterThan(0)
  })

  it('captures resolved options', () => {
    expect(plan.options.tenancy).toBe('rls')
    expect(plan.options.appRole).toBe('ledger_app')
    expect(plan.options.adminRole).toBe('ledger_admin')
    expect(plan.options.tablePrefix).toBe('')
  })

  it('toUpSql matches the golden snapshot', () => {
    expect(plan.toUpSql()).toMatchSnapshot()
  })

  it('toDownSql matches the golden snapshot', () => {
    expect(plan.toDownSql()).toMatchSnapshot()
  })
})

describe('planInitialMigration — content checks', () => {
  const plan = planInitialMigration(chidoriSchema)
  const up = plan.toUpSql()

  it('creates every engine table', () => {
    for (const name of ENGINE_TABLES) {
      expect(up).toContain(`CREATE TABLE "${name}"`)
    }
  })

  it('creates every §12.2 index by name', () => {
    for (const idx of [
      'txn_records_type_state_idx',
      'txn_records_creator_idx',
      'txn_transitions_trace_idx',
      'txn_transitions_actor_idx',
      'postings_account_history_idx',
      'postings_transition_idx',
      'txn_keys_active_idx',
      'outbox_drain_idx',
      'txn_anomalies_severity_idx',
    ]) {
      expect(up).toContain(`CREATE INDEX "${idx}"`)
    }
  })

  it('enables and forces RLS on every table except tenants', () => {
    for (const name of ENGINE_TABLES) {
      if (name === 'tenants') {
        expect(up).not.toContain(`ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY`)
        continue
      }
      expect(up).toContain(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`)
      expect(up).toContain(`ALTER TABLE "${name}" FORCE ROW LEVEL SECURITY`)
    }
  })

  it('uses the loki.tenant_id GUC for tenant isolation', () => {
    expect(TENANT_GUC).toBe('loki.tenant_id')
    expect(up).toContain(`current_setting('${TENANT_GUC}', true)`)
  })

  it('creates ledger_app and ledger_admin roles idempotently', () => {
    expect(up).toContain('CREATE ROLE "ledger_app" NOLOGIN')
    expect(up).toContain('CREATE ROLE "ledger_admin" NOLOGIN')
    // Idempotency guarded by pg_roles check, so the migration is safe
    // to re-apply.
    expect(up).toContain("WHERE rolname = 'ledger_app'")
    expect(up).toContain("WHERE rolname = 'ledger_admin'")
  })

  it('grants constrained UPDATE — only the cache/state columns named in §13', () => {
    expect(up).toContain('GRANT UPDATE ("balance") ON "accounts" TO "ledger_app"')
    expect(up).toContain('GRANT UPDATE ("status", "consumed_by_transition_id")\nON "txn_keys"')
    expect(up).toContain('"delivered_at"')
    expect(up).toContain('"next_attempt_at"')
  })

  it('encodes per-actor account CHECKs from the schema', () => {
    expect(up).toContain('"owner_actor_type" IN')
    expect(up).toContain("'User'")
    expect(up).toContain("'Driver'")
    expect(up).toContain("'Company'")
    expect(up).toContain("'wallet'")
    expect(up).toContain("'balance'")
    expect(up).toContain("'revenue'")
  })

  it('encodes per-transaction state CHECKs', () => {
    expect(up).toContain('"type" = \'DeliveryPayment\'')
    expect(up).toContain("'pending'")
    expect(up).toContain("'completed'")
    expect(up).toContain("'failed'")
    expect(up).toContain("'refunded'")
  })

  it('encodes per-transaction transition-name CHECKs', () => {
    expect(up).toContain("'pay'")
    expect(up).toContain("'cancel'")
    expect(up).toContain("'refund'")
  })

  it('encodes outbox event CHECKs from emit declarations', () => {
    expect(up).toContain("'delivery.paid'")
    expect(up).toContain("'delivery.cancelled'")
    expect(up).toContain("'delivery.refunded'")
  })

  it('UNIQUE (tenant_id, txn_id, idempotency_key) is part of txn_transitions DDL', () => {
    expect(up).toContain('UNIQUE ("tenant_id", "txn_id", "idempotency_key")')
  })

  it('UNIQUE on accounts pins identity by tenant+actor+name+currency+shard', () => {
    expect(up).toContain(
      'UNIQUE ("tenant_id", "owner_actor_type", "owner_actor_id", "name", "currency", "shard_index")',
    )
  })
})

describe('planInitialMigration — options', () => {
  it('rejects unimplemented tenancy modes early', () => {
    expect(() => planInitialMigration(chidoriSchema, { tenancy: 'schema-per-tenant' })).toThrow(
      /reserved for a later milestone/,
    )
    expect(() => planInitialMigration(chidoriSchema, { tenancy: 'database-per-tenant' })).toThrow(
      /reserved for a later milestone/,
    )
  })

  it('honours custom role names', () => {
    const plan = planInitialMigration(chidoriSchema, {
      appRole: 'app_writer',
      adminRole: 'app_owner',
    })
    expect(plan.toUpSql()).toContain('CREATE ROLE "app_writer"')
    expect(plan.toUpSql()).toContain('CREATE ROLE "app_owner"')
    expect(plan.toUpSql()).not.toContain('CREATE ROLE "ledger_app"')
  })

  it('honours table prefix consistently', () => {
    const plan = planInitialMigration(chidoriSchema, { tablePrefix: 'loki_' })
    const up = plan.toUpSql()
    expect(up).toContain('CREATE TABLE "loki_tenants"')
    expect(up).toContain('CREATE TABLE "loki_txn_records"')
    expect(up).toContain('CREATE INDEX "loki_postings_transition_idx"')
    expect(up).toContain('ON "loki_txn_keys"')
  })
})

describe('schema-driven CHECK constraints', () => {
  it('omits owner_actor_type CHECK when no actor has accounts', () => {
    const T = defineTenant('Org')
    const A = defineActor('A')
    const B = defineActor('B')
    const schema = defineSchema({ tenant: T, actors: [A, B], transactions: [] })
    const sql = buildTablesSql(schema, resolveOptions()).join('\n')
    expect(sql).not.toContain('"owner_actor_type" IN')
  })

  it('omits per-state CHECKs when no transactions are declared', () => {
    const T = defineTenant('Org')
    const A = defineActor('A')
    const schema = defineSchema({ tenant: T, actors: [A], transactions: [] })
    const sql = buildTablesSql(schema, resolveOptions()).join('\n')
    expect(sql).not.toContain('"type" IN')
  })

  it('uses IS NULL for from_state when a transition fires from <none>', () => {
    const T = defineTenant('Org')
    const A = defineActor('A')
    const Txn = defineTransaction('Txn', {
      states: ['held'],
      initial: 'held',
      participants: {},
      transitions: (t) => ({
        hold: t({ from: '__none__', to: 'held', by: [] }),
      }),
    })
    const schema = defineSchema({ tenant: T, actors: [A], transactions: [Txn] })
    const sql = buildTablesSql(schema, resolveOptions()).join('\n')
    expect(sql).toContain('"from_state" IS NULL')
  })
})

describe('component builders are individually composable', () => {
  it('buildIndexesSql is independent of the schema', () => {
    const sql = buildIndexesSql(resolveOptions()).join('\n')
    expect(sql).toContain('CREATE INDEX')
    expect(sql).not.toContain('CREATE TABLE')
  })

  it('buildRlsSql is empty for non-RLS tenancies', () => {
    expect(buildRlsSql(resolveOptions({ tenancy: 'schema-per-tenant' }))).toEqual([])
  })

  it('buildRolesSql produces idempotent CREATE statements', () => {
    const sql = buildRolesSql(resolveOptions()).join('\n')
    expect(sql).toContain('IF NOT EXISTS')
    expect(sql).toContain('CREATE ROLE')
  })
})
