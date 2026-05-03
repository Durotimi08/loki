import type { OutboxWorkerHandle } from './outbox.js'
import type { ReconcilerHandle } from './reconciler.js'
import type { SchedulerWorkerHandle } from './scheduler.js'

/**
 * Lifecycle helpers (Gap 9) — wire process signals to a clean
 * Engine shutdown without each consumer reimplementing the dance.
 *
 * The shutdown order matters:
 *
 *   1. Stop **producers** of new work — outbox, scheduler, reconciler
 *      workers — so no new tx starts after the signal.
 *   2. Wait for any in-flight `runOnce` / `drainOnce` to commit.
 *      `OutboxWorkerHandle.stop()` already awaits in-flight; same for
 *      the scheduler. The reconciler resolves its current pass on
 *      `nextPass()` if the caller is awaiting one.
 *   3. Close the underlying connection pool.
 *
 * Critically: do NOT call `engine.close()` while a tx is mid-write.
 * Postgres.js will let the in-flight tx commit but new requests fail
 * fast — exactly what we want.
 */

export type EngineLike = {
  readonly close: () => Promise<void>
}

export type ShutdownTarget =
  | OutboxWorkerHandle
  | SchedulerWorkerHandle
  | ReconcilerHandle
  | { readonly stop: () => Promise<void> | void }

export type GracefulShutdownOptions = {
  /**
   * Timeout (ms) for the entire shutdown sequence. After this elapses
   * the helper resolves anyway — the OS-level signal handler should
   * then `process.exit(1)` to abort. Default 30_000 (30 seconds).
   */
  readonly timeoutMs?: number
  /**
   * Per-step logger. Defaults to a no-op. Wire to your logger so a
   * stuck worker shows up clearly in the shutdown trace.
   */
  readonly onStep?: (step: string) => void
  /**
   * Called when the timeout fires before all targets stop. The host
   * is expected to escalate (typically `process.exit(1)`). Default
   * is a no-op — the helper still resolves.
   */
  readonly onTimeout?: () => void
}

/**
 * Stop every supplied worker, then close the engine. Resolves once
 * every step has finished or the deadline passes — whichever first.
 *
 * Workers that throw on `.stop()` are logged via `onStep` and the
 * shutdown continues; partial cleanup is better than aborting the
 * remaining steps.
 */
export async function gracefulShutdown(
  engine: EngineLike,
  workers: readonly ShutdownTarget[],
  options: GracefulShutdownOptions = {},
): Promise<void> {
  const log = options.onStep ?? (() => {})
  const deadline = options.timeoutMs ?? 30_000

  const work = (async () => {
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i] as ShutdownTarget
      log(`stopping worker ${i + 1}/${workers.length}`)
      try {
        await w.stop()
      } catch (e) {
        log(`worker ${i + 1} stop error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    log('closing engine')
    try {
      await engine.close()
    } catch (e) {
      log(`engine close error: ${e instanceof Error ? e.message : String(e)}`)
    }
    log('shutdown complete')
  })()

  let timer: ReturnType<typeof setTimeout> | null = null
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log(`shutdown deadline reached (${deadline}ms) — escalating`)
      if (options.onTimeout) options.onTimeout()
      resolve()
    }, deadline)
    if (typeof timer.unref === 'function') timer.unref()
  })

  await Promise.race([work, timedOut])
  if (timer) clearTimeout(timer)
}

/**
 * Wire `gracefulShutdown` into the standard Node signal set. Returns
 * a disposer the caller can invoke from a unit test or a hot-reload
 * boundary.
 *
 * Defaults handle `SIGTERM` (k8s, systemd) and `SIGINT` (Ctrl-C).
 * Ignores subsequent signals during shutdown so a panicked operator
 * mashing Ctrl-C doesn't restart the sequence.
 */
export function installShutdownHandlers(
  engine: EngineLike,
  workers: readonly ShutdownTarget[],
  options: GracefulShutdownOptions & {
    readonly signals?: readonly NodeJS.Signals[]
    readonly exitOnComplete?: boolean
  } = {},
): () => void {
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as const)
  let shuttingDown = false
  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    options.onStep?.(`received ${signal}`)
    void gracefulShutdown(engine, workers, options).then(() => {
      if (options.exitOnComplete !== false) {
        // exitCode 0 — clean shutdown. Caller can override by setting
        // `exitOnComplete: false` and calling `process.exit` themselves.
        process.exit(0)
      }
    })
  }
  for (const sig of signals) process.on(sig, handler)
  return () => {
    for (const sig of signals) process.off(sig, handler)
  }
}
