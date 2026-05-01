/**
 * Tiny IO abstraction so commands can be tested without touching the
 * real `process.stdout` / `process.stderr` / `process.exit`.
 */
export type Io = {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

export const stdIo: Io = {
  out: (line) => {
    process.stdout.write(`${line}\n`)
  },
  err: (line) => {
    process.stderr.write(`${line}\n`)
  },
}

export function bufferedIo(): Io & {
  readonly stdout: () => string
  readonly stderr: () => string
} {
  const outLines: string[] = []
  const errLines: string[] = []
  return {
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    stdout: () => outLines.join('\n'),
    stderr: () => errLines.join('\n'),
  }
}
