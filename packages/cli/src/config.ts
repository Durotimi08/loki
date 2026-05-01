import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConnectionInput, MigrationOptions, SchemaDef } from '@loki/core'

/**
 * The shape every Loki config module must export as `default`. JS/MJS
 * configs work today; TS configs are loaded if the user runs the CLI
 * via `tsx` / `bun` / `node --experimental-strip-types`.
 */
export type LokiConfig = {
  readonly schema: SchemaDef
  readonly connection: ConnectionInput
  readonly migration?: MigrationOptions
}

const DEFAULT_PATHS = ['loki.config.js', 'loki.config.mjs', 'loki.config.ts']

export type LoadConfigInput = {
  /** Explicit `--config` path, or `undefined` to auto-discover. */
  readonly path?: string
  /** Working directory for relative path resolution. Defaults to `process.cwd()`. */
  readonly cwd?: string
}

/**
 * Resolve a `LokiConfig` from disk. The path can be explicit (`--config
 * ./loki.config.js`) or auto-discovered from `loki.config.{js,mjs,ts}`
 * in the current working directory. The module must `export default`
 * the config object.
 */
export async function loadConfig(input: LoadConfigInput = {}): Promise<LokiConfig> {
  const cwd = input.cwd ?? process.cwd()
  const candidate = input.path ?? findDefault(cwd)
  if (!candidate) {
    throw new Error(
      `No Loki config found. Looked for ${DEFAULT_PATHS.join(', ')} in ${cwd} or pass --config <path>.`,
    )
  }
  const abs = resolve(cwd, candidate)
  const url = pathToFileURL(abs).href
  const mod = (await import(url)) as { default?: unknown } | unknown
  const cfg = (
    typeof mod === 'object' && mod !== null && 'default' in mod
      ? (mod as { default: unknown }).default
      : mod
  ) as LokiConfig | undefined
  if (!cfg || typeof cfg !== 'object' || !('schema' in cfg) || !('connection' in cfg)) {
    throw new Error(
      `Config at ${abs} must \`export default\` an object with at least { schema, connection }.`,
    )
  }
  return cfg as LokiConfig
}

function findDefault(cwd: string): string | undefined {
  for (const name of DEFAULT_PATHS) {
    const full = resolve(cwd, name)
    if (existsSync(full)) return full
  }
  return undefined
}
