// Public API surface for `@loki/core`.
//
// M1 ships the schema DSL: tenant / actor / account / transaction
// builders, runtime validation, primitive types (postings, currency,
// ULID). The engine, runtime client, reconciler, hooks, and adapter
// SDK are layered on top in subsequent batches per `project.md` §18.

// --- schema DSL builders ---
export { defineTenant } from './schema/tenant.js'
export type { TenantInput } from './schema/tenant.js'

export { defineActor } from './schema/actor.js'
export type { ActorInput } from './schema/actor.js'

export { defineTransaction, NONE_STATE } from './schema/transaction.js'
export type {
  TransactionInputArgs,
  TransitionFactory,
} from './schema/transaction.js'

export { defineSchema } from './schema/schema.js'
export type { SchemaInputArgs } from './schema/schema.js'

// --- schema types (runtime + type-only) ---
export type {
  AccountDef,
  AccountInstanceRef,
  AccountOptions,
  AccountSpecMap,
  ActorDef,
  Direction,
  InferPayload,
  InvariantFn,
  NoneState,
  ParticipantHandle,
  Posting,
  PostingDraft,
  PostingsFn,
  PostingsInvertRef,
  PostingsSpec,
  ResolvedParticipants,
  SchemaDef,
  SchemaInput,
  SchemaKind,
  TenantDef,
  TransactionDef,
  TransactionInput,
  TransitionContext,
  TransitionDef,
  TransitionInput,
} from './schema/types.js'

// --- validation ---
export { validateSchema } from './schema/validate.js'
export type { ValidateOptions, ValidateResult } from './schema/validate.js'
export { SchemaError } from './schema/errors.js'
export type { SchemaIssue, SchemaIssueCode } from './schema/errors.js'

// --- primitives ---
export { isBalanced, sumByDirection } from './primitives/posting.js'
export {
  ZERO,
  formatMinor,
  isNonNegative,
  isPositive,
} from './primitives/currency.js'
export type { CurrencyCode } from './primitives/currency.js'
export { ULID_REGEX, ulid } from './primitives/ulid.js'

// --- DDL / migrations ---
export {
  buildDropIndexesSql,
  buildDropRlsSql,
  buildDropRolesSql,
  buildDropTablesSql,
  buildGrantsSql,
  buildIndexesSql,
  buildRlsSql,
  buildRolesSql,
  buildTablesSql,
  DEFAULT_OPTIONS as DEFAULT_MIGRATION_OPTIONS,
  ENGINE_TABLES,
  ident,
  inList,
  literal,
  literalString,
  planInitialMigration,
  resolveOptions,
  SqlError,
  TENANT_GUC,
  trimSql,
} from './db/index.js'
export type {
  EngineTable,
  MigrationOptions,
  MigrationPlan,
  ResolvedMigrationOptions,
  TenancyMode,
} from './db/index.js'

// --- engine ---
export {
  ActorNotPermittedError,
  buildAccountOps,
  buildAdminOps,
  buildOutboxOps,
  buildRecordOps,
  buildTenantClient,
  canonicalize,
  CanonicalizationError,
  canonicalizeToString,
  CompromisedRecordError,
  ConcurrencyConflictError,
  computePostingsChecksum,
  computeRowHash,
  createEngine,
  createHookRegistry,
  createMigrator,
  createReconciler,
  DatabaseError,
  DEFAULT_SEVERITY,
  ENGINE_TENANT_GUC,
  IllegalStateTransitionError,
  KeyAlreadyConsumedError,
  LokiError,
  markResolved,
  matchesHookFilter,
  MIGRATIONS_TABLE,
  MigrationMismatchError,
  openConnection,
  recordAnomaly,
  RejectTransition,
  sha256Hasher,
  UnbalancedPostingsError,
  UnknownTransitionError,
} from './engine/index.js'
export type {
  AccountIdentity,
  AccountOps,
  AccountRow,
  ActorRef,
  AdminOps,
  AfterTransitionEvent,
  AnomalyCheckName,
  AnomalyDraft,
  AnomalyEvent,
  AnomalySeverity,
  AppliedMigration,
  BeforeTransitionEvent,
  CanonicalValue,
  Connection,
  ConnectionInput,
  CreateAccountInput,
  CreateRecordInput,
  CreateRecordResult,
  CreateTenantInput,
  Engine,
  EngineOptions,
  EnginePosting,
  Hasher,
  HookFailureEvent,
  HookFilter,
  HookHandler,
  HookRegistry,
  HookUnsubscribe,
  Migrator,
  MigratorStatus,
  OutboxEvent,
  OutboxFailureTerminalEvent,
  OutboxHandler,
  OutboxOps,
  OutboxWorkerHandle,
  OutboxWorkerOptions,
  QuarantineEvent,
  Reconciler,
  ReconcilerContext,
  ReconcilerHandle,
  ReconcilerStartOptions,
  RecordOps,
  RunOnceOptions,
  RunOnceResult,
  SqlClient,
  SqlTransaction,
  TenantClient,
  TenantOps,
  TenantRow,
  TransitionInputArgs,
  TransitionResult,
  TxnRecord,
  TxnTransition,
} from './engine/index.js'

// --- meta ---
export { LOKI_CORE_VERSION } from './version.js'
