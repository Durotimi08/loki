import { describe, expect, it, vi } from 'vitest'
import { type Logger, NOOP_LOGGER, buildInstruments, consoleLogger } from '../src/index.js'

class CaptureLogger implements Logger {
  readonly records: { level: string; message: string; fields?: unknown }[] = []

  private push(level: string, message: string, fields?: unknown): void {
    this.records.push({ level, message, ...(fields !== undefined ? { fields } : {}) })
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.push('debug', message, fields)
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.push('info', message, fields)
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.push('warn', message, fields)
  }
  error(message: string, fieldsOrError?: unknown): void {
    this.push('error', message, fieldsOrError)
  }
  child(fields: Record<string, unknown>): Logger {
    return {
      debug: (m, f) => this.debug(m, { ...fields, ...f }),
      info: (m, f) => this.info(m, { ...fields, ...f }),
      warn: (m, f) => this.warn(m, { ...fields, ...f }),
      error: (m, fOrErr) => this.error(m, fOrErr),
      child: (extra) => this.child({ ...fields, ...extra }),
    }
  }
}

describe('Logger — NOOP_LOGGER', () => {
  it('every method is a quiet no-op', () => {
    NOOP_LOGGER.debug('x')
    NOOP_LOGGER.info('x', { a: 1 })
    NOOP_LOGGER.warn('x')
    NOOP_LOGGER.error('x', new Error('boom'))
    NOOP_LOGGER.error('x', { fields: 'are ok too' })
    expect(NOOP_LOGGER.child({ k: 'v' })).toBe(NOOP_LOGGER)
  })
})

describe('Logger — child binding', () => {
  it('child fields merge into every record on the child', () => {
    const cap = new CaptureLogger()
    const tenantLog = cap.child({ tenantId: 'org-1' })
    tenantLog.info('woke up', { batch: 7 })
    expect(cap.records).toEqual([
      { level: 'info', message: 'woke up', fields: { tenantId: 'org-1', batch: 7 } },
    ])
  })

  it('child of a child stacks fields', () => {
    const cap = new CaptureLogger()
    const r = cap.child({ tenantId: 'org-1' }).child({ requestId: 'req-9' })
    r.info('done')
    expect(cap.records[0]).toEqual({
      level: 'info',
      message: 'done',
      fields: { tenantId: 'org-1', requestId: 'req-9' },
    })
  })
})

describe('Logger — consoleLogger()', () => {
  it('emits one JSON line per record on stdout/stderr', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const log = consoleLogger()
      log.info('hello', { count: 3 })
      log.error('boom', new Error('explode'))

      const stdoutLines = stdout.mock.calls.flat() as string[]
      const stderrLines = stderr.mock.calls.flat() as string[]

      // info → stdout
      expect(stdoutLines).toHaveLength(1)
      const info = JSON.parse((stdoutLines[0] ?? '').trim())
      expect(info.level).toBe('info')
      expect(info.msg).toBe('hello')
      expect(info.count).toBe(3)
      expect(typeof info.time).toBe('string')

      // error → stderr (so a process supervisor can route differently)
      expect(stderrLines).toHaveLength(1)
      const err = JSON.parse((stderrLines[0] ?? '').trim())
      expect(err.level).toBe('error')
      expect(err.msg).toBe('boom')
      expect(err.err.message).toBe('explode')
      expect(typeof err.err.stack).toBe('string')
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }
  })

  it('respects the level threshold', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const log = consoleLogger({ level: 'warn' })
      log.debug('quiet')
      log.info('quiet')
      log.warn('loud')
      // Only the warn record should land. Stdout sees nothing because
      // warn routes to stderr.
      expect(stdout.mock.calls).toHaveLength(0)
    } finally {
      stdout.mockRestore()
    }
  })

  it('child fields show up in the JSON output', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const root = consoleLogger()
      const tenantLog = root.child({ tenantId: 'org-x' })
      tenantLog.info('ok')
      const firstCall = stdout.mock.calls[0] ?? []
      const lines = (firstCall as unknown[]).flat() as string[]
      const line = lines[0] ?? ''
      const record = JSON.parse(line.trim())
      expect(record.tenantId).toBe('org-x')
    } finally {
      stdout.mockRestore()
    }
  })
})

describe('Logger — buildInstruments wiring', () => {
  it('falls back to NOOP_LOGGER when none is supplied', () => {
    const instr = buildInstruments()
    // The component scope is added by buildInstruments — NOOP_LOGGER
    // returns itself from .child, so the resolved logger is still
    // the noop singleton.
    expect(instr.logger).toBe(NOOP_LOGGER)
  })

  it('threads the supplied logger through (with a component child binding)', () => {
    const cap = new CaptureLogger()
    const instr = buildInstruments(undefined, undefined, cap)
    instr.logger.info('engine event', { kind: 'startup' })
    expect(cap.records[0]).toEqual({
      level: 'info',
      message: 'engine event',
      fields: { component: 'loki', kind: 'startup' },
    })
  })
})
