import { createEngine } from '@loki/core'
import type { LokiConfig } from '../config.js'
import type { Io } from '../io.js'

export type TenantAction =
  | { readonly kind: 'create'; readonly id: string; readonly name: string }
  | { readonly kind: 'list' }
  | { readonly kind: 'get'; readonly id: string }
  | { readonly kind: 'suspend'; readonly id: string }
  | { readonly kind: 'activate'; readonly id: string }
  | { readonly kind: 'delete'; readonly id: string }

export async function runTenant(config: LokiConfig, action: TenantAction, io: Io): Promise<number> {
  const engine = createEngine({
    schema: config.schema,
    connection: config.connection,
    ...(config.migration ? { migration: config.migration } : {}),
  })
  try {
    switch (action.kind) {
      case 'create': {
        const tenant = await engine.admin.tenants.create({
          id: action.id,
          name: action.name,
        })
        io.out(`Created tenant ${tenant.id} (${tenant.name}, ${tenant.state})`)
        return 0
      }
      case 'list': {
        const list = await engine.admin.tenants.list()
        if (list.length === 0) {
          io.out('No tenants.')
        } else {
          io.out(formatTable(list))
        }
        return 0
      }
      case 'get': {
        const tenant = await engine.admin.tenants.get(action.id)
        if (!tenant) {
          io.err(`No tenant with id "${action.id}".`)
          return 1
        }
        io.out(JSON.stringify(tenant, null, 2))
        return 0
      }
      case 'suspend': {
        const tenant = await engine.admin.tenants.suspend(action.id)
        io.out(`Suspended ${tenant.id}.`)
        return 0
      }
      case 'activate': {
        const tenant = await engine.admin.tenants.activate(action.id)
        io.out(`Activated ${tenant.id}.`)
        return 0
      }
      case 'delete': {
        const tenant = await engine.admin.tenants.delete(action.id)
        io.out(`Deleted ${tenant.id}.`)
        return 0
      }
    }
  } finally {
    await engine.close()
  }
}

type Tenant = {
  readonly id: string
  readonly name: string
  readonly mode: string
  readonly state: string
  readonly createdAt: Date
}

function formatTable(rows: readonly Tenant[]): string {
  const headers = ['ID', 'NAME', 'MODE', 'STATE', 'CREATED']
  const widths = headers.map((h) => h.length)
  const rendered = rows.map((r) => [r.id, r.name, r.mode, r.state, r.createdAt.toISOString()])
  for (const r of rendered) {
    for (let i = 0; i < r.length; i++) {
      const cell = r[i] as string
      if (cell.length > (widths[i] ?? 0)) widths[i] = cell.length
    }
  }
  const pad = (cell: string, w: number): string => cell.padEnd(w, ' ')
  const head = headers.map((h, i) => pad(h, widths[i] as number)).join('  ')
  const lines = rendered.map((r) => r.map((c, i) => pad(c, widths[i] as number)).join('  '))
  return [head, ...lines].join('\n')
}
