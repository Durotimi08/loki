import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

/**
 * Bench-side Postgres bootstrap. Mirrors the integration-test version
 * in `@loki/core` — opt out of testcontainers via `LOKI_TEST_DB_URL`
 * for hosts that can't run Docker.
 */
export type BenchDatabase = {
  readonly url: string
  stop(): Promise<void>
}

let memoized: BenchDatabase | null = null
let started = false

export async function ensurePostgres(): Promise<BenchDatabase | null> {
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
      .withDatabase('loki_bench')
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
      `[loki-bench] Postgres unavailable (set LOKI_TEST_DB_URL or start Docker). Reason: ${
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
