import type { ActorDef, SchemaDef, TransactionDef, TransitionDef } from './types.js'

/**
 * Per-§14.2 change classification: each diff entry is tagged with the
 * cost class so consumers (and the migration CLI) know which changes
 * are free, which need an alias map, which retroactively tighten an
 * invariant, and which orphan live records.
 */

export type ChangeKind = 'additive' | 'rename' | 'restrictive' | 'destructive'

export type SchemaChange =
  | { readonly kind: 'additive'; readonly subject: string; readonly description: string }
  | {
      readonly kind: 'rename'
      readonly subject: string
      readonly from: string
      readonly to: string
      readonly description: string
    }
  | { readonly kind: 'restrictive'; readonly subject: string; readonly description: string }
  | { readonly kind: 'destructive'; readonly subject: string; readonly description: string }

export type SchemaDiff = {
  readonly fromVersion: number
  readonly toVersion: number
  readonly changes: readonly SchemaChange[]
  readonly counts: Readonly<Record<ChangeKind, number>>
}

/**
 * Compare two schemas and classify each difference.
 *
 * The classifier is structural — it looks at names, states, payload
 * presence, account currencies, etc. Renames are detected when an
 * explicit alias maps an old name to a new one in `to.aliases`; without
 * that map, removed names look destructive and added ones look
 * additive (which is the safe default — destructive is loud).
 */
export function diffSchemas(from: SchemaDef, to: SchemaDef): SchemaDiff {
  const changes: SchemaChange[] = []
  const aliases = to.aliases[from.version] ?? {}

  // ---- Actors ----
  const oldActors = new Map(from.actors.map((a) => [a.name, a]))
  const newActors = new Map(to.actors.map((a) => [a.name, a]))
  const actorAliasFwd = aliases.actors ?? {}
  const actorAliasRev = invert(actorAliasFwd)

  for (const [oldName, oldActor] of oldActors) {
    const renamed = actorAliasFwd[oldName]
    if (renamed && newActors.has(renamed)) {
      changes.push({
        kind: 'rename',
        subject: 'actor',
        from: oldName,
        to: renamed,
        description: `actor "${oldName}" renamed to "${renamed}"`,
      })
      diffActor(
        oldActor,
        newActors.get(renamed) as ActorDef,
        aliases.accounts?.[oldName] ?? {},
        changes,
      )
    } else if (newActors.has(oldName)) {
      diffActor(
        oldActor,
        newActors.get(oldName) as ActorDef,
        aliases.accounts?.[oldName] ?? {},
        changes,
      )
    } else {
      changes.push({
        kind: 'destructive',
        subject: 'actor',
        description: `actor "${oldName}" removed`,
      })
    }
  }
  for (const [newName] of newActors) {
    if (oldActors.has(newName)) continue
    if (actorAliasRev[newName]) continue // counted as rename above
    changes.push({
      kind: 'additive',
      subject: 'actor',
      description: `actor "${newName}" added`,
    })
  }

  // ---- Transactions / states / transitions ----
  const oldTxns = new Map(from.transactions.map((t) => [t.name, t]))
  const newTxns = new Map(to.transactions.map((t) => [t.name, t]))

  for (const [oldName, oldTxn] of oldTxns) {
    const newTxn = newTxns.get(oldName)
    if (!newTxn) {
      changes.push({
        kind: 'destructive',
        subject: 'transaction',
        description: `transaction "${oldName}" removed`,
      })
      continue
    }
    diffTxn(oldTxn, newTxn, aliases, changes)
  }
  for (const [newName] of newTxns) {
    if (!oldTxns.has(newName)) {
      changes.push({
        kind: 'additive',
        subject: 'transaction',
        description: `transaction "${newName}" added`,
      })
    }
  }

  const counts = {
    additive: changes.filter((c) => c.kind === 'additive').length,
    rename: changes.filter((c) => c.kind === 'rename').length,
    restrictive: changes.filter((c) => c.kind === 'restrictive').length,
    destructive: changes.filter((c) => c.kind === 'destructive').length,
  }
  return {
    fromVersion: from.version,
    toVersion: to.version,
    changes,
    counts,
  }
}

function diffActor(
  oldActor: ActorDef,
  newActor: ActorDef,
  accountAliasFwd: Readonly<Record<string, string>>,
  changes: SchemaChange[],
): void {
  const oldAccounts = new Map(Object.entries(oldActor.accounts))
  const newAccounts = new Map(Object.entries(newActor.accounts))
  const accountAliasRev = invert(accountAliasFwd)

  for (const [oldName, oldAcc] of oldAccounts) {
    const renamed = accountAliasFwd[oldName]
    const newAccTarget = renamed && newAccounts.has(renamed)
    if (newAccTarget) {
      changes.push({
        kind: 'rename',
        subject: `account ${newActor.name}`,
        from: oldName,
        to: renamed as string,
        description: `account "${oldActor.name}.${oldName}" renamed to "${newActor.name}.${renamed}"`,
      })
      compareAccount(newActor.name, oldAcc, newAccounts.get(renamed as string), changes)
    } else if (newAccounts.has(oldName)) {
      compareAccount(newActor.name, oldAcc, newAccounts.get(oldName), changes)
    } else {
      changes.push({
        kind: 'destructive',
        subject: `account ${newActor.name}`,
        description: `account "${oldActor.name}.${oldName}" removed`,
      })
    }
  }
  for (const [newName] of newAccounts) {
    if (oldAccounts.has(newName)) continue
    if (accountAliasRev[newName]) continue
    changes.push({
      kind: 'additive',
      subject: `account ${newActor.name}`,
      description: `account "${newActor.name}.${newName}" added`,
    })
  }
}

function compareAccount(
  actorName: string,
  oldAcc: { currency: string; shards: number } | undefined,
  newAcc: { currency: string; shards: number } | undefined,
  changes: SchemaChange[],
): void {
  if (!oldAcc || !newAcc) return
  if (oldAcc.currency !== newAcc.currency) {
    changes.push({
      kind: 'destructive',
      subject: `account ${actorName}`,
      description: `account currency changed from ${oldAcc.currency} to ${newAcc.currency} — orphans existing rows`,
    })
  }
  if (oldAcc.shards !== newAcc.shards) {
    // Adding shards is additive; reducing would break existing rows.
    const direction = newAcc.shards > oldAcc.shards ? 'additive' : 'destructive'
    changes.push({
      kind: direction,
      subject: `account ${actorName}`,
      description: `shard count ${oldAcc.shards} → ${newAcc.shards}`,
    })
  }
}

function diffTxn(
  oldTxn: TransactionDef,
  newTxn: TransactionDef,
  aliases: {
    transitions?: Readonly<Record<string, string>>
    states?: Readonly<Record<string, Readonly<Record<string, string>>>>
  },
  changes: SchemaChange[],
): void {
  // States.
  const oldStates = new Set(oldTxn.states)
  const newStates = new Set(newTxn.states)
  const stateAliasFwd = aliases.states?.[oldTxn.name] ?? {}
  const stateAliasRev = invert(stateAliasFwd)
  for (const s of oldStates) {
    const renamed = stateAliasFwd[s]
    if (renamed && newStates.has(renamed)) {
      changes.push({
        kind: 'rename',
        subject: `state ${newTxn.name}`,
        from: s,
        to: renamed,
        description: `state "${oldTxn.name}.${s}" renamed to "${newTxn.name}.${renamed}"`,
      })
    } else if (!newStates.has(s)) {
      changes.push({
        kind: 'destructive',
        subject: `state ${newTxn.name}`,
        description: `state "${oldTxn.name}.${s}" removed`,
      })
    }
  }
  for (const s of newStates) {
    if (oldStates.has(s)) continue
    if (stateAliasRev[s]) continue
    changes.push({
      kind: 'additive',
      subject: `state ${newTxn.name}`,
      description: `state "${newTxn.name}.${s}" added`,
    })
  }

  // Transitions.
  const oldTrans = new Map(Object.entries(oldTxn.transitions))
  const newTrans = new Map(Object.entries(newTxn.transitions))
  const transAliasFwd = aliases.transitions ?? {}
  const transAliasRev = invert(transAliasFwd)

  for (const [oldName, oldT] of oldTrans) {
    const renamed = transAliasFwd[oldName]
    if (renamed && newTrans.has(renamed)) {
      changes.push({
        kind: 'rename',
        subject: `transition ${newTxn.name}`,
        from: oldName,
        to: renamed,
        description: `transition "${oldTxn.name}.${oldName}" renamed to "${newTxn.name}.${renamed}"`,
      })
      compareTransition(
        newTxn.name,
        oldName,
        oldT as TransitionDef,
        newTrans.get(renamed) as TransitionDef,
        changes,
      )
    } else if (newTrans.has(oldName)) {
      compareTransition(
        newTxn.name,
        oldName,
        oldT as TransitionDef,
        newTrans.get(oldName) as TransitionDef,
        changes,
      )
    } else {
      changes.push({
        kind: 'destructive',
        subject: `transition ${newTxn.name}`,
        description: `transition "${oldTxn.name}.${oldName}" removed`,
      })
    }
  }
  for (const [newName] of newTrans) {
    if (oldTrans.has(newName)) continue
    if (transAliasRev[newName]) continue
    changes.push({
      kind: 'additive',
      subject: `transition ${newTxn.name}`,
      description: `transition "${newTxn.name}.${newName}" added`,
    })
  }
}

function compareTransition(
  txnName: string,
  name: string,
  oldT: TransitionDef,
  newT: TransitionDef,
  changes: SchemaChange[],
): void {
  // Narrowing the actor union (fewer permitted actors) is restrictive.
  const oldBy = new Set(oldT.by.map((a) => a.name))
  const newBy = new Set(newT.by.map((a) => a.name))
  for (const a of oldBy) {
    if (!newBy.has(a)) {
      changes.push({
        kind: 'restrictive',
        subject: `transition ${txnName}.${name}`,
        description: `actor "${a}" no longer permitted`,
      })
    }
  }
  for (const a of newBy) {
    if (!oldBy.has(a)) {
      changes.push({
        kind: 'additive',
        subject: `transition ${txnName}.${name}`,
        description: `actor "${a}" newly permitted`,
      })
    }
  }
  if (oldT.payload && !newT.payload) {
    changes.push({
      kind: 'destructive',
      subject: `transition ${txnName}.${name}`,
      description: 'payload schema removed',
    })
  } else if (!oldT.payload && newT.payload) {
    changes.push({
      kind: 'restrictive',
      subject: `transition ${txnName}.${name}`,
      description: 'payload schema newly required',
    })
  }
  if ((oldT.invariant && !newT.invariant) === false && !oldT.invariant && newT.invariant) {
    changes.push({
      kind: 'restrictive',
      subject: `transition ${txnName}.${name}`,
      description: 'invariant added',
    })
  }
}

function invert(map: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) out[v] = k
  return out
}
