/**
 * Server-Sent Events helper — DASHBOARD.md §6.11, §8.13.
 *
 * Each stream is a *server-polled* loop (no LISTEN/NOTIFY required from
 * the operator). The handler:
 *
 *   1. Sets SSE headers + flushes.
 *   2. Sends a one-shot welcome `:hb` comment.
 *   3. Loops:
 *        - `poll(state)` returns `{ events, nextState }`
 *        - frame each event, write to the socket
 *        - if the socket buffered too much (backpressure) → `event: lagged` + close
 *        - sleep `pollIntervalMs`
 *   4. Side timers:
 *        - heartbeat (`:hb\n\n`) every `heartbeatMs` so proxies don't
 *          drop idle connections.
 *        - hard close (`event: bye`) after `maxConnectionMs`.
 *
 * A process-wide concurrency cap bounds total SSE connections; rejected
 * requests get `503 Service Unavailable` + a problem doc. Per-session
 * caps land alongside richer session metadata in a follow-up milestone.
 *
 * Testability: all timers, `Date.now`, and "abort" signals are injected,
 * so unit tests can drive the loop deterministically.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuditLog } from './audit.js'

export type SseEvent = {
  /** `event:` field. */
  readonly event: string
  /** `id:` field — clients echo back on reconnect. */
  readonly id?: string
  /** Pre-serialised JSON body. */
  readonly data: unknown
}

export type SsePollFn<S> = (state: S) => Promise<{ events: readonly SseEvent[]; nextState: S }>

export type StreamOptions<S> = {
  readonly initialState: S
  readonly poll: SsePollFn<S>
  /** Default 2_000 ms. */
  readonly pollIntervalMs?: number
  /** Default 15_000 ms. */
  readonly heartbeatMs?: number
  /** Default 30 * 60_000 ms. */
  readonly maxConnectionMs?: number
  /** Bounded chunk-buffer size (in chunk count). Default 256. */
  readonly bufferSize?: number
  /** Required for audit on `event: lagged` / `event: bye`. */
  readonly audit: AuditLog
  /** Stream name for audit + event ids. */
  readonly streamName: string
  /** Tenant for audit entries. */
  readonly tenantId: string
  /** Override timers — tests use deterministic clocks. */
  readonly timers?: StreamTimers
  /**
   * Abort signal that ends the loop immediately. Tests use this to
   * stop a finite test run. Production passes the request abort signal.
   */
  readonly abortSignal?: AbortSignal
  /** Override `Date.now()`. */
  readonly now?: () => number
}

export type StreamTimers = {
  /** Sleep for `ms`; resolves early if `signal` aborts. */
  sleep(ms: number, signal: AbortSignal | undefined): Promise<void>
}

const DEFAULT_TIMERS: StreamTimers = {
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve()
      const handle = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(handle)
        resolve()
      })
    }),
}

const DEFAULT_POLL_MS = 2_000
const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_MAX_CONNECTION_MS = 30 * 60_000
const DEFAULT_BUFFER_SIZE = 256

// =============================================================================
// Concurrency cap
// =============================================================================

export type ConcurrencyCap = {
  /** Try to claim a slot. Returns true on success. */
  tryAcquire(): boolean
  /** Release a previously-claimed slot. */
  release(): void
  /** Currently held. */
  inFlight(): number
}

export function createConcurrencyCap(max: number): ConcurrencyCap {
  let held = 0
  return {
    tryAcquire() {
      if (held >= max) return false
      held += 1
      return true
    },
    release() {
      if (held > 0) held -= 1
    },
    inFlight() {
      return held
    },
  }
}

/**
 * Two-tier SSE cap — DASHBOARD.md §8.13.
 *
 * Every claim must succeed at BOTH a global cap (default 256) and a
 * per-session cap (default 16). Anonymous requests fall back to the IP
 * as the per-session key. On `release`, both counters decrement.
 */
export type SessionScopedCap = {
  tryAcquire(key: string | null): boolean
  release(key: string | null): void
  globalInFlight(): number
  perKeyInFlight(key: string | null): number
}

export function createSessionScopedCap(input: {
  readonly globalMax?: number
  readonly perSessionMax?: number
  readonly maxKeys?: number
}): SessionScopedCap {
  const globalMax = input.globalMax ?? 256
  const perKeyMax = input.perSessionMax ?? 16
  const maxKeys = input.maxKeys ?? 4096
  let global = 0
  const perKey = new Map<string, number>()

  function bumpLru(k: string): void {
    const v = perKey.get(k) ?? 0
    perKey.delete(k)
    perKey.set(k, v)
  }

  return {
    tryAcquire(key) {
      if (global >= globalMax) return false
      const k = key ?? '__anon__'
      const v = perKey.get(k) ?? 0
      if (v >= perKeyMax) return false
      if (!perKey.has(k) && perKey.size >= maxKeys) {
        const oldest = perKey.keys().next().value
        if (oldest !== undefined) perKey.delete(oldest)
      }
      perKey.set(k, v + 1)
      bumpLru(k)
      global += 1
      return true
    },
    release(key) {
      const k = key ?? '__anon__'
      const v = perKey.get(k) ?? 0
      if (v > 1) perKey.set(k, v - 1)
      else perKey.delete(k)
      if (global > 0) global -= 1
    },
    globalInFlight() {
      return global
    },
    perKeyInFlight(key) {
      return perKey.get(key ?? '__anon__') ?? 0
    },
  }
}

// =============================================================================
// Framing
// =============================================================================

/**
 * Frame one SSE event as a single string. SSE messages are line-based:
 *   id: …
 *   event: …
 *   data: …
 *
 *   <blank line>
 *
 * `data` is JSON-encoded. Newlines in the encoded JSON would split the
 * message — we replace them with `\ndata: ` so multi-line bodies stay
 * a single event (per the SSE spec).
 */
export function frameEvent(e: SseEvent): string {
  const lines: string[] = []
  if (e.id !== undefined) lines.push(`id: ${escapeField(e.id)}`)
  lines.push(`event: ${escapeField(e.event)}`)
  const json = JSON.stringify(e.data ?? null)
  // Spec says \n / \r in data must be split into multiple `data:` lines.
  for (const piece of json.split(/\r?\n/)) {
    lines.push(`data: ${piece}`)
  }
  return `${lines.join('\n')}\n\n`
}

function escapeField(s: string): string {
  // SSE fields end at `\r` / `\n`. Replace both with U+FFFD so a hostile
  // string can't inject a fake event.
  return s.replace(/[\r\n]/g, '�')
}

export const HEARTBEAT_FRAME = ':hb\n\n'

// =============================================================================
// Run a stream
// =============================================================================

/**
 * Drive an SSE stream until the abort signal fires, `maxConnectionMs`
 * elapses, or the socket goes away. Always emits a final `event: bye`
 * (best-effort).
 *
 * Returns the number of events delivered. Tests use this to assert
 * delivery; production ignores the return value.
 */
export async function runSseStream<S>(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: StreamOptions<S>,
): Promise<number> {
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_MS
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const maxConnectionMs = opts.maxConnectionMs ?? DEFAULT_MAX_CONNECTION_MS
  const timers = opts.timers ?? DEFAULT_TIMERS
  const now = opts.now ?? Date.now

  // Combine the external abort signal with our own deadline timer.
  const ac = new AbortController()
  const startedAt = now()
  if (opts.abortSignal !== undefined) {
    if (opts.abortSignal.aborted) ac.abort()
    else opts.abortSignal.addEventListener('abort', () => ac.abort())
  }
  // Also abort when the request socket closes.
  req.raw.on('close', () => ac.abort())

  reply.raw.statusCode = 200
  reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  reply.raw.setHeader('Cache-Control', 'private, no-store')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.setHeader('X-Accel-Buffering', 'no') // disable nginx buffering
  reply.raw.flushHeaders()
  reply.raw.write(HEARTBEAT_FRAME)

  let lastHeartbeatAt = startedAt
  let delivered = 0
  let state = opts.initialState
  let closed = false

  // Tells Fastify we've handled the response so the route handler can
  // `return reply` without Fastify trying to serialise a body.
  reply.hijack()

  const close = (reason: 'bye' | 'lagged', detail?: Record<string, unknown>): void => {
    if (closed) return
    closed = true
    try {
      reply.raw.write(frameEvent({ event: reason, data: { ts: now() } }))
    } catch {
      /* socket already gone */
    }
    try {
      reply.raw.end()
    } catch {
      /* idem */
    }
    opts.audit.append({
      reqId: req.id,
      event: `stream.${reason}`,
      sourceIp: req.ip,
      detail: { stream: opts.streamName, tenantId: opts.tenantId, delivered, ...detail },
    })
  }

  try {
    while (!ac.signal.aborted) {
      // Hard-close on deadline.
      if (now() - startedAt > maxConnectionMs) {
        close('bye', { reason: 'max-connection-ms' })
        return delivered
      }

      // Heartbeat if quiet.
      if (now() - lastHeartbeatAt >= heartbeatMs) {
        if (!safeWrite(reply, HEARTBEAT_FRAME)) {
          close('bye', { reason: 'write-failed' })
          return delivered
        }
        lastHeartbeatAt = now()
      }

      // Poll for fresh events. Bound the inner call by the same abort signal.
      let result: { events: readonly SseEvent[]; nextState: S }
      try {
        result = await opts.poll(state)
      } catch {
        close('bye', { reason: 'poll-error' })
        return delivered
      }
      state = result.nextState

      for (const ev of result.events) {
        if (ac.signal.aborted) break
        const frame = frameEvent({ ...ev, id: ev.id ?? String(delivered + 1) })
        if (!safeWrite(reply, frame)) {
          close('lagged', { reason: 'write-buffer-full' })
          return delivered
        }
        delivered += 1
        lastHeartbeatAt = now() // any write resets the heartbeat clock
      }

      // Sleep until the next tick or abort.
      await timers.sleep(pollInterval, ac.signal)
    }
    close('bye', { reason: 'abort' })
    return delivered
  } finally {
    // Ensure release in case an unexpected throw escapes.
    if (!closed) close('bye', { reason: 'unexpected' })
  }
}

function safeWrite(reply: FastifyReply, chunk: string): boolean {
  try {
    return reply.raw.write(chunk)
  } catch {
    return false
  }
}
