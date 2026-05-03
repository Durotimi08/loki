/**
 * The current `@loki/core` version. Stamped on the migration plan
 * checksum metadata and exposed via `engine.version`. Bump on every
 * release that changes wire/storage format; consumers can `assert
 * compatVersion(engine.version)` at startup to refuse a deployment
 * whose binary doesn't match the storage they connected to.
 */
export const LOKI_CORE_VERSION = '0.0.0'

/**
 * Compatibility cohort. The library guarantees that any two
 * `@loki/core` builds that share a `LOKI_COMPAT_MAJOR` can read each
 * other's storage format and produce byte-identical hash chains. Bump
 * this on any change that breaks that contract (canonicalize change,
 * DDL change, hash-chain content change, role rename).
 *
 * The minor/patch portions of `LOKI_CORE_VERSION` are free to move
 * within a cohort; consumers pin on the cohort, not the version.
 */
export const LOKI_COMPAT_MAJOR = 0

/**
 * Throw if the library is older than the floor a deployed schema
 * requires. Use at process startup so a downgrade can't silently land:
 *
 *   import { assertMinCompat, LOKI_COMPAT_MAJOR } from '@loki/core'
 *   assertMinCompat({ minMajor: 1 }) // refuses 0.x builds
 */
export function assertMinCompat(opts: { minMajor: number }): void {
  if (LOKI_COMPAT_MAJOR < opts.minMajor) {
    throw new Error(
      `@loki/core compatibility cohort ${LOKI_COMPAT_MAJOR} is older than required floor ${opts.minMajor}. Upgrade the library before starting.`,
    )
  }
}
