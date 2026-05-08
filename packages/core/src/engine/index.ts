// Public surface for the engine.

export { buildAdminOps } from './admin.js'
export type {
  AdminOps,
  FindViolationsArgs,
  ProvisionTenantInput,
  ProvisionTenantResult,
  SchemaAdminOps,
  SchemaVersionCount,
  TenantOps,
  TenantSnapshot,
  ViolationHit,
} from './admin.js'

export { isSagaSuccess, runSaga } from './saga.js'
export type { SagaContext, SagaOptions, SagaResult, SagaStep } from './saga.js'

export { buildAccountOps } from './accounts.js'
export type { AccountOps } from './accounts.js'

export { buildTenantClient } from './client.js'
export type { TenantClient } from './client.js'

export { canonicalize, canonicalizeToString, CanonicalizationError } from './canonical.js'
export type { CanonicalValue } from './canonical.js'

export { DEFAULT_SEVERITY, markResolved, recordAnomaly } from './anomalies.js'
export type { AnomalyDraft } from './anomalies.js'

export { decodeCursor, encodeCursor } from './cursor.js'
export type { Cursor, Order, Page } from './cursor.js'

export { buildQueryOps } from './queries.js'
export type {
  AccountAggregate,
  AccountAggregateArgs,
  AccountAggregateMetric,
  AccountHistoryArgs,
  AccountQueryOps,
  ActorScopedOps,
  ActorSummary,
  ActorSummaryArgs,
  ActorTransactionsArgs,
  AmountFilter,
  DateLike,
  FindManyAnomaliesArgs,
  FindManyPostingsArgs,
  FindManyTransactionsArgs,
  FindManyTransitionsArgs,
  QueryOps,
  VerifyResult,
} from './queries.js'

export {
  NOOP_LOGGER,
  NOOP_METRICS,
  NOOP_TRACER,
  buildInstruments,
  consoleLogger,
} from './observability.js'
export type {
  Counter,
  EngineInstruments,
  Gauge,
  Histogram,
  LogFields,
  LogLevel,
  Logger,
  MetricLabels,
  MetricsAdapter,
  Span,
  SpanStatus,
  Tracer,
} from './observability.js'

export {
  DEFAULT_POOL_OPTIONS,
  compareLsn,
  openConnection,
  withSearchPath,
} from './connection.js'

export { gracefulShutdown, installShutdownHandlers } from './lifecycle.js'
export type {
  EngineLike,
  GracefulShutdownOptions,
  ShutdownTarget,
} from './lifecycle.js'
export type {
  Connection,
  ConnectionInput,
  ReadYourWritesMode,
  RuntimeRoles,
  SqlClient,
  SqlTransaction,
} from './connection.js'

export { createEngine } from './engine.js'
export type {
  AdaptersOps,
  DatabaseHealth,
  Engine,
  EngineOptions,
  HealthCheckOptions,
  HealthReport,
  ReplicaHealth,
} from './engine.js'

export {
  ActorNotPermittedError,
  CompromisedRecordError,
  ConcurrencyConflictError,
  DatabaseError,
  IllegalStateTransitionError,
  InvalidPostingError,
  KeyAlreadyConsumedError,
  OverdraftError,
  LokiError,
  MigrationMismatchError,
  RejectTransition,
  UnbalancedPostingsError,
  UnknownTransitionError,
} from './errors.js'

export { computePostingsChecksum, computeRowHash, sha256Hasher } from './hash.js'
export type { Hasher } from './hash.js'

export {
  BeforeTransitionTimeoutError,
  createHookRegistry,
  matches as matchesHookFilter,
} from './hooks.js'
export type { HookRegistryOptions } from './hooks.js'
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
  IntegrityViolationEvent,
  OutboxFailureTerminalEvent,
  QuarantineEvent,
  ReconciliationCompleteEvent,
  ReversalEvent,
  SchemaMigrationEvent,
  TenantLifecycleEvent,
  Unsubscribe as HookUnsubscribe,
} from './hooks.js'

export { buildOutboxOps } from './outbox.js'
export type {
  OutboxDispatch,
  OutboxEvent,
  OutboxHandler,
  OutboxOps,
  OutboxWorkerHandle,
  OutboxWorkerOptions,
} from './outbox.js'

export type {
  AdapterContract,
  AdapterInboundContext,
  AdapterInboundResult,
  AdapterOutboundContext,
  AdapterTransitionAction,
} from './adapter.js'

export { createReconciler, nextFireMs, RECONCILER_STATE_TABLE } from './reconciler.js'
export type {
  Reconciler,
  ReconcilerContext,
  ReconcilerHandle,
  ReconcilerSchedule,
  RunOnceOptions,
  RunOnceResult,
  StartOptions as ReconcilerStartOptions,
} from './reconciler.js'

export { buildPartitionsOps } from './partitions.js'
export type {
  EnsureForOptions,
  EnsuredPartition,
  PartitionTable,
  PartitionsOps,
} from './partitions.js'

export { buildFxOps } from './fx.js'
export type {
  FxOps,
  FxRate,
  FxRateHistoryInput,
  LookupFxRateInput,
  PublishFxRateInput,
} from './fx.js'

export { buildHoldsOps } from './holds.js'
export type {
  ExpireHoldsResult,
  Hold,
  HoldStatus,
  HoldsOps,
  PlaceHoldInput,
  ReleaseHoldInput,
} from './holds.js'

export { buildDisputesOps } from './disputes.js'
export type {
  Dispute,
  DisputeStatus,
  DisputesOps,
  ExpireDisputesResult,
  OpenDisputeInput,
  ResolveDisputeInput,
} from './disputes.js'

export { buildScheduler } from './scheduler.js'
export type {
  CreateScheduledTransitionInput,
  ListScheduledFilter,
  RunDueOptions,
  RunDueResult,
  Scheduler,
  ScheduledTransition,
  ScheduledTransitionStatus,
  SchedulerWorkerHandle,
  SchedulerWorkerOptions,
} from './scheduler.js'

export { createMigrator, MIGRATIONS_TABLE } from './migrator.js'
export type { AppliedMigration, Migrator, MigratorStatus } from './migrator.js'

export { TENANT_GUC as ENGINE_TENANT_GUC } from '../db/rls.js'

export { buildRecordOps } from './records.js'
export type { BulkTransitionItem, RecordOps } from './records.js'

export type {
  AccountIdentity,
  AccountRow,
  ActorRef,
  AnomalyRow,
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
