import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

/**
 * Same harness as `@loki/core`'s integration tests — preferred path is
 * `LOKI_TEST_DB_URL`, fallback is Testcontainers, gracefully skip if
 * neither is available.
 */
export type TestDatabase = {
  readonly url: string
  stop(): Promise<void>
}

let memoized: TestDatabase | null = null
let started = false

export async function ensurePostgres(): Promise<TestDatabase | null> {
  if (memoized) return memoized
  if (started) return null
  started = true

  const explicit = process.env['LOKI_TEST_DB_URL']
  if (explicit) {
    memoized = { url: explicit, async stop() {} }
    return memoized
  }

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
    console.warn(
      `[loki-client-integration] Postgres unavailable. Reason: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }
}

export async function teardownPostgres(): Promise<void> {
  if (memoized) {
    await memoized.stop()
    memoized = null
  }
  started = false
}
