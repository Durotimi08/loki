/**
 * CLI version. Kept in sync with `package.json` by hand; release tooling
 * (and the `loki dashboard` /api/v1/version handler) reads this constant
 * so we don't need a runtime JSON-import dance.
 */
export const CLI_VERSION = '0.1.0'
