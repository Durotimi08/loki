/**
 * One validation problem detected on a schema. Multiple issues can be
 * reported per `validateSchema` call so users see everything at once.
 */
export type SchemaIssueCode =
  | 'duplicate_actor'
  | 'duplicate_account'
  | 'duplicate_transaction'
  | 'duplicate_transition'
  | 'duplicate_state'
  | 'duplicate_emit'
  | 'unknown_state'
  | 'unknown_actor'
  | 'unknown_participant'
  | 'unknown_invert_target'
  | 'unknown_unlocks_key'
  | 'unknown_needs_key'
  | 'initial_in_terminal'
  | 'initial_not_in_states'
  | 'terminal_not_in_states'
  | 'unreachable_state'
  | 'transition_from_terminal'
  | 'invalid_shards'
  | 'invalid_currency'
  | 'invalid_account_parent'
  | 'invalid_state_name'
  | 'invalid_actor_name'
  | 'reserved_name'

export type SchemaIssue = {
  readonly code: SchemaIssueCode
  readonly message: string
  readonly path: readonly (string | number)[]
}

export class SchemaError extends Error {
  readonly issues: readonly SchemaIssue[]

  constructor(issues: readonly SchemaIssue[]) {
    const summary = issues
      .slice(0, 5)
      .map((i) => ` • [${i.code}] ${pathToString(i.path)}: ${i.message}`)
      .join('\n')
    const more = issues.length > 5 ? `\n … and ${issues.length - 5} more.` : ''
    super(
      `Loki schema validation failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n${summary}${more}`,
    )
    this.name = 'SchemaError'
    this.issues = issues
  }
}

function pathToString(path: readonly (string | number)[]): string {
  if (path.length === 0) return '<root>'
  return path
    .map((seg, i) => {
      if (typeof seg === 'number') return `[${seg}]`
      return i === 0 ? seg : `.${seg}`
    })
    .join('')
}
