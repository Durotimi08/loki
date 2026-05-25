import { cpSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'tsup'

/**
 * tsup config for `@loki/cli`. Output:
 *
 *   - `dist/index.js`                — CLI entrypoint
 *   - `dist/dashboard-<hash>.js`     — lazy-loaded dashboard chunk
 *   - `dist/argon2-<hash>.js`        — lazy-loaded basic-auth chunk
 *   - `dist/ui/**`                   — static UI assets (HTML/CSS/JS/favicon)
 *
 * The UI assets need to land at runtime alongside `dashboard/*.js` so
 * `ui-mount.ts` can `@fastify/static`-serve them. We copy them as a
 * post-build hook because tsup doesn't have a built-in "copy these
 * static files" knob.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  async onSuccess() {
    const src = resolve('src/dashboard/ui')
    const dst = resolve('dist/ui')
    if (existsSync(src)) {
      cpSync(src, dst, { recursive: true })
    }
  },
})
