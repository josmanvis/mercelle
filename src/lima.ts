import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MercelleError } from './errors.js'
import { c, consoleLogger } from './logger.js'
import type { Logger, OrbResult, VmBackend } from './types.js'

export interface LimaOptions {
  bin?: string
  logger?: Logger
  dryRun?: boolean
  /** Where Lima keeps instance configs. Defaults to ~/.lima. */
  limaHome?: string
}

/** Linux templates Lima ships for the distros mercelle supports. */
const LIMA_TEMPLATES: Record<string, string> = {
  ubuntu: 'ubuntu',
  debian: 'debian',
  fedora: 'fedora',
  arch: 'arch',
  alma: 'almalinux',
  rocky: 'rocky',
  amazonlinux: 'amazonlinux',
  oracle: 'oracle',
  opensuse: 'opensuse',
}

/**
 * Lima backend: runs a real Linux VM using QEMU/virtualization.framework.
 *
 * This is the fallback for Intel Macs that cannot run OrbStack (OrbStack needs
 * macOS 13+ on Apple Silicon or a newer Intel Mac). Lima's VM semantics match
 * what mercelle needs: a real Linux userland, real filesystem, real ports.
 */
export class Lima implements VmBackend {
  readonly name = 'lima'
  readonly bin: string
  private readonly log: Logger
  private readonly dryRun: boolean
  private readonly home: string

  constructor(opts: LimaOptions = {}) {
    this.bin = opts.bin ?? process.env.MERCELLE_LIMA_BIN ?? 'limactl'
    this.log = opts.logger ?? consoleLogger
    this.dryRun = opts.dryRun ?? false
    this.home = opts.limaHome ?? join(homedir(), '.lima')
  }

  async isInstalled(): Promise<boolean> {
    if (this.bin.includes('/') && !existsSync(this.bin)) return false
    const res = this.raw(['--version'], { allowFailure: true })
    return res.code === 0
  }

  /** Run limactl directly. */
  private raw(args: string[], opts: { allowFailure?: boolean; input?: Buffer } = {}): OrbResult {
    const display = `limactl ${args.join(' ')}`
    if (this.dryRun) {
      this.log.info(c.dim(`[dry-run] ${display}`))
      return { code: 0, stdout: '', stderr: '' }
    }
    const res = spawnSync(this.bin, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
      // `input` supplies data to pipe; otherwise close stdin so the remote
      // command sees EOF and cannot hang waiting for input.
      input: opts.input ?? '',
    })
    if (res.error) throw new MercelleError(`Failed to run ${this.bin}: ${res.error.message}`)
    const result: OrbResult = {
      code: res.status ?? 1,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    }
    if (result.code !== 0 && !opts.allowFailure) {
      throw new MercelleError(`Command failed: ${display}`, [result.stderr.trim()])
    }
    return result
  }

  async create(machine: string, distro: string, opts: { cpus?: number; memory?: number; disk?: string } = {}): Promise<void> {
    const template = LIMA_TEMPLATES[distro] ?? 'ubuntu'
    const args = [
      'create',
      '--name',
      machine,
      '--tty=false',
      `--cpus=${opts.cpus ?? 4}`,
      `--memory=${opts.memory ?? 8}`,
      `--disk=${opts.disk ?? '64GiB'}`,
      `template://${template}`,
    ]
    this.log.step(`Creating Lima VM ${machine} (${template})…`)
    this.raw(args)
  }

  async run(machine: string, command: string, opts: { stream?: boolean; allowFailure?: boolean; input?: Buffer } = {}): Promise<OrbResult> {
    // `limactl shell` is interactive by default; --tty=false keeps it scriptable.
    return this.raw(['shell', machine, '--tty=false', 'bash', '-lc', command], opts)
  }

  async start(machine: string): Promise<void> {
    this.raw(['start', machine], { allowFailure: true })
  }

  async stop(machine: string): Promise<void> {
    this.raw(['stop', machine], { allowFailure: true })
  }

  async remove(machine: string): Promise<void> {
    this.raw(['delete', machine, '--force'], { allowFailure: true })
  }

  async list(): Promise<string[]> {
    const res = this.raw(['list', '--json'], { allowFailure: true })
    if (res.code !== 0) return []
    try {
      const parsed: unknown = JSON.parse(res.stdout)
      const arr = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { instances?: unknown }).instances)
          ? ((parsed as { instances: unknown[] }).instances as unknown[])
          : []
      return arr
        .map((i) => (typeof i === 'string' ? i : ((i as { name?: string })?.name ?? '')))
        .filter(Boolean)
    } catch {
      return []
    }
  }

  /** Start a long-running command in the VM. */
  spawn(machine: string, command: string, handlers: { onStdout?: (c: Buffer) => void; onStderr?: (c: Buffer) => void; onClose?: (code: number) => void }): { kill: (signal?: NodeJS.Signals) => boolean } | null {
    if (this.dryRun) {
      this.log.info(c.dim(`[dry-run] limactl shell ${machine} …`))
      return null
    }
    const child = spawn(this.bin, ['shell', machine, '--tty=false', 'bash', '-lc', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', handlers.onStdout ?? (() => {}))
    child.stderr?.on('data', handlers.onStderr ?? (() => {}))
    child.on('close', (code) => handlers.onClose?.(code ?? 0))
    return child
  }

  /**
   * Lima forwards guest ports to the host automatically, so there is no
   * hostname to configure the way OrbStack's `config set` does. Ports land on
   * localhost:<port> on the host.
   */
  async setHttpPort(): Promise<void> {
    /* no-op: Lima forwards ports automatically */
  }

  installHint(): string[] {
    return [
      'Install Lima:  brew install lima',
      'Then re-run:    mercelle dev',
    ]
  }
}
