/**
 * Boot-time bind-policy refusal matrix — DASHBOARD.md §8.1.
 *
 * Extends the M1 version with the full set of gates: TLS expectation
 * on non-loopback binds, allowedHosts mandatory when --unsafe-host is
 * set, and clear error messages naming the exact flag missing.
 */
import { LokiError } from '@loki/core'

export type RefusalInput = {
  readonly host: string
  readonly nodeEnv: string
  readonly allowProd: boolean
  readonly unsafeHost: boolean
  /** True if the operator passed `--trust-proxy-tls` (a TLS-terminating proxy is in front). */
  readonly trustProxyTls: boolean
  /** True if direct TLS termination is configured (`--tls-cert` + `--tls-key`). */
  readonly directTls: boolean
  /** Operator-provided allowedHosts entries (required when binding non-loopback). */
  readonly allowedHosts: readonly string[]
  /** True if any action surface has been allowed (`--allow-actions`). */
  readonly allowActions: boolean
  /** True if redaction has been turned off. */
  readonly noRedact: boolean
  /** Escape hatch for prod-mode + no-redact combo. */
  readonly allowProdLeakage: boolean
  /** Auth scheme. M2 defaults to 'none'. */
  readonly authScheme: 'none' | 'bearer' | 'basic'
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export function applyRefusalMatrix(input: RefusalInput): void {
  const isLoopback = LOOPBACK_HOSTS.has(input.host)
  const isProd = input.nodeEnv === 'production'
  const hasAuth = input.authScheme !== 'none'

  // 1. Production gate.
  if (isProd && !input.allowProd) {
    throw new LokiError(
      'dashboard: refusing to start under NODE_ENV=production without --allow-prod. ' +
        'See DASHBOARD.md §8.1.',
    )
  }
  if (isProd && !hasAuth) {
    throw new LokiError(
      'dashboard: NODE_ENV=production requires an auth scheme (--auth bearer:… or basic:…).',
    )
  }

  // 2. Host gate.
  if (!isLoopback && !input.unsafeHost) {
    throw new LokiError(
      `dashboard: refusing to bind '${input.host}' (non-loopback) without --unsafe-host.`,
    )
  }
  if (!isLoopback && input.unsafeHost && !hasAuth) {
    throw new LokiError(
      'dashboard: --unsafe-host requires an auth scheme. ' +
        'Use --auth bearer:$TOKEN (or basic:user:argon2hash).',
    )
  }
  if (!isLoopback && input.unsafeHost && input.allowedHosts.length === 0) {
    throw new LokiError(
      'dashboard: --unsafe-host requires --allowed-host <host:port> entries ' +
        '(DNS-rebinding defence).',
    )
  }
  if (!isLoopback && input.unsafeHost && !input.trustProxyTls && !input.directTls) {
    throw new LokiError(
      'dashboard: --unsafe-host requires TLS in front. Either:\n' +
        '  --trust-proxy-tls (a reverse proxy terminates TLS and forwards X-Forwarded-Proto: https), or\n' +
        '  --tls-cert /path --tls-key /path (direct TLS termination, future milestone).',
    )
  }

  // 3. Action gate — same one as M2's command parsing, restated here
  //    so a programmatic embedder can't bypass.
  if (input.allowActions && !hasAuth) {
    throw new LokiError(
      'dashboard: --allow-actions requires an auth scheme. ' +
        'Actions are never available anonymously.',
    )
  }

  // 4. Redaction gate.
  if (input.noRedact && isProd && !input.allowProdLeakage) {
    throw new LokiError(
      'dashboard: --no-redact under NODE_ENV=production refuses to start. ' +
        'Pass --allow-prod-leakage if you really mean it.',
    )
  }
}
