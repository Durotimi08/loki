/**
 * Socket-level defences — DASHBOARD.md §8.1.5 / T39.
 *
 * Three independent controls:
 *   1. `server.maxConnections` — the kernel will queue further SYNs up
 *      to `backlog` and then drop; we never accept past the cap.
 *   2. Per-source-IP new-connection token bucket. Excess connections are
 *      `socket.destroy()`-ed without ever spending FD-level resources on
 *      a wrong-shaped client.
 *   3. Slowloris guard via per-connection idle timeout — Fastify's
 *      headersTimeout already covers the HTTP layer, but a peer that
 *      opens a socket and never speaks gets dropped at 5s.
 */
import type { Server, Socket } from 'node:net'
import type { AuditLog } from '../audit.js'

export type SocketLimits = {
  /** Max concurrent accepted connections. Default 256. */
  readonly maxConnections?: number
  /** Listen backlog. Default 511 (POSIX classic). */
  readonly backlog?: number
  /** Per-IP new-connection refill rate (per second). Default 10. */
  readonly perIpPerSecond?: number
  /** Per-IP burst. Default 30. */
  readonly perIpBurst?: number
  /** Drop a connection that hasn't sent its first byte within this many ms. Default 5_000. */
  readonly firstByteTimeoutMs?: number
  /** Max distinct source IPs tracked. Default 4096. */
  readonly maxKeys?: number
  /** Override clock for tests. */
  readonly now?: () => number
}

const DEFAULTS = {
  maxConnections: 256,
  backlog: 511,
  perIpPerSecond: 10,
  perIpBurst: 30,
  firstByteTimeoutMs: 5_000,
  maxKeys: 4096,
} as const

type Bucket = { tokens: number; refilledAt: number }

/**
 * Attach to a Node `net.Server` (Fastify's underlying `app.server`) after
 * `listen()` has been called. Idempotent; safe to call once at boot.
 */
export function applySocketLimits(
  server: Server,
  audit: AuditLog,
  opts: SocketLimits = {},
): void {
  const maxConnections = opts.maxConnections ?? DEFAULTS.maxConnections
  const perIpPerSecond = opts.perIpPerSecond ?? DEFAULTS.perIpPerSecond
  const perIpBurst = opts.perIpBurst ?? DEFAULTS.perIpBurst
  const firstByteTimeout = opts.firstByteTimeoutMs ?? DEFAULTS.firstByteTimeoutMs
  const maxKeys = opts.maxKeys ?? DEFAULTS.maxKeys
  const now = opts.now ?? Date.now
  const refillPerMs = perIpPerSecond / 1000

  server.maxConnections = maxConnections
  const buckets = new Map<string, Bucket>()

  server.on('connection', (sock: Socket) => {
    const ip = sock.remoteAddress ?? 'unknown'
    const t = now()
    let b = buckets.get(ip)
    if (b === undefined) {
      if (buckets.size >= maxKeys) {
        const oldest = buckets.keys().next().value
        if (oldest !== undefined) buckets.delete(oldest)
      }
      b = { tokens: perIpBurst, refilledAt: t }
      buckets.set(ip, b)
    } else {
      buckets.delete(ip)
      buckets.set(ip, b)
      const elapsed = t - b.refilledAt
      if (elapsed > 0) {
        b.tokens = Math.min(perIpBurst, b.tokens + elapsed * refillPerMs)
        b.refilledAt = t
      }
    }

    if (b.tokens < 1) {
      audit.append({
        reqId: 'socket',
        event: 'socket.flood',
        sourceIp: ip,
        detail: { perIpPerSecond, perIpBurst },
      })
      sock.destroy()
      return
    }
    b.tokens -= 1

    // Slowloris: kill any connection that doesn't send its first byte
    // before the timeout. Fastify's `headersTimeout` covers the HTTP
    // path; this catches the peer that opens a socket and stays mum.
    sock.setTimeout(firstByteTimeout, () => sock.destroy())
    sock.once('data', () => sock.setTimeout(0)) // disarm once they speak
    sock.setKeepAlive(true, 30_000)
    sock.setNoDelay(true)
  })
}

export const SOCKET_DEFAULTS = DEFAULTS
