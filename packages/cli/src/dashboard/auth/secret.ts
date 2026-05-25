/**
 * HMAC secret loader for the dashboard's signed-cookie sessions —
 * DASHBOARD.md §8.5 / T34.
 *
 * Resolution order:
 *   1. env LOKI_DASHBOARD_SECRET  — preferred, ops-friendly
 *   2. file ~/.loki/dashboard-secret (mode 0600, owned by us)
 *   3. generate + persist with mode 0600
 *
 * `--ephemeral` skips persistence: the secret lives only in memory and
 * every restart invalidates outstanding sessions.
 *
 * Refusal modes:
 *   - existing file with mode > 0600 (POSIX) → throw
 *   - existing file owned by a different uid (POSIX) → throw
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { LokiError } from '@loki/core'

/** Secret bytes used to sign session cookies + CSRF tokens. */
export type Secret = Uint8Array

export type LoadSecretOptions = {
  /** Force an in-memory secret — no file I/O. */
  readonly ephemeral?: boolean
  /** Override the file path (tests). */
  readonly path?: string
  /** Override the env var lookup (tests). */
  readonly fromEnv?: string | undefined
}

const DEFAULT_PATH = join(homedir(), '.loki', 'dashboard-secret')

export function loadSessionSecret(opts: LoadSecretOptions = {}): Secret {
  if (opts.ephemeral) return randomBytes(32)

  const fromEnv = opts.fromEnv ?? process.env['LOKI_DASHBOARD_SECRET']
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return Buffer.from(fromEnv, fromEnv.length === 64 ? 'hex' : 'utf8')
  }

  const path = opts.path ?? DEFAULT_PATH
  if (existsSync(path)) {
    assertSafeMode(path)
    const raw = readFileSync(path, 'utf8').trim()
    if (raw.length === 0) {
      throw new LokiError(`dashboard: ${path} is empty — delete it or set LOKI_DASHBOARD_SECRET.`)
    }
    return Buffer.from(raw, raw.length === 64 ? 'hex' : 'utf8')
  }

  // Generate + persist.
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const bytes = randomBytes(32)
  writeFileSync(path, bytes.toString('hex'), { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  return bytes
}

function assertSafeMode(path: string): void {
  if (process.platform === 'win32') return
  const st = statSync(path)
  const mode = st.mode & 0o777
  if (mode > 0o600) {
    throw new LokiError(
      `dashboard: refusing to read ${path} — mode 0${mode.toString(8)} > 0600. ` +
        `Run: chmod 0600 ${path}`,
    )
  }
  if (st.uid !== process.getuid?.()) {
    throw new LokiError(
      `dashboard: refusing to read ${path} — owned by uid ${st.uid}, we run as uid ${process.getuid?.()}.`,
    )
  }
}
