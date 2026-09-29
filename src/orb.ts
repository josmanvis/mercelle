import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { MercelleError, OrbCommandError, OrbStackMissingError } from './errors.js'
import { c, consoleLogger } from './logger.js'
import type { Distro, Logger, OrbResult } from './types.js'

export interface OrbOptions {
  /** Path to the `orb` binary. Defaults to `orb` on PATH. */
  bin?: string
  logger?: Logger
  /** Print commands instead of running them. */
  dryRun?: boolean
}

export interface RunOptions {
  /** Stream output live to the terminal. */
  stream?: boolean
  /** Called for each streamed line. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  /** Inherit the parent stdio (interactive shells, TTY apps). */
  stdio?: 'pipe' | 'inherit'
  /** Extra environment for the child process. */
  env?: NodeJS.ProcessEnv
  /** Do not throw on a non-zero exit code. */
  allowFailure?: boolean
  /** Data written to the child's stdin, then closed. Used to stream archives. */
  input?: Buffer
  cwd?: string
}

/**
 * Thin, typed wrapper around the OrbStack `orb` CLI.
 *
 * Every call shells out to `orb` rather than using OrbStack internals, so
 * mercelle works with any OrbStack version that supports the `orb` command
 * surface, and can be tested against a stub binary.
 */
export class Orb {
  readonly bin: string
  private readonly log: Logger
  private readonly dryRun: boolean

  constructor(opts: OrbOptions = {}) {
    this.bin = opts.bin ?? process.env.MERCELLE_ORB_BIN ?? 'orb'
    this.log = opts.logger ?? consoleLogger
    this.dryRun = opts.dryRun ?? false
  }

  /** Human-readable form of a command, for logs and errors. */
  static formatCommand(bin: string, args: string[]): string {
    const quote = (s: string) => (/[\s"'$`\\]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s)
    return [bin, ...args].map(quote).join(' ')
  }

  /** True when the orb binary can be found. */
  async isInstalled(): Promise<boolean> {
    if (this.bin !== 'orb' && this.bin.includes('/')) return existsSync(this.bin)
    const res = await this.exec(['version'], { allowFailure: true })
    return res.code === 0
  }

  /** Run an `orb` subcommand and capture output. Throws unless `allowFailure`. */
  async exec(args: string[], opts: RunOptions = {}): Promise<OrbResult> {
    const display = Orb.formatCommand(this.bin, args)
    if (opts.stream) this.log.step(display)

    if (this.dryRun) {
      this.log.info(c.dim(`[dry-run] ${display}`))
      return { code: 0, stdout: '', stderr: '' }
    }

    const result = await new Promise<OrbResult>((resolve, reject) => {
      const child = spawn(this.bin, args, {
        stdio: opts.stdio === 'inherit' ? 'inherit' : 'pipe',
        env: { ...process.env, ...opts.env },
        cwd: opts.cwd,
      })

      let stdout = ''
      let stderr = ''
      let spawnError: NodeJS.ErrnoException | null = null

      const attach = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        const text = chunk.toString()
        if (stream === 'stdout') stdout += text
        else stderr += text

        if (opts.onLine) {
          for (const line of text.split('\n')) {
            if (line.length > 0) opts.onLine(line, stream)
          }
        } else if (opts.stream && stream === 'stdout') {
          this.log.raw(text)
        }
      }

      child.stdout?.on('data', (chunk: Buffer) => attach(chunk, 'stdout'))
      child.stderr?.on('data', (chunk: Buffer) => attach(chunk, 'stderr'))
      child.on('error', (err: NodeJS.ErrnoException) => {
        spawnError = err
      })

      // Feed stdin (used to stream a tarball into the machine) and close it so
      // the remote command sees EOF and does not hang.
      if (opts.input && child.stdin) {
        child.stdin.on('error', () => {
          /* the child may exit before consuming all input */
        })
        child.stdin.end(opts.input)
      } else {
        child.stdin?.end()
      }

      child.on('close', (code) => {
        if (spawnError) {
          if (spawnError.code === 'ENOENT') reject(new OrbStackMissingError())
          else reject(new MercelleError(`Failed to run ${this.bin}: ${spawnError.message}`))
          return
        }
        resolve({ code: code ?? 0, stdout, stderr })
      })
    })

    if (result.code !== 0 && !opts.allowFailure) {
      throw new OrbCommandError(display, result)
    }
    return result
  }

  /** Run a shell command inside a machine. */
  async runInMachine(machine: string, command: string, opts: RunOptions = {}): Promise<OrbResult> {
    return this.exec(['run', '-m', machine, 'bash', '-lc', command], opts)
  }

  /**
   * Start a long-running command in a machine and return the live child process.
   *
   * Used for the dev server, which must be startable and stoppable by the
   * caller. Goes through the adapter so the configured binary and dry-run
   * behaviour are respected, rather than spawning `orb` behind its back.
   */
  spawnInMachine(
    machine: string,
    command: string,
    handlers: { onStdout?: (chunk: Buffer) => void; onStderr?: (chunk: Buffer) => void; onClose?: (code: number) => void },
  ): { kill: (signal?: NodeJS.Signals) => boolean; readonly pid?: number } | null {
    if (this.dryRun) {
      this.log.info(c.dim(`[dry-run] ${Orb.formatCommand(this.bin, ['run', '-m', machine, 'bash', '-lc', command])}`))
      return null
    }

    const child = spawn(this.bin, ['run', '-m', machine, 'bash', '-lc', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    child.stdout?.on('data', handlers.onStdout ?? (() => {}))
    child.stderr?.on('data', handlers.onStderr ?? (() => {}))
    child.on('error', (err) => this.log.error(`dev process error: ${err.message}`))
    child.on('close', (code) => handlers.onClose?.(code ?? 0))

    return child
  }

  /** Open an interactive shell in a machine (used by `mercelle shell`). */
  async shell(machine: string, user?: string): Promise<void> {
    const args = ['shell', '-m', machine]
    if (user) args.push('-u', user)
    await this.exec(args, { stdio: 'inherit' })
  }

  /** Create a Linux machine. */
  async createMachine(
    machine: string,
    distro: Distro,
    opts: { cpus?: number; memory?: number; disk?: string } = {},
  ): Promise<void> {
    const args = ['create', distro, machine]
    if (opts.cpus) args.push('--cpus', String(opts.cpus))
    if (opts.memory) args.push('--memory', String(opts.memory))
    if (opts.disk) args.push('--disk', String(opts.disk))
    await this.exec(args, { stream: true })
  }

  /** Start a machine if it is stopped. No-op when already running. */
  async start(machine: string): Promise<void> {
    await this.exec(['start', machine], { allowFailure: true })
  }

  /** Stop a machine. */
  async stop(machine: string): Promise<void> {
    await this.exec(['stop', machine], { allowFailure: true })
  }

  /** Delete a machine. */
  async deleteMachine(machine: string): Promise<void> {
    await this.exec(['delete', machine], { allowFailure: true })
  }

  /** List machine names. Tolerates both JSON and table output. */
  async listMachines(): Promise<string[]> {
    const res = await this.exec(['list', '--format', 'json'], { allowFailure: true })
    if (res.code !== 0) {
      const fallback = await this.exec(['list'], { allowFailure: true })
      return parseMachineList(fallback.stdout)
    }
    try {
      const parsed: unknown = JSON.parse(res.stdout)
      const arr = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { machines?: unknown }).machines)
          ? ((parsed as { machines: unknown[] }).machines as unknown[])
          : []
      return arr
        .map((m) => (typeof m === 'string' ? m : ((m as { name?: string })?.name ?? '')))
        .filter(Boolean)
    } catch {
      return parseMachineList(res.stdout)
    }
  }

  /** True if a machine with this name exists. */
  async machineExists(machine: string): Promise<boolean> {
    return (await this.listMachines()).includes(machine)
  }

  /** Ensure a machine exists and is running. */
  async ensureRunning(machine: string): Promise<void> {
    if (!(await this.machineExists(machine))) {
      throw new MercelleError(`OrbStack machine "${machine}" does not exist.`, [
        'Run `mercelle up` to create it.',
      ])
    }
    await this.start(machine)
  }

  /** Point `<machine>.orb.local` at the given http port. */
  async setHttpPort(machine: string, port: number): Promise<void> {
    await this.exec(['config', 'set', `machine.${machine}.http_port`, String(port)], {
      allowFailure: true,
    })
  }

  /** True when something is accepting connections on a host port. */
  static async isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
    const net = await import('node:net')
    return new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host })
      const done = (v: boolean) => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(v)
      }
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
    })
  }

  /** Poll until a host port responds, or the deadline passes. */
  static async waitForPort(port: number, timeoutMs = 90_000, host = '127.0.0.1'): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await Orb.isPortOpen(port, host)) return true
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }
}

/** Extract machine names from `orb list` table output. */
export function parseMachineList(stdout: string): string[] {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  const names: string[] = []
  for (const line of lines) {
    // Skip the header row, which holds column labels rather than machine names.
    if (/^(name|machine)\b/i.test(line)) continue
    if (/^[│|]/.test(line)) continue
    const first = line.split(/\s+/)[0]
    if (!first || first.startsWith('(')) continue
    names.push(first)
  }
  return names
}
