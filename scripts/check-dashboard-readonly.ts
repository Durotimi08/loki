#!/usr/bin/env tsx
/**
 * CI lint — enforces the read-only and no-injection structural
 * invariants for the dashboard subtree (DASHBOARD.md §8.10 layer 1,
 * §8.19.11, §8.19.14).
 *
 * Walks every `.ts` file under `packages/cli/src/dashboard/**` using
 * the TypeScript compiler's AST (NOT regex — substring matches in
 * comments and strings would produce false positives). Fails on:
 *
 *   1. Imports of forbidden Node modules (`child_process`, `vm`, …)
 *   2. Imports from `@loki/core` outside an explicit allowlist
 *   3. `createEngine` imported anywhere except `read-engine.ts`
 *   4. `engine.connection.sql` accessed outside `read-engine.ts`
 *   5. Write surfaces (`engine.transactions.*`, `engine.holds.place`, …)
 *   6. `eval()`, `new Function()`, `setTimeout(<string>, …)`,
 *      `setInterval(<string>, …)`
 *   7. `as any` / `as unknown` cast over an engine-typed value
 *
 * Subtrees that are *deliberately* exempt (they carry their own
 * structural safety):
 *   - `dashboard/actions/**` — gated by the M8 twelve-layer machinery
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

// =============================================================================
// Configuration
// =============================================================================

const ROOT = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..')
const DASHBOARD_ROOT = join(ROOT, 'packages/cli/src/dashboard')

const SKIP_SUBDIRS = new Set(['actions'])

const FORBIDDEN_MODULES = new Set([
  'node:child_process', 'child_process',
  'node:vm', 'vm',
  'node:worker_threads', 'worker_threads',
  'node:repl', 'repl',
  'node:cluster', 'cluster',
  'node:http', 'http',
  'node:https', 'https',
  'undici', 'node-fetch', 'axios', 'got', 'request',
])

const CORE_ALLOWLIST = new Set([
  'createEngine',
  'LOKI_CORE_VERSION',
  'sha256Hasher', 'Hasher',
  'NOOP_LOGGER', 'NOOP_METRICS', 'NOOP_TRACER',
  'Logger', 'LogFields', 'LogLevel',
  'MetricsAdapter', 'Tracer', 'EngineInstruments',
  'Counter', 'Histogram', 'Gauge', 'MetricLabels', 'Span', 'SpanStatus',
  'LokiError', 'CompromisedRecordError',
  'IllegalStateTransitionError', 'OverdraftError',
  'UnbalancedPostingsError', 'UnknownTransitionError',
  'AccountAggregate', 'AccountAggregateArgs', 'AccountAggregateMetric',
  'AccountHistoryArgs', 'AccountQueryOps', 'AccountRow', 'AccountIdentity',
  'ActorRef', 'ActorScopedOps', 'ActorSummary',
  'AdminOps', 'AmountFilter',
  'AnomalyCheckName', 'AnomalyRow', 'AnomalySeverity',
  'ConnectionInput', 'Cursor', 'DateLike', 'DatabaseHealth',
  'Engine', 'EnginePosting',
  'FindManyAnomaliesArgs', 'FindManyPostingsArgs',
  'FindManyTransactionsArgs', 'FindManyTransitionsArgs',
  'HealthCheckOptions', 'HealthReport', 'Page', 'Posting',
  'QueryOps', 'ReplicaHealth', 'SchemaDef',
  'TenantClient', 'TenantRow', 'TenantSnapshot',
  'TxnRecord', 'TxnTransition', 'VerifyResult',
  // Ops surfaces — typed identities only; the actual write methods
  // (place / open / cancel / etc.) are flagged separately.
  'Dispute', 'DisputeStatus',
  'FxRate', 'FxRateHistoryInput',
  'Hold', 'HoldStatus',
  'ListScheduledFilter',
  'ScheduledTransition', 'ScheduledTransitionStatus',
])

const CREATE_ENGINE_ALLOWED_FILES = new Set(['read-engine.ts'])
const RAW_SQL_ALLOWED_FILES = new Set(['read-engine.ts'])

// Write surfaces on the engine namespace. The lint never sees an
// `engine` value typed as the full Engine (the dashboard imports
// ReadEngine), but we still match these property names defensively in
// case someone smuggles via `as any`. The `as any` check (below) is
// the real defence; this is belt-and-braces.
const FORBIDDEN_ENGINE_WRITES = new Set([
  'connection',                  // engine.connection.sql / .asAdmin
  'transactions',                // engine.transactions.create / transition
  'adapters',
])
const FORBIDDEN_HOLDS = new Set(['place', 'release', 'expireDue'])
const FORBIDDEN_DISPUTES = new Set(['open', 'resolve', 'expireDue'])
const FORBIDDEN_OUTBOX = new Set(['startWorker', 'drainOnce', 'register'])
const FORBIDDEN_SCHEDULER = new Set(['create', 'cancel', 'startWorker'])

const FORBIDDEN_CALLS = new Set(['eval'])

// =============================================================================
// Walker
// =============================================================================

type Finding = {
  readonly file: string
  readonly line: number
  readonly message: string
}

function walk(dir: string, acc: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (SKIP_SUBDIRS.has(name)) continue
      walk(full, acc)
    } else if (name.endsWith('.ts')) acc.push(full)
  }
  return acc
}

function hasAllowComment(sf: ts.SourceFile, node: ts.Node): boolean {
  // Honour `// loki-dashboard: allow-<reason>` on the line BEFORE or on
  // the same line as the offending node. Implemented by scanning leading
  // trivia.
  const text = sf.text
  const ranges = ts.getLeadingCommentRanges(text, node.pos)
  if (ranges === undefined) return false
  for (const r of ranges) {
    if (/\/\/\s*loki-dashboard:\s*allow-/.test(text.slice(r.pos, r.end))) return true
  }
  return false
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function checkFile(file: string): Finding[] {
  const findings: Finding[] = []
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS)
  const fileName = file.split('/').pop() ?? file

  const push = (node: ts.Node, message: string): void => {
    if (hasAllowComment(sf, node)) return
    findings.push({ file, line: lineOf(sf, node), message })
  }

  function visit(node: ts.Node): void {
    // ----- imports -----
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier
      if (ts.isStringLiteral(spec)) {
        const from = spec.text
        if (FORBIDDEN_MODULES.has(from)) {
          push(node, `forbidden module import: '${from}'`)
        }
        if (from === '@loki/core') {
          const clause = node.importClause
          if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              // `import { X as Y }` — X is the actual core symbol.
              const sym = (el.propertyName ?? el.name).text
              if (!CORE_ALLOWLIST.has(sym)) {
                push(el, `'${sym}' is not in the @loki/core read allowlist`)
              }
              if (sym === 'createEngine' && !CREATE_ENGINE_ALLOWED_FILES.has(fileName)) {
                push(
                  el,
                  `createEngine may only be imported in: ${[...CREATE_ENGINE_ALLOWED_FILES].join(', ')}`,
                )
              }
            }
          } else if (clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
            push(clause.namedBindings, '`import * as` from @loki/core is forbidden')
          }
        }
      }
    }

    // ----- dynamic import('...') -----
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [arg] = node.arguments
        if (arg !== undefined && ts.isStringLiteral(arg) && FORBIDDEN_MODULES.has(arg.text)) {
          push(node, `forbidden dynamic import: '${arg.text}'`)
        }
      }
      // ----- call-expression-level checks: eval, Function, setTimeout(<string>, ...) -----
      if (ts.isIdentifier(node.expression) && FORBIDDEN_CALLS.has(node.expression.text)) {
        push(node, `${node.expression.text}() is forbidden in dashboard/`)
      }
      if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'setTimeout' || node.expression.text === 'setInterval')
      ) {
        const [firstArg] = node.arguments
        if (firstArg !== undefined && (ts.isStringLiteralLike(firstArg) || ts.isTemplateLiteral(firstArg))) {
          push(node, `${node.expression.text}(<string>, …) is forbidden — pass a function instead`)
        }
      }
    }

    // ----- new Function(...) -----
    if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
        push(node, 'new Function() is forbidden in dashboard/')
      }
    }

    // ----- engine.<forbidden> reads -----
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const outer = node                       // e.g. engine.holds.place
      const inner = node.expression            // engine.holds
      if (
        ts.isIdentifier(inner.expression) &&
        inner.expression.text === 'engine' &&
        ts.isIdentifier(inner.name) &&
        ts.isIdentifier(outer.name)
      ) {
        const ns = inner.name.text
        const member = outer.name.text
        if (ns === 'connection' && member === 'sql' && !RAW_SQL_ALLOWED_FILES.has(fileName)) {
          push(node, `engine.connection.sql (raw SQL) is forbidden outside: ${[...RAW_SQL_ALLOWED_FILES].join(', ')}`)
        }
        if (ns === 'holds' && FORBIDDEN_HOLDS.has(member)) {
          push(node, `engine.holds.${member} is a write surface; forbidden`)
        }
        if (ns === 'disputes' && FORBIDDEN_DISPUTES.has(member)) {
          push(node, `engine.disputes.${member} is a write surface; forbidden`)
        }
        if (ns === 'outbox' && FORBIDDEN_OUTBOX.has(member)) {
          push(node, `engine.outbox.${member} is forbidden`)
        }
        if (ns === 'scheduler' && FORBIDDEN_SCHEDULER.has(member)) {
          push(node, `engine.scheduler.${member} is a write; forbidden`)
        }
      }
    }
    // engine.transactions.* / engine.connection.* / engine.adapters as a whole
    if (ts.isPropertyAccessExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'engine' &&
        ts.isIdentifier(node.name)
      ) {
        const member = node.name.text
        if (FORBIDDEN_ENGINE_WRITES.has(member)) {
          // engine.connection is allowed only inside the carve-out for
          // .sql (above); a bare engine.connection access elsewhere is
          // still suspect, but we let .sql carry the targeted rule.
          if (member === 'connection') {
            // wait for the .sql check above; don't double-fire
          } else {
            push(node, `engine.${member} is a write surface; forbidden`)
          }
        }
      }
    }

    // ----- `as any` / `as unknown` over engine types -----
    if (ts.isAsExpression(node)) {
      const t = node.type
      if (
        (t.kind === ts.SyntaxKind.AnyKeyword || t.kind === ts.SyntaxKind.UnknownKeyword) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'engine'
      ) {
        push(node, '`engine as any / as unknown` is forbidden — narrow via ReadEngine')
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sf)
  return findings
}

// =============================================================================
// Main
// =============================================================================

function main(): number {
  let files: string[] = []
  try {
    files = walk(DASHBOARD_ROOT, [])
  } catch (e) {
    console.error(`dashboard lint: cannot read ${DASHBOARD_ROOT}: ${(e as Error).message}`)
    return 1
  }

  const findings: Finding[] = []
  for (const f of files) findings.push(...checkFile(f))

  if (findings.length === 0) {
    console.log(`dashboard lint: OK (${files.length} files checked).`)
    return 0
  }

  console.error(`dashboard lint: ${findings.length} violation(s):\n`)
  for (const f of findings) {
    const rel = relative(ROOT, f.file)
    console.error(`  ${rel}:${f.line}: ${f.message}`)
  }
  return 1
}

process.exit(main())
