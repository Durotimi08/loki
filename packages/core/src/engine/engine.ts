import { planInitialMigration } from '../db/migration.js'
import type { MigrationOptions, MigrationPlan } from '../db/types.js'
import type { SchemaDef } from '../schema/types.js'
import type {
  AdapterContract,
  AdapterInboundContext,
  AdapterInboundResult,
  AdapterOutboundContext,
} from './adapter.js'
import { type AdminOps, buildAdminOps } from './admin.js'
import { type TenantClient, buildTenantClient } from './client.js'
import { type Connection, type ConnectionInput, openConnection } from './connection.js'
import { LokiError } from './errors.js'
import { type Hasher, sha256Hasher } from './hash.js'
import { type HookRegistry, createHookRegistry } from './hooks.js'
import { type Migrator, createMigrator } from './migrator.js'
import {
  type OutboxDispatch,
  type OutboxEvent,
  type OutboxHandler,
  type OutboxOps,
  buildOutboxOps,
} from './outbox.js'
import { type Reconciler, createReconciler } from './reconciler.js'

export type EngineOptions = {
  /** The compiled schema. */
  readonly schema: SchemaDef
  /** Postgres connection — URL string or a pre-built postgres.js client. */
  readonly connection: ConnectionInput
  /** Migration / DDL options. Defaults: RLS tenancy, ledger_app/ledger_admin roles. */
  readonly migration?: MigrationOptions
  /** Hash chain implementation. Defaults to SHA-256. */
  readonly hasher?: Hasher
}

export type AdaptersOps = {
  /**
   * Register an adapter. Outbox events whose `intent` matches one of
   * the adapter's declared intents are routed through it instead of
   * the consumer-supplied outbox handler.
   *
   * Re-registering an adapter with the same name throws. Use
   * `unregister(name)` if you need to swap one out.
   */
  register(adapter: AdapterContract): void
  /** Remove an adapter by name. Returns true if it existed. */
  unregister(name: string): boolean
  /** Look up a registered adapter by name. */
  get(name: string): AdapterContract | undefined
  /** Snapshot of currently registered adapters. */
  list(): readonly AdapterContract[]
  /**
   * Drive an inbound webhook event through a registered adapter. The
   * adapter's mapper resolves it to a follow-up Loki transition that
   * the engine then runs (idempotency-keyed by the mapper).
   */
  handleInbound(
    adapterName: string,
    eventName: string,
    payload: unknown,
    ctx: AdapterInboundContext,
  ): Promise<AdapterInboundResult>
}

export type Engine = {
  readonly schema: SchemaDef
  readonly admin: AdminOps
  /**
   * In-process hook registry. Register `beforeTransition`,
   * `afterTransition`, `onAnomaly`, etc. handlers here. See `HookRegistry`.
   */
  readonly hooks: HookRegistry
  /** Outbox worker — drain `emit`-ed events to webhooks/queues. */
  readonly outbox: OutboxOps
  /** Reconciler — runs the §5.2 integrity checks. */
  readonly reconciler: Reconciler
  /** Adapter registry. Outbox events with an `intent` route through here. */
  readonly adapters: AdaptersOps
  /** Get a tenant-scoped client. */
  forTenant(tenantId: string): TenantClient
  /** Apply pending migrations (currently just the bootstrap plan). */
  migrate(): Promise<readonly { id: string; checksum: string; applied_at: Date }[]>
  /** Roll back the bootstrap plan. */
  rollback(): Promise<void>
  /** The bootstrap plan, exposed so callers can inspect or run it externally. */
  readonly migrations: readonly MigrationPlan[]
  /** Lower-level handles, useful for tests or advanced operators. */
  readonly migrator: Migrator
  readonly connection: Connection
  /** Close the connection pool. Idempotent. */
  close(): Promise<void>
}

/**
 * Construct an `Engine`. Holds the schema, the connection pool, the
 * admin ops surface, the migrator, and a factory for tenant-scoped
 * clients. Application code typically holds one Engine for the
 * lifetime of the process.
 */
export function createEngine(options: EngineOptions): Engine {
  const connection = openConnection(options.connection)
  const hasher = options.hasher ?? sha256Hasher
  const hooks = createHookRegistry()
  const migrations: readonly MigrationPlan[] = [
    planInitialMigration(options.schema, options.migration),
  ]
  const migrator = createMigrator(connection, hooks)

  const adapterRegistry = new Map<string, AdapterContract>()

  // Engine reference threaded into the OutboundContext so adapters can
  // call back into the runtime. Captured lazily because the engine
  // object isn't constructed yet at this point.
  let engineRef: Engine | null = null

  const buildDispatch = (handler: OutboxHandler | undefined): OutboxDispatch => {
    return async (event: OutboxEvent) => {
      const adapter = findMatchingAdapter(adapterRegistry, event)
      if (adapter) {
        if (!engineRef) throw new LokiError('Engine not yet initialized.')
        const ctx = makeOutboundContext(engineRef, event, adapter.name)
        await adapter.runOutbound(event, ctx)
        return
      }
      if (handler) {
        await handler(event)
        return
      }
      // No adapter, no handler — fall through silently. The event stays
      // delivered (caller has chosen not to do anything with it).
    }
  }

  const outbox = buildOutboxOps({ connection, hooks, buildDispatch })
  const reconciler = createReconciler({ connection, hasher, hooks })

  const adapters: AdaptersOps = {
    register(adapter) {
      if (adapterRegistry.has(adapter.name)) {
        throw new LokiError(
          `Adapter "${adapter.name}" is already registered. Call unregister(name) first.`,
        )
      }
      adapterRegistry.set(adapter.name, adapter)
    },
    unregister(name) {
      return adapterRegistry.delete(name)
    },
    get(name) {
      return adapterRegistry.get(name)
    },
    list() {
      return Array.from(adapterRegistry.values())
    },
    async handleInbound(adapterName, eventName, payload, ctx) {
      const adapter = adapterRegistry.get(adapterName)
      if (!adapter) {
        throw new LokiError(`No adapter registered with name "${adapterName}".`)
      }
      if (!engineRef) throw new LokiError('Engine not yet initialized.')
      const result = await adapter.runInbound(eventName, payload, ctx)
      // Drive the resolved transition through the typed engine surface.
      const tenant = engineRef.forTenant(ctx.tenantId)
      await tenant.transactions.transition({
        id: result.txnId,
        name: result.transition,
        by: result.by ?? { type: 'System', id: adapter.name },
        idempotencyKey: result.idempotencyKey,
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(result.withKey !== undefined ? { withKey: result.withKey } : {}),
        ...(result.traceId !== undefined ? { traceId: result.traceId } : {}),
      })
      return result
    },
  }

  const engine: Engine = {
    schema: options.schema,
    admin: buildAdminOps(connection, hooks),
    hooks,
    outbox,
    reconciler,
    adapters,
    forTenant(tenantId: string) {
      return buildTenantClient({
        schema: options.schema,
        tenantId,
        connection,
        hasher,
        hooks,
      })
    },
    async migrate() {
      return migrator.apply(migrations)
    },
    async rollback() {
      const last = migrations[migrations.length - 1]
      if (!last) return
      await migrator.rollback(last)
    },
    migrations,
    migrator,
    connection,
    async close() {
      await connection.close()
    },
  }

  engineRef = engine
  return engine
}

function findMatchingAdapter(
  registry: ReadonlyMap<string, AdapterContract>,
  event: OutboxEvent,
): AdapterContract | undefined {
  if (event.intent === null || event.intent === undefined) return undefined
  for (const adapter of registry.values()) {
    if (adapter.matches(event)) return adapter
  }
  return undefined
}

function makeOutboundContext(
  engine: Engine,
  event: OutboxEvent,
  adapterName: string,
): AdapterOutboundContext {
  const drive = async (
    action: { transition: string; data?: Record<string, unknown> },
    suffix: 'confirm' | 'fail',
    overrides?: {
      by?: { type: string; id: string }
      idempotencyKey?: string
      withKey?: string
      traceId?: string
    },
  ): Promise<void> => {
    const tenant = engine.forTenant(event.tenantId)
    await tenant.transactions.transition({
      id: event.txnId,
      name: action.transition,
      by: overrides?.by ?? { type: 'System', id: adapterName },
      idempotencyKey: overrides?.idempotencyKey ?? `${event.id}:${suffix}`,
      ...(action.data !== undefined ? { data: action.data } : {}),
      ...(overrides?.withKey !== undefined ? { withKey: overrides.withKey } : {}),
      ...(overrides?.traceId !== undefined ? { traceId: overrides.traceId } : {}),
    })
  }
  return {
    outboxId: event.id,
    tenantId: event.tenantId,
    confirm(action) {
      return drive(action, 'confirm', {
        ...(action.by !== undefined ? { by: action.by } : {}),
        ...(action.idempotencyKey !== undefined ? { idempotencyKey: action.idempotencyKey } : {}),
        ...(action.withKey !== undefined ? { withKey: action.withKey } : {}),
        ...(action.traceId !== undefined ? { traceId: action.traceId } : {}),
      })
    },
    fail(action) {
      return drive(action, 'fail', {
        ...(action.by !== undefined ? { by: action.by } : {}),
        ...(action.idempotencyKey !== undefined ? { idempotencyKey: action.idempotencyKey } : {}),
        ...(action.withKey !== undefined ? { withKey: action.withKey } : {}),
        ...(action.traceId !== undefined ? { traceId: action.traceId } : {}),
      })
    },
  }
}
