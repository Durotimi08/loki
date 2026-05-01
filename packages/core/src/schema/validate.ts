import { SchemaError, type SchemaIssue, type SchemaIssueCode } from './errors.js'
import type {
  AccountDef,
  ActorDef,
  PostingsInvertRef,
  PostingsSpec,
  SchemaDef,
  TenantDef,
  TransactionDef,
  TransitionDef,
} from './types.js'
import { NONE_STATE } from './types.js'

const RESERVED_NAMES = new Set(['__none__', '_kind', 'meta'])
const NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/

export type ValidateOptions = {
  /** Throw a `SchemaError` if any issues are found. Default `false`. */
  readonly throwOnError?: boolean
}

export type ValidateResult = {
  readonly ok: boolean
  readonly issues: readonly SchemaIssue[]
}

/**
 * Run structural and semantic validation on a schema. Returns the
 * collected issue list. Pass `throwOnError: true` to throw a
 * `SchemaError` when any issues are present.
 */
export function validateSchema(schema: SchemaDef, options: ValidateOptions = {}): ValidateResult {
  const ctx = new ValidationCtx()
  validateTenant(schema.tenant, ctx)
  validateActors(schema.actors, ctx)
  validateTransactions(schema, ctx)

  if (options.throwOnError && ctx.issues.length > 0) {
    throw new SchemaError(ctx.issues)
  }
  return { ok: ctx.issues.length === 0, issues: ctx.issues }
}

// =============================================================================
// Internals
// =============================================================================

class ValidationCtx {
  readonly issues: SchemaIssue[] = []

  add(code: SchemaIssueCode, message: string, path: readonly (string | number)[]): void {
    this.issues.push({ code, message, path })
  }
}

function validateTenant(tenant: TenantDef, ctx: ValidationCtx): void {
  if (!isValidIdentifier(tenant.name)) {
    ctx.add('invalid_actor_name', `Tenant name "${tenant.name}" must match ${NAME_REGEX}.`, [
      'tenant',
      'name',
    ])
  }
  if (RESERVED_NAMES.has(tenant.name)) {
    ctx.add('reserved_name', `Tenant name "${tenant.name}" is reserved.`, ['tenant', 'name'])
  }
}

function validateActors(actors: readonly ActorDef[], ctx: ValidationCtx): void {
  const seen = new Set<string>()
  actors.forEach((actor, index) => {
    const path = ['actors', index] as const

    if (!isValidIdentifier(actor.name)) {
      ctx.add('invalid_actor_name', `Actor name "${actor.name}" must match ${NAME_REGEX}.`, [
        ...path,
        'name',
      ])
    }
    if (RESERVED_NAMES.has(actor.name)) {
      ctx.add('reserved_name', `Actor name "${actor.name}" is reserved.`, [...path, 'name'])
    }

    if (seen.has(actor.name)) {
      ctx.add(
        'duplicate_actor',
        `Actor "${actor.name}" is declared more than once in the schema.`,
        [...path, 'name'],
      )
    }
    seen.add(actor.name)

    validateAccountsOnActor(actor, [...path, 'accounts'], ctx)
  })
}

function validateAccountsOnActor(
  actor: ActorDef,
  path: readonly (string | number)[],
  ctx: ValidationCtx,
): void {
  const seenAccounts = new Set<string>()
  for (const accountName of Object.keys(actor.accounts)) {
    const acc: AccountDef = actor.accounts[accountName] as AccountDef
    const accPath = [...path, accountName]

    if (!isValidIdentifier(accountName)) {
      ctx.add(
        'invalid_actor_name',
        `Account name "${accountName}" on actor "${actor.name}" must match ${NAME_REGEX}.`,
        accPath,
      )
    }

    if (seenAccounts.has(accountName)) {
      ctx.add(
        'duplicate_account',
        `Account "${accountName}" declared more than once on actor "${actor.name}".`,
        accPath,
      )
    }
    seenAccounts.add(accountName)

    if (typeof acc.currency !== 'string' || acc.currency.length === 0) {
      ctx.add(
        'invalid_currency',
        `Account "${actor.name}.${accountName}" must declare a non-empty currency code.`,
        [...accPath, 'currency'],
      )
    }

    if (!Number.isInteger(acc.shards) || acc.shards < 1) {
      ctx.add(
        'invalid_shards',
        `Account "${actor.name}.${accountName}" shards must be an integer >= 1 (got ${acc.shards}).`,
        [...accPath, 'shards'],
      )
    }

    if (acc.parent !== undefined && !(acc.parent in actor.accounts)) {
      ctx.add(
        'invalid_account_parent',
        `Account "${actor.name}.${accountName}" parent "${acc.parent}" does not exist on actor "${actor.name}".`,
        [...accPath, 'parent'],
      )
    }
  }
}

function validateTransactions(schema: SchemaDef, ctx: ValidationCtx): void {
  const seen = new Set<string>()
  schema.transactions.forEach((txn, index) => {
    const path = ['transactions', index] as const

    if (!isValidIdentifier(txn.name)) {
      ctx.add('invalid_actor_name', `Transaction name "${txn.name}" must match ${NAME_REGEX}.`, [
        ...path,
        'name',
      ])
    }
    if (seen.has(txn.name)) {
      ctx.add('duplicate_transaction', `Transaction "${txn.name}" declared more than once.`, [
        ...path,
        'name',
      ])
    }
    seen.add(txn.name)

    validateTransactionStates(txn, [...path], ctx)
    validateTransactionParticipants(txn, schema, [...path, 'participants'], ctx)
    validateTransactionTransitions(txn, schema, [...path], ctx)
    validateReachability(txn, [...path], ctx)
  })
}

function validateTransactionStates(
  txn: TransactionDef,
  path: readonly (string | number)[],
  ctx: ValidationCtx,
): void {
  const stateSet = new Set<string>()
  txn.states.forEach((state, i) => {
    if (typeof state !== 'string' || state.length === 0) {
      ctx.add('invalid_state_name', `Empty state name in "${txn.name}".`, [...path, 'states', i])
      return
    }
    if (RESERVED_NAMES.has(state)) {
      ctx.add('reserved_name', `State "${state}" in transaction "${txn.name}" is reserved.`, [
        ...path,
        'states',
        i,
      ])
    }
    if (stateSet.has(state)) {
      ctx.add(
        'duplicate_state',
        `State "${state}" declared more than once in transaction "${txn.name}".`,
        [...path, 'states', i],
      )
    }
    stateSet.add(state)
  })

  if (!stateSet.has(txn.initial)) {
    ctx.add(
      'initial_not_in_states',
      `Initial state "${txn.initial}" of transaction "${txn.name}" is not declared in states.`,
      [...path, 'initial'],
    )
  }

  txn.terminal.forEach((t, i) => {
    if (!stateSet.has(t)) {
      ctx.add(
        'terminal_not_in_states',
        `Terminal state "${t}" of transaction "${txn.name}" is not declared in states.`,
        [...path, 'terminal', i],
      )
    }
  })

  if (txn.terminal.includes(txn.initial)) {
    ctx.add(
      'initial_in_terminal',
      `Initial state "${txn.initial}" of transaction "${txn.name}" cannot also be terminal.`,
      [...path, 'initial'],
    )
  }
}

function validateTransactionParticipants(
  txn: TransactionDef,
  schema: SchemaDef,
  path: readonly (string | number)[],
  ctx: ValidationCtx,
): void {
  for (const [pname, actor] of Object.entries(txn.participants)) {
    if (!schema.meta.actorsByName.has(actor.name)) {
      ctx.add(
        'unknown_actor',
        `Transaction "${txn.name}" participant "${pname}" references unknown actor "${actor.name}".`,
        [...path, pname],
      )
    }
  }
}

function validateTransactionTransitions(
  txn: TransactionDef,
  schema: SchemaDef,
  path: readonly (string | number)[],
  ctx: ValidationCtx,
): void {
  const stateSet = new Set(txn.states)
  const terminal = new Set(txn.terminal)

  // Collect every key name minted by any transition (for `needs` resolution).
  const allUnlocks = new Set<string>()
  for (const t of Object.values(txn.transitions)) {
    for (const k of t.unlocks) allUnlocks.add(k)
  }

  const seenNames = new Set<string>()

  for (const [transitionName, transition] of Object.entries(txn.transitions)) {
    const tpath = [...path, 'transitions', transitionName] as const

    if (!isValidIdentifier(transitionName)) {
      ctx.add(
        'invalid_actor_name',
        `Transition name "${transitionName}" must match ${NAME_REGEX}.`,
        [...tpath],
      )
    }
    if (seenNames.has(transitionName)) {
      ctx.add(
        'duplicate_transition',
        `Transition "${transitionName}" declared more than once on transaction "${txn.name}".`,
        [...tpath],
      )
    }
    seenNames.add(transitionName)

    validateTransitionStates(transition, txn.name, stateSet, terminal, [...tpath], ctx)
    validateTransitionActors(transition, schema, txn.name, [...tpath, 'by'], ctx)
    validateTransitionPostings(transition, txn, [...tpath, 'postings'], ctx)
    validateTransitionKeys(transition, allUnlocks, [...tpath], ctx)
  }
}

function validateTransitionStates(
  transition: TransitionDef,
  txnName: string,
  stateSet: ReadonlySet<string>,
  terminal: ReadonlySet<string>,
  path: readonly (string | number)[],
  ctx: ValidationCtx,
): void {
  for (const from of transition.from) {
    if (from === NONE_STATE) continue
    if (!stateSet.has(from)) {
      ctx.add(
        'unknown_state',
        `Transition "${transition.name}" on "${txnName}" has unknown from-state "${from}".`,
        [...path, 'from'],
      )
    }
    if (terminal.has(from)) {
      ctx.add(
        'transition_from_terminal',
        `Transition "${transition.name}" on "${txnName}" cannot fire from terminal state "${from}".`,
        [...path, 'from'],
      )
    }
  }

  if (!stateSet.has(transition.to)) {
    ctx.add(
      'unknown_state',
      `Transition "${transition.name}" on "${txnName}" has unknown to-state "${transition.to}".`,
      [...path, 'to'],
    )
  }
}

function validateTransitionActors(
  transition: TransitionDef,
  schema: SchemaDef,
  txnName: string,
  path: readonly (string | number)[],
  ctx: ValidationCtx,
): void {
  transition.by.forEach((actor, i) => {
    if (!schema.meta.actorsByName.has(actor.name)) {
      ctx.add(
        'unknown_actor',
        `Transition "${transition.name}" on "${txnName}" references unknown actor "${actor.name}".`,
        [...path, i],
      )
    }
  })
}

function validateTransitionPostings(
  transition: TransitionDef,
  txn: TransactionDef,
  path: readonly (string | number)[],
  ctx: ValidationCtx,
): void {
  const postings: PostingsSpec<Readonly<Record<string, ActorDef>>, unknown> | undefined =
    transition.postings
  if (postings === undefined) return

  if (typeof postings === 'string') {
    if (!isInvertRef(postings)) {
      ctx.add(
        'unknown_invert_target',
        `Transition "${transition.name}" postings string "${postings}" must be of form "invert:<transitionName>".`,
        path,
      )
      return
    }
    const targets = postings.slice('invert:'.length).split('|')
    for (const target of targets) {
      if (!(target in txn.transitions)) {
        ctx.add(
          'unknown_invert_target',
          `Transition "${transition.name}" inverts unknown transition "${target}" of "${txn.name}".`,
          path,
        )
      }
    }
  }
  // Function-form postings can't be statically validated for account refs;
  // the engine validates `sum(D) === sum(C)` and account membership at
  // runtime when the transition fires.
}

function isInvertRef(s: string): s is PostingsInvertRef {
  return s.startsWith('invert:') && s.length > 'invert:'.length
}

function validateTransitionKeys(
  transition: TransitionDef,
  allUnlocks: ReadonlySet<string>,
  path: readonly (string | number)[],
  ctx: ValidationCtx,
): void {
  if (transition.needs !== undefined && !allUnlocks.has(transition.needs)) {
    ctx.add(
      'unknown_needs_key',
      `Transition "${transition.name}" needs key "${transition.needs}" but no other transition unlocks it.`,
      [...path, 'needs'],
    )
  }

  const seen = new Set<string>()
  transition.unlocks.forEach((k, i) => {
    if (seen.has(k)) {
      ctx.add(
        'duplicate_state',
        `Transition "${transition.name}" unlocks key "${k}" more than once.`,
        [...path, 'unlocks', i],
      )
    }
    seen.add(k)
  })
}

/**
 * Reachability: every declared state must be reachable from `initial`,
 * possibly via transitions whose `from` includes the `<none>` sentinel
 * (record-creating transitions whose `to` seeds the lifecycle).
 */
function validateReachability(
  txn: TransactionDef,
  path: readonly (string | number)[],
  ctx: ValidationCtx,
): void {
  const stateSet = new Set(txn.states)
  const adjacency = new Map<string, Set<string>>()
  for (const s of stateSet) adjacency.set(s, new Set())

  // Roots: declared `initial` plus any state that is the `to` of a
  // record-creating (`<none>`) transition.
  const roots = new Set<string>([txn.initial])

  for (const t of Object.values(txn.transitions)) {
    if (!stateSet.has(t.to)) continue
    for (const from of t.from) {
      if (from === NONE_STATE) {
        roots.add(t.to)
        continue
      }
      if (!stateSet.has(from)) continue
      adjacency.get(from)?.add(t.to)
    }
  }

  const reached = new Set<string>()
  const queue: string[] = []
  for (const r of roots) {
    if (stateSet.has(r) && !reached.has(r)) {
      reached.add(r)
      queue.push(r)
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift() as string
    const neighbours = adjacency.get(cur)
    if (!neighbours) continue
    for (const next of neighbours) {
      if (!reached.has(next)) {
        reached.add(next)
        queue.push(next)
      }
    }
  }

  for (const state of stateSet) {
    if (!reached.has(state)) {
      ctx.add(
        'unreachable_state',
        `State "${state}" in transaction "${txn.name}" is not reachable from initial state "${txn.initial}".`,
        [...path, 'states'],
      )
    }
  }
}

function isValidIdentifier(name: string): boolean {
  return typeof name === 'string' && NAME_REGEX.test(name)
}
