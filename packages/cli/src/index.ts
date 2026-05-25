#!/usr/bin/env node
/**
 * `loki` — a thin CLI wrapper around the engine. The interesting code
 * lives in `runner.ts` and `commands/*.ts`; this file is just the
 * binary entry point that hands `process.argv` to `run()` and exits
 * with the returned code.
 */
import { run } from './runner.js'

export { loadConfig, type LokiConfig } from './config.js'
export { type Io, bufferedIo, stdIo } from './io.js'
export { run, type RunnerOptions } from './runner.js'
export { runMigrate, type MigrateAction } from './commands/migrate.js'
export { runReconcile, type ReconcileOptions } from './commands/reconcile.js'
export { runSchema, type SchemaAction } from './commands/schema.js'
export { runTenant, type TenantAction } from './commands/tenant.js'

// When invoked as a binary (`loki ...`), run the CLI and exit. The
// guard lets the file be imported as a module without side effects.
// Build is ESM-only; tsup polyfills `require` via `createRequire`, so
// `typeof require === 'undefined'` lies — match on `import.meta.url`
// vs `process.argv[1]` directly.
const isMain = (() => {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  try {
    return new URL(`file://${argv1}`).href === import.meta.url
  } catch {
    return false
  }
})()

if (isMain) {
  run({ args: process.argv.slice(2) })
    .then((code) => {
      process.exit(code)
    })
    .catch((e) => {
      process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    })
}
