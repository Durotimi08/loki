import type { Direction } from '../primitives/posting.js'

// =============================================================================
// Public engine types — surfaced through the runtime client.
// =============================================================================

export type ActorRef = {
  readonly type: string
  readonly id: string
}

export type AccountRow = {
  readonly id: string
  readonly tenantId: string
  readonly ownerActorType: string
  readonly ownerActorId: string
  readonly name: string
  readonly currency: string
  readonly shardIndex: number
  readonly parentAccountId: string | null
  readonly balance: bigint
  readonly createdAt: Date
}

export type AccountIdentity = {
  readonly actor: ActorRef
  readonly name: string
  readonly currency: string
  readonly shardIndex?: number
}

export type TenantRow = {
  readonly id: string
  readonly name: string
  readonly mode: 'db' | 'schema' | 'row'
  readonly state: 'active' | 'suspended' | 'deleted'
  readonly createdAt: Date
}

export type TxnRecord = {
  readonly id: string
  readonly tenantId: string
  readonly type: string
  readonly state: string
  readonly version: number
  readonly activeKeys: readonly string[]
  /** Participant slot → actor ref, set at create-time and immutable afterwards. */
  readonly participants: Readonly<Record<string, ActorRef>>
  readonly createdBy: ActorRef
  readonly compromised: boolean
  readonly schemaVersion: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type TxnTransition = {
  readonly id: string
  readonly tenantId: string
  readonly txnId: string
  readonly type: string
  readonly fromState: string | null
  readonly toState: string
  readonly name: string
  readonly schemaVersion: number
  readonly actor: ActorRef
  readonly payload: Record<string, unknown>
  readonly idempotencyKey: string
  readonly traceId: string | null
  readonly prevHash: Buffer | null
  readonly rowHash: Buffer
  readonly postingsChecksum: Buffer
  readonly reverses: string | null
  readonly occurredAt: Date
}

export type Posting = {
  readonly id: string
  readonly tenantId: string
  readonly transitionId: string
  readonly accountId: string
  readonly amount: bigint
  readonly direction: Direction
  readonly occurredAt: Date
}

// =============================================================================
// Inputs
// =============================================================================

export type CreateTenantInput = {
  readonly id: string
  readonly name: string
  readonly mode?: 'db' | 'schema' | 'row'
}

export type CreateAccountInput = {
  readonly actor: ActorRef
  readonly name: string
  readonly currency?: string
  readonly shardIndex?: number
  readonly parentAccountId?: string
}

export type CreateRecordInput = {
  /** Schema-declared transaction type (e.g. `'DeliveryPayment'`). */
  readonly type: string
  /** The actor on whose behalf the record is created. */
  readonly by: ActorRef
  /**
   * Map of participant slot → actor ref, e.g.
   * `{ user: { type: 'User', id: 'u-1' }, driver: { type: 'Driver', id: 'd-1' } }`.
   * The slot names must match those declared in the transaction's
   * `participants` clause; the actor types must match too. Stored on
   * the record and used to resolve account refs in subsequent
   * transitions' `postings` functions.
   */
  readonly participants?: Readonly<Record<string, ActorRef>>
  /** Idempotency key; same key on retry returns the original record. */
  readonly idempotencyKey: string
  /** Optional trace id propagated to the audit log and outbox. */
  readonly traceId?: string
}

export type TransitionInputArgs = {
  readonly id: string
  readonly name: string
  readonly by: ActorRef
  readonly idempotencyKey: string
  readonly data?: Record<string, unknown>
  /** ID of an active capability key being consumed (the engine verifies it). */
  readonly withKey?: string
  /** Optional trace id propagated to the audit log and outbox. */
  readonly traceId?: string
}

export type TransitionResult = {
  readonly record: TxnRecord
  readonly transition: TxnTransition
  readonly postings: readonly Posting[]
  /** Map of unlocked-key-name → fresh active key id, ready for `withKey`. */
  readonly unlocked: Readonly<Record<string, string>>
  /** True when the call was a no-op replay because the idempotency key was already used. */
  readonly replayed: boolean
}

export type CreateRecordResult = {
  readonly record: TxnRecord
  /** True when the call was a no-op replay because the idempotency key was already used. */
  readonly replayed: boolean
}
