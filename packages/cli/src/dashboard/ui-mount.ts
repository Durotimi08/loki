/**
 * Mount the static UI under the dashboard server — DASHBOARD.md §7.
 *
 * The UI is *per-page server-rendered*: each navigable URL has its own
 * HTML shell under `ui/pages/`. The shell carries a `data-page="<id>"`
 * attribute on `<body>` that `app.js` reads to know which renderer to
 * invoke. There is no client-side router — `<a href="/transactions">`
 * triggers a real navigation, the server returns `pages/transactions.html`,
 * and `app.js` reads the `data-page` and renders.
 *
 * Static assets (CSS, JS, favicon) are served from `ui/assets/` via
 * `@fastify/static` at the `/_assets/` prefix.
 *
 * Path-traversal guards: `@fastify/static` rejects `..` and absolute
 * paths; the page-shell map below uses an explicit allowlist so an
 * unrecognised URL falls through to the standard 404.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_DIR_CANDIDATES = [resolve(HERE, './ui')]

const NON_HTML_API = /^\/api\//

/**
 * URL → page shell file. Each entry maps a route shape to the HTML file
 * served. The list is the closed enum of UI routes; anything else 404s.
 */
const ROUTE_TO_SHELL: ReadonlyArray<{
  readonly match: (path: string) => boolean
  readonly shell: string
}> = [
  { match: (p) => p === '/' || p === '/overview', shell: 'overview.html' },
  { match: (p) => p === '/schema', shell: 'schema.html' },
  { match: (p) => p === '/flows', shell: 'flows.html' },
  { match: (p) => /^\/flow\/[A-Za-z0-9_-]+$/.test(p), shell: 'flow-detail.html' },
  { match: (p) => p === '/transactions', shell: 'transactions.html' },
  { match: (p) => /^\/transactions\/[0-9a-f-]{36}$/i.test(p), shell: 'transaction-detail.html' },
  { match: (p) => p === '/anomalies', shell: 'anomalies.html' },
  { match: (p) => p === '/outbox', shell: 'outbox.html' },
  { match: (p) => p === '/scheduled', shell: 'scheduled.html' },
  { match: (p) => p === '/holds', shell: 'holds.html' },
  { match: (p) => p === '/disputes', shell: 'disputes.html' },
  { match: (p) => p === '/reconciler', shell: 'reconciler.html' },
  { match: (p) => p === '/fx', shell: 'fx.html' },
  { match: (p) => p === '/actors', shell: 'actors.html' },
  { match: (p) => /^\/actors\/[A-Za-z0-9_-]+$/.test(p), shell: 'actor-type.html' },
  { match: (p) => /^\/actors\/[A-Za-z0-9_-]+\/[A-Za-z0-9._:@+\-]+$/.test(p), shell: 'actor.html' },
]

export type UiMountOptions = {
  /** Override the UI assets root (used by tests / dev hot-iterate). */
  readonly root?: string
  /** When false, asset responses get `Cache-Control: public, max-age=3600`. Default true (no-cache). */
  readonly noCache?: boolean
}

export async function registerUi(app: FastifyInstance, opts: UiMountOptions = {}): Promise<void> {
  const root = opts.root ?? (await pickRoot())
  if (root === null) return

  const assetsRoot = join(root, 'assets')
  const pagesRoot = join(root, 'pages')

  const fastifyStatic = (await import('@fastify/static')).default
  await app.register(fastifyStatic, {
    root: assetsRoot,
    prefix: '/_assets/',
    decorateReply: false,
    serveDotFiles: false,
    cacheControl: true,
    immutable: false,
    maxAge: opts.noCache === false ? 3600_000 : 0,
    setHeaders(reply) {
      reply.setHeader('Cache-Control', opts.noCache === false ? 'public, max-age=3600' : 'no-cache')
    },
  })

  // Read every shell at boot so the page handler is a memory lookup,
  // not a per-request file read. Falls back to overview.html for any
  // shell file we can't read (allows deploying with a subset).
  const fs = await import('node:fs/promises')
  const shells: Record<string, string> = {}
  for (const entry of ROUTE_TO_SHELL) {
    try {
      shells[entry.shell] = await fs.readFile(join(pagesRoot, entry.shell), 'utf8')
    } catch {
      /* shell missing on disk — request will 404 */
    }
  }

  // Wildcard catch-all: matches any GET that isn't an API path and
  // isn't an asset (the @fastify/static prefix handles those). On
  // match against the allowlist, return that shell; on miss, 404.
  app.get('/*', async (req, reply) => {
    if (NON_HTML_API.test(req.url)) {
      return reply.code(404).type('application/problem+json').send({
        type: 'https://loki.dev/problems/not-found',
        title: 'Not Found',
        status: 404,
      })
    }
    const path = req.url.split('?')[0] ?? req.url
    const entry = ROUTE_TO_SHELL.find((e) => e.match(path))
    const html = entry !== undefined ? shells[entry.shell] : undefined
    if (html === undefined) {
      return reply.code(404).type('application/problem+json').send({
        type: 'https://loki.dev/problems/not-found',
        title: 'Not Found',
        status: 404,
      })
    }
    reply.header('Cache-Control', 'no-cache')
    return reply.code(200).type('text/html; charset=utf-8').send(html)
  })
}

async function pickRoot(): Promise<string | null> {
  const fs = await import('node:fs/promises')
  for (const candidate of UI_DIR_CANDIDATES) {
    try {
      await fs.access(join(candidate, 'pages', 'overview.html'))
      return candidate
    } catch { /* try next */ }
  }
  return null
}
