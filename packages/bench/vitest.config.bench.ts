import { defineConfig } from 'vitest/config'

/**
 * Bench harness — separate from the main `vitest.config.ts` so a
 * `pnpm test` run never accidentally triggers a long-running
 * benchmark, and so the bench file glob can be its own thing.
 *
 * Numbers print to stdout in a single block at the end of the run;
 * reporting verbose by default so a CI run preserves the metrics.
 */
export default defineConfig({
  test: {
    include: ['packages/bench/bench/**/*.bench.ts'],
    benchmark: {
      reporters: ['verbose'],
    },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
