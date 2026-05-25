/**
 * GET /api/v1/version — runtime + schema fingerprint, useful for
 * matching a deployed dashboard to the schema it was launched against.
 *
 * Pure read — no DB. Safe under degraded Postgres state.
 */
import type { FastifyInstance } from 'fastify'
import { LOKI_CORE_VERSION } from '@loki/core'
import type { SchemaDef } from '@loki/core'
import { CLI_VERSION } from '../../version.js'
import { fingerprintSchema } from '../schema-fingerprint.js'

export type VersionPayload = {
  readonly core: string
  readonly cli: string
  readonly schemaFingerprint: string
  readonly schemaVersion: number
  readonly buildHash: string
  readonly startedAt: string
}

export function registerVersionRoute(
  app: FastifyInstance,
  schema: SchemaDef,
  startedAt: Date,
  buildHash?: string,
): void {
  const payload: VersionPayload = {
    core: LOKI_CORE_VERSION,
    cli: CLI_VERSION,
    schemaFingerprint: fingerprintSchema(schema),
    schemaVersion: schema.version,
    // Resolved at boot in priority order: explicit option (from
    // `commands/dashboard.ts`), env var, then 'dev'. The git-rev fallback
    // lives in the CLI command (where `child_process` is allowed) — the
    // dashboard subtree itself never spawns processes.
    buildHash: buildHash ?? process.env['LOKI_DASHBOARD_BUILD_HASH'] ?? 'dev',
    startedAt: startedAt.toISOString(),
  }

  app.get('/api/v1/version', async (_req, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    return payload
  })
}
