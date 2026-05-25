/**
 * RFC 7807 problem+json error handler — DASHBOARD.md §8.7, T28 / T29.
 *
 * Replaces Fastify's default error response with a stable problem doc.
 * Strips stack traces, SQL fragments, internal paths — operators read
 * problem docs from the wire, debug logs from `engine.instruments.logger`.
 *
 * Also overrides the 404 handler so a probe like `GET /admin.php`
 * returns the same shape as a real error, not a Fastify default body
 * (which leaks the framework name on some versions).
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Logger as LokiLogger } from '@loki/core'

export type ProblemDoc = {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail?: string
}

export function registerProblemHandler(
  app: FastifyInstance,
  logger: LokiLogger,
): void {
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    reply
      .code(404)
      .type('application/problem+json')
      .header('Cache-Control', 'private, no-store')
      .send(notFound(req))
  })

  app.setErrorHandler((error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const code = pickStatus(error)
    // Server-side: full fidelity. Wire-side: sanitised.
    if (code >= 500) {
      logger.error('dashboard request error', {
        reqId: req.id,
        method: req.method,
        path: req.url,
        err: error.message,
        stack: error.stack ?? null,
      })
    } else {
      logger.warn('dashboard request error', {
        reqId: req.id,
        method: req.method,
        path: req.url,
        status: code,
        code: error.code ?? null,
      })
    }
    if (reply.sent) return
    reply
      .code(code)
      .type('application/problem+json')
      .header('Cache-Control', 'private, no-store')
      .send(toProblem(error, code))
  })
}

function pickStatus(error: FastifyError): number {
  const fromError = (error as { statusCode?: number }).statusCode
  if (typeof fromError === 'number' && fromError >= 400 && fromError < 600) return fromError
  return 500
}

function toProblem(error: FastifyError, status: number): ProblemDoc {
  // Map Fastify validation errors (Ajv) to bad-request.
  if (status === 400) {
    return {
      type: 'https://loki.dev/problems/bad-request',
      title: 'Bad Request',
      status: 400,
      detail: 'Request did not match the expected shape.',
    }
  }
  if (status === 404) {
    return {
      type: 'https://loki.dev/problems/not-found',
      title: 'Not Found',
      status: 404,
    }
  }
  if (status === 405) {
    return {
      type: 'https://loki.dev/problems/method-not-allowed',
      title: 'Method Not Allowed',
      status: 405,
    }
  }
  if (status === 413) {
    return {
      type: 'https://loki.dev/problems/payload-too-large',
      title: 'Payload Too Large',
      status: 413,
    }
  }
  if (status === 415) {
    return {
      type: 'https://loki.dev/problems/unsupported-media-type',
      title: 'Unsupported Media Type',
      status: 415,
    }
  }
  if (status === 429) {
    return {
      type: 'https://loki.dev/problems/rate-limited',
      title: 'Too Many Requests',
      status: 429,
    }
  }
  if (status >= 500) {
    return {
      type: 'https://loki.dev/problems/internal',
      title: 'Internal Server Error',
      status: 500,
    }
  }
  return {
    type: 'https://loki.dev/problems/error',
    title: 'Error',
    status,
  }
}

function notFound(_req: FastifyRequest): ProblemDoc {
  return {
    type: 'https://loki.dev/problems/not-found',
    title: 'Not Found',
    status: 404,
  }
}
