import { createEngine } from '@loki/core'
import { schema } from './schema.js'

/**
 * One-shot migration runner.
 *
 *     pnpm migrate
 *
 * Idempotent: re-running on an existing schema is a no-op (the
 * `_loki_migrations` ledger detects an already-applied plan).
 */
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (!url) {
    console.error('Set DATABASE_URL first, e.g.')
    console.error('  export DATABASE_URL="postgres://loki:loki@localhost:5432/loki_examples"')
    process.exit(1)
  }
  const engine = createEngine({ schema, connection: { url } })
  try {
    const applied = await engine.migrate()
    console.log(`Applied ${applied.length} migration(s):`)
    for (const m of applied) console.log(`  ${m.id} (${m.checksum.slice(0, 12)}…)`)
  } finally {
    await engine.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
