/**
 * DNS-rebinding defence — DASHBOARD.md §8.2, T4.
 *
 * Before any handler runs, we check the inbound `Host` header against
 * an explicit allowlist. The classic kill chain this stops:
 *
 *   1. Attacker registers `evil.example` resolving to `127.0.0.1`.
 *   2. Victim opens `https://evil.example:4488` in a browser.
 *   3. The browser issues fetches with `Host: evil.example:4488`.
 *   4. Without this check, our process happily answers — same-origin
 *      policy is satisfied from the browser's view because the page
 *      origin matches the request origin.
 *
 * With the allowlist, every Host that isn't in the configured set
 * (defaults: loopback variants at the bound port) gets `421 Misdirected
 * Request`. `421` is the semantically correct status — browsers treat
 * it cleanly, the empty body avoids fingerprinting.
 *
 * The check runs on EVERY request — including OPTIONS, HEAD, and any
 * SSE upgrade. Cheap (hashset lookup) and fail-closed.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuditLog } from '../audit.js'

export type HostAllowlist = {
  /** Lower-cased Host values that are accepted (e.g. `127.0.0.1:4488`). */
  readonly accepted: ReadonlySet<string>
}

export function buildHostAllowlist(input: {
  readonly host: string
  readonly port: number
  readonly extra: readonly string[]
}): HostAllowlist {
  const port = input.port
  const accepted = new Set<string>()
  // Loopback variants — always accepted when the operator binds the
  // dashboard at all. We *also* add the bare hostname (no port), which
  // some HTTP libraries set when the port matches the scheme default.
  const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]', '::1']
  for (const h of loopbackHosts) {
    accepted.add(`${h}:${port}`.toLowerCase())
    accepted.add(h.toLowerCase())
  }
  // Honour the actually-bound host so non-loopback deployments work.
  if (input.host) {
    accepted.add(`${input.host}:${port}`.toLowerCase())
    accepted.add(input.host.toLowerCase())
  }
  // Operator-configured extras (e.g. `dashboard.internal:443`).
  for (const x of input.extra) {
    accepted.add(x.toLowerCase())
  }
  return { accepted }
}

export function registerHostAllowlist(
  app: FastifyInstance,
  allowlist: HostAllowlist,
  audit: AuditLog,
): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.headers['host']
    const host = (raw ?? '').toLowerCase().trim()
    if (host === '' || !allowlist.accepted.has(host)) {
      audit.append({
        reqId: req.id,
        event: 'host-allowlist.deny',
        sourceIp: req.ip,
        detail: { host: raw ?? null, path: req.url, method: req.method },
      })
      reply
        .code(421)
        .type('text/plain; charset=utf-8')
        .header('Cache-Control', 'private, no-store')
        .send('misdirected')
      return reply
    }
    return undefined
  })
}
