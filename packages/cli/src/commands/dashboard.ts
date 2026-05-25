/**
 * `loki dashboard` — boot the read-only HTTP dashboard.
 *
 * See DASHBOARD.md for the full design. Subsequent milestones layer
 * data routes (M4+) and actions (M8) on top of this entry point
 * without changing the command name or flag shape.
 */
import { execFileSync, spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { consoleLogger } from '@loki/core'
import type { LokiConfig } from '../config.js'
import type { Io } from '../io.js'
import type { AuthScheme } from '../dashboard/auth/index.js'
import { startDashboardServer } from '../dashboard/server.js'

export type DashboardOptions = {
  readonly host?: string
  readonly port?: number
  readonly readUrl?: string
  readonly allowProd?: boolean
  readonly unsafeHost?: boolean
  readonly statementTimeoutMs?: number
  readonly poolMax?: number
  readonly auth?: AuthScheme
  readonly allowedHosts?: readonly string[]
  readonly trustProxyTls?: boolean
  readonly trustProxyHops?: number
  readonly open?: boolean
}

export async function runDashboard(
  config: LokiConfig,
  opts: DashboardOptions,
  io: Io,
): Promise<number> {
  const logLevel = process.env['LOKI_LOG_LEVEL']
  const logger = consoleLogger({
    level: (logLevel === 'debug' || logLevel === 'info' || logLevel === 'warn' || logLevel === 'error')
      ? logLevel
      : 'info',
  })

  const server = await startDashboardServer(config, config.schema, {
    buildHash: resolveBuildHash(),
    logger,
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.readUrl !== undefined ? { readUrl: opts.readUrl } : {}),
    ...(opts.statementTimeoutMs !== undefined ? { statementTimeoutMs: opts.statementTimeoutMs } : {}),
    ...(opts.poolMax !== undefined ? { poolMax: opts.poolMax } : {}),
    ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
    ...(opts.allowedHosts !== undefined ? { allowedHosts: opts.allowedHosts } : {}),
    ...(opts.trustProxyTls !== undefined ? { trustProxyTls: opts.trustProxyTls } : {}),
    ...(opts.trustProxyHops !== undefined ? { trustProxyHops: opts.trustProxyHops } : {}),
    allowProd: opts.allowProd ?? false,
    unsafeHost: opts.unsafeHost ?? false,
  })

  const url = `http://${server.address}`
  io.out(`loki dashboard listening on ${url}`)
  io.out(`  health  → ${url}/api/v1/health`)
  io.out(`  version → ${url}/api/v1/version`)

  if (opts.open === true) {
    try {
      openInBrowser(url)
      io.out(`  → opened ${url} in your default browser`)
    } catch (e) {
      io.err(`  → could not open browser: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Wait for SIGTERM / SIGINT. We install our own handlers so the
  // shutdown sequence is observable and the engine's pool releases
  // cleanly.
  await waitForShutdown(io)
  io.out('loki dashboard: shutting down…')
  await server.close()
  return 0
}

export function parseDashboardArgs(args: readonly string[]): DashboardOptions | { error: string } {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        'read-url': { type: 'string' },
        'allow-prod': { type: 'boolean' },
        'unsafe-host': { type: 'boolean' },
        'trust-proxy-tls': { type: 'boolean' },
        'trust-proxy-hops': { type: 'string' },
        'statement-timeout-ms': { type: 'string' },
        'pool-max': { type: 'string' },
        auth: { type: 'string' },
        'allowed-host': { type: 'string', multiple: true },
        open: { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }

  const host = stringValue(parsed.values['host'])
  const portRaw = stringValue(parsed.values['port'])
  const readUrl = stringValue(parsed.values['read-url'])
  const stmtRaw = stringValue(parsed.values['statement-timeout-ms'])
  const maxRaw = stringValue(parsed.values['pool-max'])
  const hopsRaw = stringValue(parsed.values['trust-proxy-hops'])
  const authRaw = stringValue(parsed.values['auth'])
  const allowProd = parsed.values['allow-prod'] === true
  const unsafeHost = parsed.values['unsafe-host'] === true
  const trustProxyTls = parsed.values['trust-proxy-tls'] === true
  const open = parsed.values['open'] === true
  const allowedHosts = stringArray(parsed.values['allowed-host'])

  const port = portRaw !== undefined ? Number(portRaw) : undefined
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    return { error: `dashboard: --port must be an integer in 1..65535 (got ${portRaw}).` }
  }
  const statementTimeoutMs = stmtRaw !== undefined ? Number(stmtRaw) : undefined
  if (statementTimeoutMs !== undefined && (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 100)) {
    return { error: 'dashboard: --statement-timeout-ms must be an integer ≥ 100.' }
  }
  const poolMax = maxRaw !== undefined ? Number(maxRaw) : undefined
  if (poolMax !== undefined && (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 64)) {
    return { error: 'dashboard: --pool-max must be an integer in 1..64.' }
  }
  const trustProxyHops = hopsRaw !== undefined ? Number(hopsRaw) : undefined
  if (trustProxyHops !== undefined && (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 8)) {
    return { error: 'dashboard: --trust-proxy-hops must be an integer 0..8.' }
  }

  let auth: AuthScheme | undefined
  if (authRaw !== undefined) {
    const parsedAuth = parseAuthArg(authRaw)
    if ('error' in parsedAuth) return { error: parsedAuth.error }
    auth = parsedAuth
  }

  return {
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(readUrl !== undefined ? { readUrl } : {}),
    ...(allowProd ? { allowProd: true } : {}),
    ...(unsafeHost ? { unsafeHost: true } : {}),
    ...(trustProxyTls ? { trustProxyTls: true } : {}),
    ...(trustProxyHops !== undefined ? { trustProxyHops } : {}),
    ...(statementTimeoutMs !== undefined ? { statementTimeoutMs } : {}),
    ...(poolMax !== undefined ? { poolMax } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    ...(open ? { open: true } : {}),
  }
}

/**
 * Parse `--auth <scheme>:<…>`.
 *   `--auth none`
 *   `--auth bearer:<token>`         token ≥ 32 chars
 *   `--auth basic:<user>:<hash>`    hash is full encoded argon2id
 *
 * `<user>` may not contain ':'. The argon2 hash always starts with
 * `$argon2id$v=19$` so we split on the first `:` not inside that prefix.
 */
function parseAuthArg(raw: string): AuthScheme | { error: string } {
  if (raw === 'none') return { kind: 'none' }
  if (raw.startsWith('bearer:')) {
    const token = raw.slice('bearer:'.length)
    if (token.length < 32) {
      return { error: 'dashboard: --auth bearer:<token> token must be ≥ 32 chars.' }
    }
    return { kind: 'bearer', token }
  }
  if (raw.startsWith('basic:')) {
    const rest = raw.slice('basic:'.length)
    const sep = rest.indexOf(':')
    if (sep <= 0) {
      return { error: 'dashboard: --auth basic:<user>:<argon2-hash> requires both user and hash.' }
    }
    const user = rest.slice(0, sep)
    const argon2Hash = rest.slice(sep + 1)
    if (!argon2Hash.startsWith('$argon2id$v=19$')) {
      return { error: 'dashboard: --auth basic:<user>:<hash> hash must be argon2id v=19.' }
    }
    return { kind: 'basic', user, argon2Hash }
  }
  return { error: `dashboard: --auth must be one of none | bearer:<token> | basic:<user>:<hash> (got ${raw}).` }
}

/**
 * `parseArgs` returns `string | boolean | (string | boolean)[]` for
 * each value because it can't statically know which `options` we
 * passed. The dashboard's flags are all `{ type: 'string' }` and
 * non-`multiple`, so we narrow at the boundary.
 */
function stringValue(v: string | boolean | (string | boolean)[] | undefined): string | undefined {
  if (typeof v === 'string') return v
  return undefined
}

function stringArray(v: string | boolean | (string | boolean)[] | undefined): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

/**
 * Resolve the build hash to surface on `/api/v1/version`:
 *   1. `LOKI_DASHBOARD_BUILD_HASH` env var (operator's CI sets this)
 *   2. `git rev-parse --short HEAD` from the working tree (dev convenience)
 *   3. `'dev'` fallback
 *
 * Lives in the CLI command (not under `dashboard/`) because the
 * dashboard subtree's lint forbids `child_process`. The dashboard
 * subtree never spawns processes.
 */
function resolveBuildHash(): string {
  const fromEnv = process.env['LOKI_DASHBOARD_BUILD_HASH']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    }).toString('utf8').trim()
    if (out.length > 0) return `git:${out}`
  } catch {
    /* not a git repo, or git missing — fall through */
  }
  return 'dev'
}

/**
 * Open `url` in the OS default browser. Cross-platform via
 * `open` (macOS), `xdg-open` (Linux), `cmd /c start` (Windows). The
 * child is detached + unrefed so closing the dashboard doesn't kill it.
 */
function openInBrowser(url: string): void {
  const platform = process.platform
  const cmd =
    platform === 'darwin' ? 'open' :
    platform === 'win32' ? 'cmd' :
    'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url]
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

function waitForShutdown(io: Io): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false
    const stop = (sig: NodeJS.Signals): void => {
      if (resolved) return
      resolved = true
      io.out(`loki dashboard: received ${sig}`)
      resolve()
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  })
}
