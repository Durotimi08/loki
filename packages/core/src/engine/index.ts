// Public surface for the engine.

export { buildAdminOps } from './admin.js'
export type { AdminOps, TenantOps } from './admin.js'

export { buildAccountOps } from './accounts.js'
export type { AccountOps } from './accounts.js'

export { buildTenantClient } from './client.js'
export type { TenantClient } from './client.js'

export { canonicalize, canonicalizeToString, CanonicalizationError } from './canonical.js'
export type { CanonicalValue } from './canonical.js'

export { DEFAULT_SEVERITY, markResolved, recordAnomaly } from './anomalies.js'
export type { AnomalyDraft } from './anomalies.js'

export { openConnection } from './connection.js'
export type { Connection, ConnectionInput, SqlClient, SqlTransaction } from './connection.js'

export { createEngine } from './engine.js'
export type { Engine, EngineOptions } from './engine.js'

export {
  ActorNotPermittedError,
  CompromisedRecordError,
  ConcurrencyConflictError,
  DatabaseError,
  IllegalStateTransitionError,
  KeyAlreadyConsumedError,
  LokiError,
  MigrationMismatchError,
  RejectTransition,
  UnbalancedPostingsError,
  UnknownTransitionError,
} from './errors.js'

export { computePostingsChecksum, computeRowHash, sha256Hasher } from './hash.js'
export type { Hasher } from './hash.js'

export { createHookRegistry, matches as matchesHookFilter } from './hooks.js'
export type {
  AfterTransitionEvent,
  AnomalyCheckName,
  AnomalyEvent,
  AnomalySeverity,
  BeforeTransitionEvent,
  Filter as HookFilter,
  Handler as HookHandler,
  HookFailureEvent,
  HookRegistry,
  OutboxFailureTerminalEvent,
  QuarantineEvent,
  Unsubscribe as HookUnsubscribe,
} from './hooks.js'

export { buildOutboxOps } from './outbox.js'
export type {
  OutboxEvent,
  OutboxHandler,
  OutboxOps,
  OutboxWorkerHandle,
  OutboxWorkerOptions,
} from './outbox.js'

export { createReconciler } from './reconciler.js'
export type {
  Reconciler,
  ReconcilerContext,
  ReconcilerHandle,
  RunOnceOptions,
  RunOnceResult,
  StartOptions as ReconcilerStartOptions,
} from './reconciler.js'

export { createMigrator, MIGRATIONS_TABLE } from './migrator.js'
export type { AppliedMigration, Migrator, MigratorStatus } from './migrator.js'

export { TENANT_GUC as ENGINE_TENANT_GUC } from '../db/rls.js'

export { buildRecordOps } from './records.js'
export type { RecordOps } from './records.js'

export type {
  AccountIdentity,
  AccountRow,
  ActorRef,
  CreateAccountInput,
  CreateRecordInput,
  CreateRecordResult,
  CreateTenantInput,
  Posting as EnginePosting,
  TenantRow,
  TransitionInputArgs,
  TransitionResult,
  TxnRecord,
  TxnTransition,
} from './types.js'
