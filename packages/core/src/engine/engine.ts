import { planInitialMigration } from '../db/migration.js'
import type { MigrationOptions, MigrationPlan } from '../db/types.js'
import { type PayloadCrypto, decryptPayload } from '../primitives/payload-crypto.js'
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
import { type DisputesOps, buildDisputesOps } from './disputes.js'
import { LokiError } from './errors.js'
import { type FxOps, buildFxOps } from './fx.js'
import { type Hasher, sha256Hasher } from './hash.js'
import { type HoldsOps, buildHoldsOps } from './holds.js'
import { type HookRegistry, createHookRegistry } from './hooks.js'
import { type Migrator, createMigrator } from './migrator.js'
import {
  type EngineInstruments,
  type MetricsAdapter,
  type Tracer,
  buildInstruments,
} from './observability.js'
import {
  type OutboxDispatch,
  type OutboxEvent,
  type OutboxHandler,
  type OutboxOps,
  buildOutboxOps,
} from './outbox.js'
import { type PartitionsOps, buildPartitionsOps } from './partitions.js'
import { type Reconciler, createReconciler } from './reconciler.js'
import { type Scheduler, buildScheduler } from './scheduler.js'

export type EngineOptions = {
  /** The compiled schema. */
  readonly schema: SchemaDef
  /** Postgres connection — URL string or a pre-built postgres.js client. */
  readonly connection: ConnectionInput
  /** Migration / DDL options. Defaults: RLS tenancy, ledger_app/ledger_admin roles. */
  readonly migration?: MigrationOptions
  /** Hash chain implementation. Defaults to SHA-256. */
  readonly hasher?: Hasher
  /**
   * Per-tenant connection resolver (§7.2). Returning `null` falls back
   * to the default connection (RLS mode). Returning a `Connection`
   * routes that tenant's queries to the alternative — typically a
   * search-path-scoped wrap (schema-per-tenant) or a separate pool
   * (db-per-tenant). The default treats every tenant as RLS.
   */
  readonly connectionFor?: (tenantId: string) => Connection | null
  /**
   * Hook-system options. Currently:
   *   - `beforeTransitionTimeoutMs`: max time a beforeTransition
   *     handler can run inside the transition tx. Default 1000ms.
   *     Pass `null` to disable.
   */
  readonly hooks?: {
    readonly beforeTransitionTimeoutMs?: number | null
  }
  /**
   * Override how the engine picks a shard when posting to a sharded
   * account (M7). Returns an integer in `[0, n)`. Default
   * `Math.random` — fine for distribution; swap in a seeded variant
   * (or `() => 0`) for deterministic tests.
   */
  readonly shardPicker?: (n: number) => number
  /**
   * Wall-clock injection hook for tests. Defaults to `() => new Date()`.
   * Anywhere the engine assigns `occurred_at` or computes a deadline,
   * it goes through this. Pass a stub to drive scheduled-transition
   * tests without sleeping or to pin hash chains for snapshots.
   */
  readonly clock?: () => Date
  /**
   * Optional payload-encryption hook (M6). When set, every payload that
   * lands in `txn_transitions.payload`, `outbox.payload`, or
   * `txn_anomalies.expected/observed` is encrypted before storage and
   * decrypted on read. The hash chain is computed over the PLAINTEXT
   * canonical form so a key rotation never invalidates existing
   * `row_hash` values.
   *
   * Default `undefined` — payloads are stored as plaintext JSON
   * (current behaviour, byte-for-byte unchanged).
   *
   * Read paths inside the engine (transition → trace, outbox dispatch,
   * reconciler hash verify) auto-decrypt. For raw rows that bypass the
   * engine API (a direct SELECT against `txn_transitions`, an adapter
   * inspecting an outbox row before processing), use
   * `engine.decryptPayload(value)` to convert an envelope back to its
   * plaintext form.
   */
  readonly payloadCrypto?: PayloadCrypto
  /**
   * Read-your-writes routing (Batch G). `'auto'` enables per-async-
   * context LSN tracking — the next replica-eligible read after a
   * primary write checks the replica's `pg_last_wal_replay_lsn()` and
   * routes to the primary instead when the replica hasn't caught up.
   *
   * Default `'off'` (current behaviour). No-op when no read replica
   * is configured on the underlying connection.
   *
   * This forwards to `ConnectionInput.readYourWrites` — pass it here
   * if you constructed the engine with a URL connection input;
   * otherwise set it on the connection input directly.
   */
  readonly readYourWrites?: 'auto' | 'off'
  /**
   * Optional metrics adapter (Batch H). The shape matches Prometheus's
   * counter/histogram/gauge. Without one, the engine uses a no-op
   * shim — call sites compile to empty functions.
   *
   * Wired to: every transition (duration histogram, error counter),
   * every reconciler pass (duration, anomalies-by-severity), every
   * outbox dispatch (success/failure counters), every scheduler fire.
   */
  readonly metrics?: MetricsAdapter
  /**
   * Optional tracer (Batch H). The shape matches OpenTelemetry's
   * `Tracer.startSpan`. Without one, the engine uses a no-op tracer.
   */
  readonly tracer?: Tracer
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
  /** Scheduled-transition runner (§M17). */
  readonly scheduler: Scheduler
  /** Monthly-partition management (§12.3). No-op when `partitioning: 'none'`. */
  readonly partitions: PartitionsOps
  /** Adapter registry. Outbox events with an `intent` route through here. */
  readonly adapters: AdaptersOps
  /** Pre-built metric/tracer instruments (Batch H). Holds no-op shims when no adapter is configured. */
  readonly instruments: EngineInstruments
  /** FX rate publish/lookup/history (M16, Batch D). */
  readonly fx: FxOps
  /** First-class holds (M17, Batch E). */
  readonly holds: HoldsOps
  /** First-class disputes (M17, Batch E). */
  readonly disputes: DisputesOps
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
  /**
   * Decrypt a stored payload envelope (M6). Returns the value
   * untouched when it isn't an `{ "$encrypted": ... }` envelope, so
   * the same call works in both encrypted and plain-text deployments.
   * Throws `LokiError` if an envelope is encountered but no
   * `payloadCrypto` was configured on the engine.
   *
   * Adapters reading raw rows from `outbox` or `txn_transitions`
   * before they pass through the engine's read APIs should call this
   * to recover the original payload.
   */
  decryptPayload(value: unknown): Promise<unknown>
  /**
   * Health probe (Gap 10). Suitable as a readiness/liveness backend.
   *
   *   - `primary` is always probed. `select 1` against the write pool.
   *   - `replica`, when present, is probed too. The result includes
   *     `pg_last_wal_replay_lsn()` and the lag (in WAL bytes) against
   *     the primary's `pg_current_wal_lsn()`.
   *   - `migrations.applied` reports whether the bootstrap plan has
   *     landed (so a deploy can wait for migrations to apply before
   *     letting traffic in).
   *   - `nowMs` is the wall-clock time the check ran, so a probe
   *     consumer can decide whether to fail open on a stale result.
   */
  health(options?: HealthCheckOptions): Promise<HealthReport>
  /** Close the connection pool. Idempotent. */
  close(): Promise<void>
}

export type HealthCheckOptions = {
  /**
   * Per-probe timeout (ms). The probe wraps each select in
   * `Promise.race(..., setTimeout)`. Default 2000.
   */
  readonly timeoutMs?: number
}

export type DatabaseHealth =
  | { readonly ok: true; readonly latencyMs: number; readonly lsn?: string }
  | { readonly ok: false; readonly error: string; readonly latencyMs: number }

export type ReplicaHealth = DatabaseHealth & {
  /**
   * Approximate lag in WAL bytes between primary's
   * `pg_current_wal_lsn()` and the replica's
   * `pg_last_wal_replay_lsn()`. Negative or unavailable when either
   * probe failed.
   */
  readonly lagBytes?: number
}

export type HealthReport = {
  readonly ok: boolean
  readonly nowMs: number
  readonly primary: DatabaseHealth
  readonly replica: ReplicaHealth | null
  readonly migrations: {
    readonly applied: boolean
    readonly count: number
  }
}

/**
 * Construct an `Engine`. Holds the schema, the connection pool, the
 * admin ops surface, the migrator, and a factory for tenant-scoped
 * clients. Application code typically holds one Engine for the
 * lifetime of the process.
 */
export function createEngine(options: EngineOptions): Engine {
  // Batch G: forward `readYourWrites` to the connection layer when the
  // caller passed it on EngineOptions (and didn't already set it on
  // the ConnectionInput). The connection input wins if both are set.
  const connectionInput =
    options.readYourWrites !== undefined && !('readYourWrites' in options.connection)
      ? ({ ...options.connection, readYourWrites: options.readYourWrites } as ConnectionInput)
      : options.connection
  const connection = openConnection(connectionInput)
  // Batch H: pre-resolve the instrument set once. No-op shims kick in
  // when neither `metrics` nor `tracer` is configured.
  const instruments = buildInstruments(options.metrics, options.tracer)
  const hasher = options.hasher ?? sha256Hasher
  const hooks = createHookRegistry({
    ...(options.hooks?.beforeTransitionTimeoutMs !== undefined
      ? { beforeTransitionTimeoutMs: options.hooks.beforeTransitionTimeoutMs }
      : {}),
  })
  const tablePrefix = options.migration?.tablePrefix ?? ''
  const migrations: readonly MigrationPlan[] = [
    planInitialMigration(options.schema, options.migration),
  ]
  const migrator = createMigrator(connection, hooks, { tablePrefix })

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

  const outbox = buildOutboxOps({
    connection,
    hooks,
    buildDispatch,
    ...(options.payloadCrypto !== undefined ? { payloadCrypto: options.payloadCrypto } : {}),
    instruments,
  })
  const reconciler = createReconciler({
    connection,
    hasher,
    hooks,
    tablePrefix,
    ...(options.payloadCrypto !== undefined ? { payloadCrypto: options.payloadCrypto } : {}),
    instruments,
  })
  const scheduler = buildScheduler({
    connection,
    hooks,
    fire: async (input) => {
      if (!engineRef) throw new LokiError('Engine not yet initialized.')
      const tenant = engineRef.forTenant(input.tenantId)
      const out = await tenant.transactions.transition({
        id: input.txnId,
        name: input.name,
        by: input.by,
        idempotencyKey: input.idempotencyKey,
        ...(input.data !== undefined ? { data: input.data } : {}),
        ...(input.withKey !== undefined ? { withKey: input.withKey } : {}),
      })
      return { transitionId: out.transition.id }
    },
  })

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
    admin: buildAdminOps(connection, hooks, { migrations, migrator }),
    hooks,
    outbox,
    reconciler,
    scheduler,
    partitions: buildPartitionsOps(connection),
    adapters,
    instruments,
    fx: buildFxOps(connection),
    holds: buildHoldsOps(connection),
    disputes: buildDisputesOps(connection),
    forTenant(tenantId: string) {
      // H5: cheap synchronous validation. The deeper "is this tenant
      // active?" check happens inside transition writes via the
      // existing `tenants.state` constraint (suspended/deleted tenants
      // can't pass FKs). We refuse empty / non-string here so a buggy
      // upstream HTTP frontend can't smuggle in `''` or `null`.
      if (typeof tenantId !== 'string' || tenantId.length === 0) {
        throw new LokiError('forTenant: tenantId must be a non-empty string.')
      }
      const resolved = options.connectionFor?.(tenantId) ?? null
      return buildTenantClient({
        schema: options.schema,
        tenantId,
        connection: resolved ?? connection,
        hasher,
        hooks,
        ...(options.shardPicker !== undefined ? { shardPicker: options.shardPicker } : {}),
        ...(options.clock !== undefined ? { clock: options.clock } : {}),
        ...(options.payloadCrypto !== undefined ? { payloadCrypto: options.payloadCrypto } : {}),
        instruments,
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
    async decryptPayload(value) {
      return decryptPayload(options.payloadCrypto, value)
    },
    async health(opts = {}) {
      return runHealthCheck(connection, migrations, opts)
    },
    async close() {
      await connection.close()
    },
  }

  engineRef = engine
  return engine
}

/**
 * Probe primary + replica + migration state. Each probe is bounded by
 * `timeoutMs` (default 2000) so a wedged backend can't make a
 * readiness probe hang indefinitely. The whole report still resolves
 * even when both DB probes fail — the consumer decides whether to
 * fail open or closed based on `report.ok`.
 */
async function runHealthCheck(
  connection: Connection,
  migrations: readonly MigrationPlan[],
  opts: HealthCheckOptions,
): Promise<HealthReport> {
  const timeoutMs = opts.timeoutMs ?? 2000
  const nowMs = Date.now()

  const probePrimary = async (): Promise<DatabaseHealth & { lsn?: string }> => {
    const start = Date.now()
    try {
      const rows = await connection.sql<{ lsn: string | null }[]>`
        select pg_current_wal_lsn()::text as lsn
      `
      const latencyMs = Date.now() - start
      const lsn = rows[0]?.lsn ?? null
      return lsn ? { ok: true, latencyMs, lsn } : { ok: true, latencyMs }
    } catch (e) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }

  const primary = await withTimeout(probePrimary(), timeoutMs, 'primary')

  let replica: ReplicaHealth | null = null
  if (connection.readSql) {
    const start = Date.now()
    try {
      // The probe MUST NOT go through `withTenantReplica` — that path
      // consults the read-your-writes LSN tracker and would route to
      // the primary if the current async context has a recent write,
      // masking real replica lag. Hit the replica pool directly with
      // a read-only `pg_*` query that bypasses RLS entirely.
      const replicaSql = connection.readSql
      const rows = await withTimeout(
        replicaSql<{ lsn: string | null }[]>`
          select pg_last_wal_replay_lsn()::text as lsn
        `,
        timeoutMs,
        'replica',
      )
      const latencyMs = Date.now() - start
      const replicaLsn = rows[0]?.lsn ?? null
      const lagBytes =
        primary.ok && primary.lsn && replicaLsn ? lsnDiffBytes(primary.lsn, replicaLsn) : undefined
      const ok = replicaLsn !== null
      replica = ok
        ? {
            ok,
            latencyMs,
            ...(replicaLsn ? { lsn: replicaLsn } : {}),
            ...(lagBytes !== undefined ? { lagBytes } : {}),
          }
        : { ok: false, latencyMs, error: 'replica returned no LSN' }
    } catch (e) {
      replica = {
        ok: false,
        latencyMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }

  let migrationsApplied = false
  let migrationCount = 0
  try {
    const appliedRows = await withTimeout(
      connection.sql<{ id: string }[]>`
        select id from ${connection.sql(MIGRATIONS_TABLE_NAME)}
      `,
      timeoutMs,
      'migrations',
    )
    migrationCount = appliedRows.length
    migrationsApplied = appliedRows.length >= migrations.length
  } catch {
    // The migrations table doesn't exist yet → migrations not applied.
  }

  const ok = primary.ok && replica?.ok !== false && migrationsApplied
  return {
    ok,
    nowMs,
    primary,
    replica,
    migrations: { applied: migrationsApplied, count: migrationCount },
  }
}

const MIGRATIONS_TABLE_NAME = '_loki_migrations'

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new LokiError(`Health probe "${label}" timed out after ${ms}ms.`))
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * Approximate the byte distance between two WAL LSNs (`X/Y` hex).
 * Returns `undefined` for malformed input so the caller doesn't have
 * to guard. Sign convention: positive = replica behind primary.
 */
function lsnDiffBytes(primaryLsn: string, replicaLsn: string): number | undefined {
  const toBig = (s: string): bigint | null => {
    const [hi, lo] = s.split('/')
    if (hi === undefined || lo === undefined) return null
    try {
      return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`)
    } catch {
      return null
    }
  }
  const p = toBig(primaryLsn)
  const r = toBig(replicaLsn)
  if (p === null || r === null) return undefined
  // Clamp at JS-safe ranges; if a single deployment is more than 2^53
  // WAL bytes ahead of its replica, you have bigger problems than
  // numeric precision.
  const diff = p - r
  if (diff > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  if (diff < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER
  return Number(diff)
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
