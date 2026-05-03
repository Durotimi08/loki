/**
 * Engine error hierarchy. All engine errors inherit from `LokiError` so
 * application code can `catch (e instanceof LokiError)` to scope to
 * package-emitted errors only.
 */
export class LokiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LokiError'
  }
}

/** A transition was requested with a name not in the schema. */
export class UnknownTransitionError extends LokiError {
  constructor(transactionType: string, transitionName: string) {
    super(`Transaction "${transactionType}" has no transition named "${transitionName}".`)
    this.name = 'UnknownTransitionError'
  }
}

/** The current record state does not match any of the transition's `from` states. */
export class IllegalStateTransitionError extends LokiError {
  readonly currentState: string
  readonly transitionName: string
  readonly allowedFromStates: readonly string[]

  constructor(opts: {
    transactionType: string
    transitionName: string
    currentState: string
    allowedFromStates: readonly string[]
  }) {
    super(
      `Transition "${opts.transitionName}" on "${opts.transactionType}" cannot fire from state "${opts.currentState}". Allowed from-states: [${opts.allowedFromStates.join(', ')}].`,
    )
    this.name = 'IllegalStateTransitionError'
    this.currentState = opts.currentState
    this.transitionName = opts.transitionName
    this.allowedFromStates = opts.allowedFromStates
  }
}

/** A required capability key was not active or had already been consumed. */
export class KeyAlreadyConsumedError extends LokiError {
  constructor(transactionId: string, keyName: string) {
    super(
      `Capability key "${keyName}" on record ${transactionId} is not active or has already been consumed.`,
    )
    this.name = 'KeyAlreadyConsumedError'
  }
}

/**
 * Postings on a transition do not balance (sum debits ≠ sum credits).
 *
 * Multi-currency: balance is enforced per currency. `currency === null`
 * is the legacy single-currency form; `currency` populated identifies
 * the offending leg of an FX transition.
 */
export class UnbalancedPostingsError extends LokiError {
  readonly debits: bigint
  readonly credits: bigint
  readonly currency: string | null

  constructor(debits: bigint, credits: bigint, currency: string | null = null) {
    const suffix = currency ? ` for currency ${currency}` : ''
    super(`Transition postings do not balance${suffix}: sum(D) = ${debits}, sum(C) = ${credits}.`)
    this.name = 'UnbalancedPostingsError'
    this.debits = debits
    this.credits = credits
    this.currency = currency
  }
}

/** The actor driving a transition isn't permitted by the schema's `by` clause. */
export class ActorNotPermittedError extends LokiError {
  constructor(opts: {
    transactionType: string
    transitionName: string
    actorType: string
    permitted: readonly string[]
  }) {
    super(
      `Actor type "${opts.actorType}" cannot drive "${opts.transactionType}.${opts.transitionName}". Permitted: [${opts.permitted.join(', ')}].`,
    )
    this.name = 'ActorNotPermittedError'
  }
}

/** The record is marked `compromised` and refuses further transitions. */
export class CompromisedRecordError extends LokiError {
  readonly recordId: string
  constructor(recordId: string) {
    super(
      `Record ${recordId} has been quarantined (compromised = true). It refuses further transitions until cleared.`,
    )
    this.name = 'CompromisedRecordError'
    this.recordId = recordId
  }
}

/** Optimistic-lock retry budget exhausted. */
export class ConcurrencyConflictError extends LokiError {
  constructor(recordId: string, attempts: number) {
    super(`Concurrency conflict on record ${recordId} after ${attempts} retries.`)
    this.name = 'ConcurrencyConflictError'
  }
}

/**
 * A posting draft was rejected before reaching the balanced check —
 * negative amount, missing account ref, or zero postings on a
 * transition that declared a `postings` clause. Distinct from
 * `UnbalancedPostingsError` so callers can tell "your numbers don't
 * add up" apart from "your inputs are malformed".
 */
export class InvalidPostingError extends LokiError {
  readonly reason: string
  constructor(reason: string, detail?: Record<string, unknown>) {
    const tail = detail ? ` ${JSON.stringify(detail)}` : ''
    super(`Invalid posting: ${reason}.${tail}`)
    this.name = 'InvalidPostingError'
    this.reason = reason
  }
}

/**
 * Thrown when a transition would take an account with
 * `allowOverdraft: false` below zero. The transition tx is rolled
 * back; nothing is written. M1.
 */
export class OverdraftError extends LokiError {
  readonly accountId: string
  readonly currentBalance: bigint
  readonly attemptedDelta: bigint
  constructor(opts: {
    accountId: string
    accountName: string
    actorType: string
    actorId: string
    currency: string
    currentBalance: bigint
    attemptedDelta: bigint
  }) {
    const next = opts.currentBalance + opts.attemptedDelta
    super(
      `Overdraft refused on ${opts.actorType}:${opts.actorId}.${opts.accountName} (${opts.currency}): balance ${opts.currentBalance} + delta ${opts.attemptedDelta} = ${next} < 0.`,
    )
    this.name = 'OverdraftError'
    this.accountId = opts.accountId
    this.currentBalance = opts.currentBalance
    this.attemptedDelta = opts.attemptedDelta
  }
}

/** A pre-transition `RejectTransition` was thrown by application code or `invariant`. */
export class RejectTransition extends LokiError {
  constructor(reason: string) {
    super(`Transition rejected: ${reason}`)
    this.name = 'RejectTransition'
  }
}

/** Migration runner detected a divergence between recorded and computed migration content. */
export class MigrationMismatchError extends LokiError {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationMismatchError'
  }
}

/** Generic wrapper for unexpected DB errors that bubbled up from the driver. */
export class DatabaseError extends LokiError {
  override readonly cause: unknown
  constructor(message: string, cause: unknown) {
    super(message)
    this.name = 'DatabaseError'
    this.cause = cause
  }
}
