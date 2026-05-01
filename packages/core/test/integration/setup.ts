import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

/**
 * Bootstraps a Postgres for an integration test.
 *
 * Resolution order:
 *   1. `LOKI_TEST_DB_URL` — opt out of Testcontainers, point at a
 *       reachable Postgres. Useful for CI hosts that can't run Docker.
 *   2. Testcontainers — pull `postgres:16-alpine` and start it.
 *
 * If neither path works, the test marks itself skipped via
 * `it.skip(...)` — the test file calls `await ensurePostgres()` from
 * `beforeAll`; on failure it returns null and tests use the helper
 * `skipIfNoDatabase()` to gracefully bail.
 */
export type TestDatabase = {
  readonly url: string
  /** Stop the container (or close the externally-provided pool). */
  stop(): Promise<void>
}

let memoized: TestDatabase | null = null
let started = false

export async function ensurePostgres(): Promise<TestDatabase | null> {
  if (memoized) return memoized
  if (started) return null
  started = true

  // 1. Caller-provided database wins.
  const explicit = process.env['LOKI_TEST_DB_URL']
  if (explicit) {
    memoized = { url: explicit, async stop() {} }
    return memoized
  }

  // 2. Testcontainers — depends on the Docker daemon.
  try {
    const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
      'postgres:16-alpine',
    )
      .withDatabase('loki')
      .withUsername('loki')
      .withPassword('loki')
      .start()
    const url = `postgres://${container.getUsername()}:${container.getPassword()}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`
    memoized = {
      url,
      async stop() {
        await container.stop()
      },
    }
    return memoized
  } catch (e) {
    // Don't blow up the suite — the test file decides whether to skip
    // or fail. Most often: Docker is not running.
    console.warn(
      `[loki-integration] Postgres unavailable (set LOKI_TEST_DB_URL or start Docker). Reason: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }
}

/** Stop the shared Postgres at the end of the suite. */
export async function teardownPostgres(): Promise<void> {
  if (memoized) {
    await memoized.stop()
    memoized = null
  }
  started = false
}
