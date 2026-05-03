import { parseArgs } from 'node:util'
import { runAnomalies } from './commands/anomalies.js'
import { runMigrate, runMigrateEnforce } from './commands/migrate.js'
import { runReconcile } from './commands/reconcile.js'
import { runSchema } from './commands/schema.js'
import { runTenant } from './commands/tenant.js'
import { runTrace } from './commands/trace.js'
import { type LokiConfig, loadConfig } from './config.js'
import { type Io, stdIo } from './io.js'

export type RunnerOptions = {
  readonly args: readonly string[]
  readonly io?: Io
  /** Override config loading (used by integration tests). */
  readonly config?: LokiConfig
  readonly cwd?: string
}

const HELP = `loki — Loki database CLI

Usage:
  loki <command> [args] [--config <path>]

Commands:
  migrate apply               Apply pending migrations
  migrate plan                Print up/down SQL for every migration
  migrate rollback            Roll back the most recent migration
  migrate status              Show applied vs pending migrations
  migrate enforce <name>      Find records violating a new invariant
                              (uses enforcers[<name>] from loki.config)
                              [--tenant <id>] [--limit N]

  reconcile [--tenant <id>]   Run a single reconciliation pass
                              (exit 1 if any anomalies are detected)
                              [--no-quarantine] to skip auto-quarantine

  tenant create <id> --name <name>
  tenant list
  tenant get <id>
  tenant suspend <id>
  tenant activate <id>
  tenant delete <id>
  tenant dashboard <id>       Per-tenant rollup: counts, anomalies, schema versions

  schema versions [--tenant <id>]
  schema diff --from <config-path>

  anomalies list --tenant <id> [--severity warn|error|critical]
                                [--check <name>] [--unresolved] [--limit N]
  anomalies resolve <id> --tenant <id> --by <name> --note <text>

  trace <txnId> --tenant <id> [--verify]
                              Print the full transition trail for a record;
                              --verify recomputes the hash chain.

Global flags:
  --config <path>             Path to a loki.config.{js,mjs,ts} module
                              (default: auto-discover in cwd)
  --help, -h                  Show this help

Exit codes:
  0  success
  1  command-level failure (anomalies detected, missing tenant, …)
  2  invalid usage
`

export async function run(options: RunnerOptions): Promise<number> {
  const io = options.io ?? stdIo
  const args = [...options.args]

  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    io.out(HELP)
    return args.length === 0 ? 2 : 0
  }

  // Pull `--config` out of the arg stream once; commands don't need it.
  const { configPath, rest } = extractConfig(args)

  const command = rest.shift()
  try {
    const config =
      options.config ??
      (await loadConfig({
        ...(configPath !== undefined ? { path: configPath } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      }))

    switch (command) {
      case 'migrate':
        return await runMigrateCommand(config, rest, io)
      case 'reconcile':
        return await runReconcileCommand(config, rest, io)
      case 'tenant':
        return await runTenantCommand(config, rest, io)
      case 'schema':
        return await runSchemaCommand(config, rest, io)
      case 'anomalies':
        return await runAnomaliesCommand(config, rest, io)
      case 'trace':
        return await runTraceCommand(config, rest, io)
      default:
        io.err(`Unknown command: ${command ?? '<missing>'}`)
        io.err(HELP)
        return 2
    }
  } catch (e) {
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

function extractConfig(args: string[]): { configPath?: string; rest: string[] } {
  const rest: string[] = []
  let configPath: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if (a === '--config') {
      configPath = args[i + 1]
      i++
    } else if (a.startsWith('--config=')) {
      configPath = a.slice('--config='.length)
    } else {
      rest.push(a)
    }
  }
  return configPath !== undefined ? { configPath, rest } : { rest }
}

async function runMigrateCommand(
  config: LokiConfig,
  args: readonly string[],
  io: Io,
): Promise<number> {
  const sub = args[0]
  if (sub === 'enforce') {
    const rest = args.slice(1)
    const parsed = parseArgs({
      args: [...rest],
      options: {
        tenant: { type: 'string' },
        limit: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    const enforcerName = parsed.positionals[0]
    if (!enforcerName) {
      io.err('migrate enforce: usage: migrate enforce <enforcer-name> [--tenant <id>] [--limit N]')
      return 2
    }
    const limit = parsed.values.limit ? Number(parsed.values.limit) : undefined
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      io.err('migrate enforce: --limit must be a positive integer.')
      return 2
    }
    return runMigrateEnforce(
      config,
      {
        enforcerName,
        ...(parsed.values.tenant ? { tenant: parsed.values.tenant } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
      io,
    )
  }
  if (!sub || !['apply', 'plan', 'rollback', 'status'].includes(sub)) {
    io.err(
      `migrate: expected one of apply | plan | rollback | status | enforce, got "${sub ?? '<missing>'}".`,
    )
    return 2
  }
  return runMigrate(config, sub as 'apply' | 'plan' | 'rollback' | 'status', io)
}

async function runReconcileCommand(
  config: LokiConfig,
  args: readonly string[],
  io: Io,
): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      tenant: { type: 'string' },
      'no-quarantine': { type: 'boolean' },
    },
    allowPositionals: false,
    strict: true,
  })
  return runReconcile(
    config,
    {
      ...(parsed.values.tenant !== undefined ? { tenant: parsed.values.tenant } : {}),
      ...(parsed.values['no-quarantine'] === true ? { quarantine: false } : {}),
    },
    io,
  )
}

async function runTenantCommand(
  config: LokiConfig,
  args: readonly string[],
  io: Io,
): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case 'create': {
      const parsed = parseArgs({
        args: [...rest],
        options: { name: { type: 'string' } },
        allowPositionals: true,
        strict: true,
      })
      const id = parsed.positionals[0]
      const name = parsed.values.name
      if (!id || !name) {
        io.err('tenant create: usage: tenant create <id> --name <name>')
        return 2
      }
      return runTenant(config, { kind: 'create', id, name }, io)
    }
    case 'list':
      return runTenant(config, { kind: 'list' }, io)
    case 'get':
    case 'suspend':
    case 'activate':
    case 'delete':
    case 'dashboard': {
      const id = rest[0]
      if (!id) {
        io.err(`tenant ${sub}: usage: tenant ${sub} <id>`)
        return 2
      }
      return runTenant(config, { kind: sub, id }, io)
    }
    default:
      io.err(`tenant: unknown subcommand "${sub ?? '<missing>'}".`)
      return 2
  }
}

async function runSchemaCommand(
  config: LokiConfig,
  args: readonly string[],
  io: Io,
): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case 'versions': {
      const parsed = parseArgs({
        args: [...rest],
        options: { tenant: { type: 'string' } },
        allowPositionals: false,
        strict: true,
      })
      return runSchema(
        config,
        {
          kind: 'versions',
          ...(parsed.values.tenant !== undefined ? { tenant: parsed.values.tenant } : {}),
        },
        io,
      )
    }
    case 'diff': {
      const parsed = parseArgs({
        args: [...rest],
        options: { from: { type: 'string' } },
        allowPositionals: false,
        strict: true,
      })
      const from = parsed.values.from
      if (!from) {
        io.err('schema diff: usage: schema diff --from <config-path>')
        return 2
      }
      return runSchema(config, { kind: 'diff', fromConfig: from }, io)
    }
    default:
      io.err(`schema: unknown subcommand "${sub ?? '<missing>'}".`)
      return 2
  }
}

async function runAnomaliesCommand(
  config: LokiConfig,
  args: readonly string[],
  io: Io,
): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case 'list': {
      const parsed = parseArgs({
        args: [...rest],
        options: {
          tenant: { type: 'string' },
          severity: { type: 'string' },
          check: { type: 'string' },
          unresolved: { type: 'boolean' },
          limit: { type: 'string' },
        },
        allowPositionals: false,
        strict: true,
      })
      const sev = parsed.values.severity
      if (sev !== undefined && sev !== 'warn' && sev !== 'error' && sev !== 'critical') {
        io.err(`anomalies list: --severity must be one of warn|error|critical (got "${sev}").`)
        return 2
      }
      const limit = parsed.values.limit ? Number(parsed.values.limit) : undefined
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        io.err('anomalies list: --limit must be a positive integer.')
        return 2
      }
      return runAnomalies(
        config,
        {
          kind: 'list',
          ...(parsed.values.tenant !== undefined ? { tenant: parsed.values.tenant } : {}),
          ...(sev !== undefined ? { severity: sev as 'warn' | 'error' | 'critical' } : {}),
          ...(parsed.values.check !== undefined ? { check: parsed.values.check } : {}),
          ...(parsed.values.unresolved === true ? { unresolvedOnly: true } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
        io,
      )
    }
    case 'resolve': {
      const parsed = parseArgs({
        args: [...rest],
        options: {
          tenant: { type: 'string' },
          by: { type: 'string' },
          note: { type: 'string' },
        },
        allowPositionals: true,
        strict: true,
      })
      const id = parsed.positionals[0]
      const tenant = parsed.values.tenant
      const by = parsed.values.by
      const note = parsed.values.note
      if (!id || !tenant || !by || !note) {
        io.err(
          'anomalies resolve: usage: anomalies resolve <id> --tenant <id> --by <name> --note <text>',
        )
        return 2
      }
      return runAnomalies(config, { kind: 'resolve', id, tenant, by, note }, io)
    }
    default:
      io.err(`anomalies: unknown subcommand "${sub ?? '<missing>'}".`)
      return 2
  }
}

async function runTraceCommand(
  config: LokiConfig,
  args: readonly string[],
  io: Io,
): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      tenant: { type: 'string' },
      verify: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const txnId = parsed.positionals[0]
  const tenant = parsed.values.tenant
  if (!txnId || !tenant) {
    io.err('trace: usage: trace <txnId> --tenant <id> [--verify]')
    return 2
  }
  return runTrace(
    config,
    {
      kind: parsed.values.verify === true ? 'verify' : 'show',
      tenant,
      txnId,
    },
    io,
  )
}
