/**
 * Shared route helpers — RFC 7807 problem doc, tenant resolution.
 *
 * The `problem()` helper is a single place to emit the canonical
 * application/problem+json shape (matches DASHBOARD.md §8.7 / §8.19.x).
 * The `resolveTenant()` helper batches the three checks every per-tenant
 * route must do: slug validity → allowlist → tenants table.
 */
import type { FastifyReply } from 'fastify'
import type { TenantRow } from '@loki/core'
import type { ReadEngine } from '../read-engine.js'
import * as v from '../security/validation.js'

export function problem(
  reply: FastifyReply,
  status: number,
  slug: string,
  detail?: string,
): FastifyReply {
  reply
    .code(status)
    .type('application/problem+json')
    .header('Cache-Control', 'private, no-store')
    .send({
      type: `https://loki.dev/problems/${slug}`,
      title: titleFor(status),
      status,
      ...(detail !== undefined ? { detail } : {}),
    })
  return reply
}

function titleFor(status: number): string {
  if (status === 400) return 'Bad Request'
  if (status === 401) return 'Unauthorized'
  if (status === 403) return 'Forbidden'
  if (status === 404) return 'Not Found'
  if (status === 409) return 'Conflict'
  if (status === 415) return 'Unsupported Media Type'
  if (status === 429) return 'Too Many Requests'
  if (status >= 500) return 'Internal Server Error'
  return 'Error'
}

export type ResolvedTenant = { readonly id: string; readonly row: TenantRow }

export async function resolveTenant(
  engine: ReadEngine,
  tenantsAllowlist: 'all' | readonly string[],
  reply: FastifyReply,
  raw: string | undefined,
): Promise<ResolvedTenant | null> {
  const id = v.tenantId(raw)
  if (!id.ok) {
    problem(reply, 400, 'bad-tenant-id', id.reason)
    return null
  }
  const allowed = v.tenantInAllowlist(id.value, tenantsAllowlist)
  if (!allowed.ok) {
    problem(reply, 404, 'tenant-not-found')
    return null
  }
  const row = await engine.admin.tenants.get(id.value)
  if (row === null) {
    problem(reply, 404, 'tenant-not-found')
    return null
  }
  return { id: id.value, row }
}
