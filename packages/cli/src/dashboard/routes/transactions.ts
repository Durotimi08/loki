/**
 * Transaction routes — DASHBOARD.md §6.5.
 *
 *   GET /api/v1/tenants/:tid/transactions?type=&state=&cursor=&limit=
 *   GET /api/v1/tenants/:tid/transactions/:txnId
 *   GET /api/v1/tenants/:tid/transactions/:txnId/trace
 *   GET /api/v1/tenants/:tid/transactions/:txnId/verify
 *   GET /api/v1/tenants/:tid/transactions/:txnId/postings
 *   GET /api/v1/tenants/:tid/transactions/:txnId/keys
 *
 * Trace transitions carry payloads — the route runs `engine.decryptPayload`
 * + the configured redactor (§8.9) before returning. Failed decrypt →
 * `{ $encrypted: true, alg: ... }`; ciphertext never leaves the DB.
 */
import { createHash } from 'node:crypto'
import { sha256Hasher } from '@loki/core'
import type { FastifyInstance } from 'fastify'
import type { SchemaDef, TxnTransition } from '@loki/core'
import type { CursorEncoder } from '../security/cursor.js'
import type { RouteSemaphore } from '../security/route-concurrency.js'
import * as v from '../security/validation.js'
import type { ReadEngine } from '../read-engine.js'
import { type Redactor, redactPayload } from '../redact.js'
import { problem, resolveTenant } from './helpers.js'

export type TransactionRouteContext = {
  readonly engine: ReadEngine
  readonly schema: SchemaDef
  readonly tenants: 'all' | readonly string[]
  readonly cursor: CursorEncoder
  readonly redactor: Redactor
  /** Optional per-route concurrency semaphore (§8.13). */
  readonly findManyConcurrency?: RouteSemaphore
  /** Optional per-route concurrency semaphore for /postings (§8.13). */
  readonly postingsConcurrency?: RouteSemaphore
}

// UUID v4 regex — what the engine generates for txn IDs.
const TXN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerTransactionRoutes(
  app: FastifyInstance,
  ctx: TransactionRouteContext,
): void {
  // findMany + filters
  const findManyHooks = ctx.findManyConcurrency
    ? { preHandler: ctx.findManyConcurrency.preHandler, onResponse: ctx.findManyConcurrency.onResponse }
    : {}
  app.get('/api/v1/tenants/:tid/transactions', findManyHooks, async (req, reply) => {
    const params = req.params as { tid?: string }
    const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
    if (t === null) return reply

    const q = req.query as Record<string, string | undefined>
    const limit = v.limit(q['limit'])
    if (!limit.ok) return problem(reply, 400, 'bad-limit', limit.reason)

    let typeFilter: string | undefined
    if (q['type'] !== undefined) {
      const r = v.txnType(q['type'], ctx.schema)
      if (!r.ok) return problem(reply, 404, 'unknown-txn-type', r.reason)
      typeFilter = r.value
    }

    let stateFilter: string | undefined
    if (q['state'] !== undefined) {
      if (typeFilter === undefined) {
        return problem(reply, 400, 'state-requires-type', 'pass ?type=... to filter by state')
      }
      const r = v.state(q['state'], ctx.schema, typeFilter)
      if (!r.ok) return problem(reply, 404, 'unknown-state', r.reason)
      stateFilter = r.value
    }

    let innerCursor: string | undefined
    const route = 'transactions'
    if (q['cursor'] !== undefined) {
      const dec = ctx.cursor.decode(route, q['cursor'])
      if (!dec.ok) return problem(reply, 400, 'bad-cursor', dec.reason)
      innerCursor = dec.inner
    }

    const client = ctx.engine.forTenant(t.id)
    const where = {
      ...(typeFilter !== undefined ? { type: typeFilter } : {}),
      ...(stateFilter !== undefined ? { state: stateFilter } : {}),
    }
    const page = await client.queries.transactions.findMany({
      where,
      limit: limit.value,
      ...(innerCursor !== undefined ? { cursor: innerCursor } : {}),
    })

    reply.header('Cache-Control', 'private, no-store')
    return {
      items: page.items.map((r) => ({
        id: r.id,
        type: r.type,
        state: r.state,
        version: r.version,
        compromised: r.compromised,
        schemaVersion: r.schemaVersion,
        createdBy: r.createdBy,
        participants: r.participants,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      nextCursor: page.nextCursor !== null ? ctx.cursor.encode(route, page.nextCursor) : null,
    }
  })

  // detail
  app.get('/api/v1/tenants/:tid/transactions/:txnId', async (req, reply) => {
    const { tid, txnId } = await resolveTxnParams(req, ctx, reply)
    if (tid === null || txnId === null) return reply
    const row = await ctx.engine.dashboard.txnRecord(tid, txnId)
    if (row === null) return problem(reply, 404, 'txn-not-found')
    reply.header('Cache-Control', 'private, no-store')
    return row
  })

  // trace — payloads decrypted + redacted per §8.9
  app.get('/api/v1/tenants/:tid/transactions/:txnId/trace', async (req, reply) => {
    const { tid, txnId } = await resolveTxnParams(req, ctx, reply)
    if (tid === null || txnId === null) return reply
    const row = await ctx.engine.dashboard.txnRecord(tid, txnId)
    if (row === null) return problem(reply, 404, 'txn-not-found')

    const client = ctx.engine.forTenant(tid)
    // Pull all transitions for this txn; cap at 500 because a trace is
    // a single transaction's whole history — never paginated.
    const page = await client.queries.transitions.findMany({
      where: { txnId },
      limit: 500,
      orderBy: 'occurredAt:asc',
    })

    const out = await Promise.all(
      page.items.map(async (t) => ({
        id: t.id,
        type: t.type,
        name: t.name,
        fromState: t.fromState,
        toState: t.toState,
        actor: t.actor,
        idempotencyKey: hashedIdempotency(t.idempotencyKey),
        schemaVersion: t.schemaVersion,
        traceId: t.traceId,
        rowHash: bufferToHex(t.rowHash),
        prevHash: t.prevHash !== null ? bufferToHex(t.prevHash) : null,
        postingsChecksum: bufferToHex(t.postingsChecksum),
        reverses: t.reverses,
        occurredAt: t.occurredAt.toISOString(),
        payload: await redactPayload(
          ctx.engine.decryptPayload,
          t.payload,
          {
            kind: 'transition',
            tenantId: tid,
            txnType: t.type,
            transitionName: t.name,
          },
          ctx.redactor,
        ),
      })),
    )

    reply.header('Cache-Control', 'private, no-store')
    return {
      record: row,
      transitions: out,
      truncated: out.length === 500,
    }
  })

  // verify — recompute the hash chain on the fly
  app.get('/api/v1/tenants/:tid/transactions/:txnId/verify', async (req, reply) => {
    const { tid, txnId } = await resolveTxnParams(req, ctx, reply)
    if (tid === null || txnId === null) return reply
    const row = await ctx.engine.dashboard.txnRecord(tid, txnId)
    if (row === null) return problem(reply, 404, 'txn-not-found')
    const client = ctx.engine.forTenant(tid)
    const result = await client.queries.verify(txnId, sha256Hasher)
    reply.header('Cache-Control', 'private, no-store')
    return result
  })

  // postings — page of (transition × posting) joins
  const postingsHooks = ctx.postingsConcurrency
    ? { preHandler: ctx.postingsConcurrency.preHandler, onResponse: ctx.postingsConcurrency.onResponse }
    : {}
  app.get('/api/v1/tenants/:tid/transactions/:txnId/postings', postingsHooks, async (req, reply) => {
    const { tid, txnId } = await resolveTxnParams(req, ctx, reply)
    if (tid === null || txnId === null) return reply
    const row = await ctx.engine.dashboard.txnRecord(tid, txnId)
    if (row === null) return problem(reply, 404, 'txn-not-found')

    const q = req.query as Record<string, string | undefined>
    const limit = v.limit(q['limit'])
    if (!limit.ok) return problem(reply, 400, 'bad-limit', limit.reason)

    const route = `postings:${txnId}`
    let inner: string | undefined
    if (q['cursor'] !== undefined) {
      const dec = ctx.cursor.decode(route, q['cursor'])
      if (!dec.ok) return problem(reply, 400, 'bad-cursor', dec.reason)
      inner = dec.inner
    }

    const page = await ctx.engine.dashboard.txnPostings(tid, txnId, {
      ...(inner !== undefined ? { cursor: inner } : {}),
      limit: limit.value,
    })

    reply.header('Cache-Control', 'private, no-store')
    return {
      items: page.items,
      nextCursor: page.nextCursor !== null ? ctx.cursor.encode(route, page.nextCursor) : null,
    }
  })

  // keys — capability key lineage
  app.get('/api/v1/tenants/:tid/transactions/:txnId/keys', async (req, reply) => {
    const { tid, txnId } = await resolveTxnParams(req, ctx, reply)
    if (tid === null || txnId === null) return reply
    const row = await ctx.engine.dashboard.txnRecord(tid, txnId)
    if (row === null) return problem(reply, 404, 'txn-not-found')
    const items = await ctx.engine.dashboard.txnKeys(tid, txnId)
    reply.header('Cache-Control', 'private, no-store')
    return { items }
  })
}

async function resolveTxnParams(
  req: { params: unknown },
  ctx: TransactionRouteContext,
  reply: Parameters<typeof problem>[0],
): Promise<{ tid: string | null; txnId: string | null }> {
  const params = req.params as { tid?: string; txnId?: string }
  const t = await resolveTenant(ctx.engine, ctx.tenants, reply, params.tid)
  if (t === null) return { tid: null, txnId: null }
  if (typeof params.txnId !== 'string' || !TXN_ID_RE.test(params.txnId)) {
    problem(reply, 400, 'bad-txn-id', 'expected UUID v4')
    return { tid: null, txnId: null }
  }
  return { tid: t.id, txnId: params.txnId }
}

function hashedIdempotency(key: string): string {
  if (key === '') return ''
  return `sha256:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

function bufferToHex(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('hex')
}

// Silence the unused-import warning for TxnTransition (we use it implicitly
// via the QueryOps return type).
type _Used<T> = T
type _ = _Used<TxnTransition>
