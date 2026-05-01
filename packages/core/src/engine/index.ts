// Public surface for the engine.

export { buildAdminOps } from './admin.js'
export type { AdminOps, TenantOps } from './admin.js'

export { buildAccountOps } from './accounts.js'
export type { AccountOps } from './accounts.js'

export { buildTenantClient } from './client.js'
export type { TenantClient } from './client.js'

export { canonicalize, canonicalizeToString, CanonicalizationError } from './canonical.js'
export type { CanonicalValue } from './canonical.js'

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

export { createMigrator, MIGRATIONS_TABLE } from './migrator.js'
export type { AppliedMigration, Migrator, MigratorStatus } from './migrator.js'

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
