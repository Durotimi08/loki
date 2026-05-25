/**
 * Append-only JSONL audit log — DASHBOARD.md §8.14, §9.6.
 *
 * Every security-relevant event the dashboard rejects (Host allowlist,
 * Sec-Fetch, smuggling guard, rate limit, CORS preflight) gets one
 * line. M3 adds auth events. M8 (actions) adds POST attempts.
 *
 * The file mode is `0600`; we refuse to open with a wider mode. We do
 * NOT also write audit rows to Postgres — the dashboard's read pool
 * physically can't write, and the action pool (M8) is for action
 * effects, not for dashboard self-observation. That line stays bright.
 */
import type { Stats } from 'node:fs'
import { appendFileSync, chmodSync, openSync, closeSync, statSync } from 'node:fs'
import { LokiError } from '@loki/core'

export type AuditEntryInput = {
  readonly reqId: string
  readonly event: string
  readonly sourceIp?: string
  readonly subject?: string
  readonly detail?: Record<string, unknown>
}

export type AuditEntry = AuditEntryInput & { readonly ts: string }

export type AuditLog = {
  /** Append one entry. Fire-and-forget; failures throw synchronously. */
  append: (entry: AuditEntryInput) => void
  /** Release any file handle. Idempotent. */
  close: () => Promise<void>
}

export type CreateAuditLogOptions = {
  /** Override `Date.now`-shaped clock for tests. */
  readonly now?: () => Date
  /** Skip the mode-0600 check (used when first creating the file). */
  readonly skipModeCheck?: boolean
}

/**
 * Open (or create) an audit log at the given path. Refuses paths whose
 * existing mode is more permissive than `0600` on POSIX — those are
 * almost certainly the wrong file. On creation we `chmod 0600`.
 */
export function createAuditLog(path: string, opts: CreateAuditLogOptions = {}): AuditLog {
  const now = opts.now ?? (() => new Date())
  let stat: Stats | null = null
  try {
    stat = statSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (stat !== null && process.platform !== 'win32' && !opts.skipModeCheck) {
    const mode = stat.mode & 0o777
    if (mode > 0o600) {
      throw new LokiError(
        `dashboard: refusing to open audit log at ${path} — mode 0${mode.toString(8)} > 0600. ` +
          `Run: chmod 0600 ${path}`,
      )
    }
  }
  if (stat === null) {
    // Create with mode 0600 atomically.
    const fd = openSync(path, 'a', 0o600)
    closeSync(fd)
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  }

  return {
    append: (entry: AuditEntryInput) => {
      const full: AuditEntry = { ts: now().toISOString(), ...entry }
      appendFileSync(path, `${JSON.stringify(full)}\n`, { mode: 0o600 })
    },
    close: async () => {
      // appendFileSync opens-and-closes per call — nothing to release.
    },
  }
}

/**
 * In-memory audit log for tests. Returns an `entries()` helper alongside
 * the standard `AuditLog` surface.
 */
export function createMemoryAuditLog(now: () => Date = () => new Date()): AuditLog & {
  entries: () => readonly AuditEntry[]
} {
  const buf: AuditEntry[] = []
  return {
    append: (entry) => {
      buf.push({ ts: now().toISOString(), ...entry })
    },
    entries: () => buf,
    close: async () => {},
  }
}

/** No-op log — used when audit is disabled. */
export const NOOP_AUDIT_LOG: AuditLog = {
  append: () => {},
  close: async () => {},
}
