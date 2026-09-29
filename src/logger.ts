import type { Logger } from './types.js'

const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.MERCELLE_NO_COLOR === undefined &&
  process.env.TERM !== 'dumb'

const paint = (code: string, text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text)

export const c = {
  bold: (s: string) => paint('1', s),
  dim: (s: string) => paint('2', s),
  red: (s: string) => paint('31', s),
  green: (s: string) => paint('32', s),
  yellow: (s: string) => paint('33', s),
  blue: (s: string) => paint('34', s),
  magenta: (s: string) => paint('35', s),
  cyan: (s: string) => paint('36', s),
  gray: (s: string) => paint('90', s),
}

/** Terminal control helpers, no-ops when not attached to a TTY. */
export const term = {
  isTTY: Boolean(process.stdout.isTTY),
  clearLine(): void {
    if (process.stdout.isTTY) process.stdout.write('\u001b[2K\r')
  },
}

const PREFIX = 'mercelle'

/** Default logger: writes prefixed, colored lines to stderr. */
export const consoleLogger: Logger = {
  info: (msg) => console.error(`${c.cyan(PREFIX)} ${msg}`),
  success: (msg) => console.error(`${c.green('✓')} ${msg}`),
  warn: (msg) => console.error(`${c.yellow('!')} ${msg}`),
  error: (msg) => console.error(`${c.red('✗')} ${msg}`),
  step: (msg) => console.error(`${c.gray('▸')} ${c.dim(msg)}`),
  // Unprefixed: used for streaming child process output verbatim.
  raw: (msg) => process.stdout.write(msg),
}

/** A logger that records messages instead of printing. Used by the test suite. */
export function createMemoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  const push = (prefix: string) => (msg: string) => void lines.push(`${prefix}${msg}`)
  return {
    lines,
    info: push(''),
    success: push('✓ '),
    warn: push('! '),
    error: push('✗ '),
    step: push('▸ '),
    raw: push(''),
  }
}
