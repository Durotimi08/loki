import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    typecheck: {
      enabled: true,
      include: ['packages/*/test/**/*.test-d.ts'],
      tsconfig: './tsconfig.base.json',
    },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.test-d.ts', '**/dist/**'],
      reporter: ['text', 'lcov'],
    },
  },
})
