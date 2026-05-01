import { defineConfig } from 'vitest/config'

/**
 * One config; the `LOKI_INTEGRATION` env flag controls test scope:
 *
 *   - default       — unit tests only (no Docker, no Postgres)
 *   - LOKI_INTEGRATION=1 — adds the integration tests too
 *
 * `pnpm test`             runs unit only.
 * `pnpm test:integration` sets the flag and runs everything.
 *
 * Type-level tests (`*.test-d.ts`) live alongside the unit tests.
 */
const includeIntegration = process.env['LOKI_INTEGRATION'] === '1'

export default defineConfig({
  test: {
    include: includeIntegration
      ? ['packages/*/test/**/*.test.ts']
      : ['packages/*/test/**/*.test.ts'],
    exclude: includeIntegration ? [] : ['packages/*/test/integration/**/*.test.ts'],
    typecheck: {
      enabled: true,
      include: ['packages/*/test/**/*.test-d.ts'],
      tsconfig: './tsconfig.base.json',
    },
    testTimeout: includeIntegration ? 120_000 : 5_000,
    hookTimeout: includeIntegration ? 120_000 : 10_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.test-d.ts', '**/dist/**'],
      reporter: ['text', 'lcov'],
    },
  },
})
