import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 * Normalise a disk size to the number of GiB that `limactl create --disk`
 * expects (the flag is a bare float32, in GiB).
 *
 * The config uses OrbStack/Vercel-style sizes like `64GB`; Lima takes neither
 * a unit suffix nor `GB`.
 */
export function toLimaDiskGiB(size: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?i?b?)\s*$/i.exec(size)
  if (!match) return 64

  const value = Number(match[1])
  const unit = (match[2] ?? 'GiB').toLowerCase()

  // Convert to GiB. Binary units divide straight down; decimal units are ~7% smaller.
  const toGiB: Record<string, number> = {
    b: 1 / 1024 ** 3,
    kb: 1 / 1024 ** 2,
    mb: 1 / 1024,
    gb: 1,
    tb: 1024,
    kib: 1 / 1024 ** 2,
    mib: 1 / 1024,
    gib: 1,
    tib: 1024,
  }
  const gib = value * (toGiB[unit] ?? 1)
  // Keep at least 1GiB: QEMU/Lima cannot create a usable disk below that, and a
  // fractional request would otherwise round to zero and fail.
  return gib < 1 ? 1 : Math.round(gib * 10) / 10
}

/**
 * Decide which Lima VM driver to use.
 *
 * Lima defaults to `vz` (Apple Virtualization.framework), which exists only on
 * Apple Silicon. Intel Macs must use `qemu`. Ask Lima which drivers it actually
 * supports and fall back to `qemu`, the portable option.
 */
export function detectVmType(exec: (args: string[]) => { code: number; stdout: string }): string {
  try {
    const res = exec(['create', '--list-drivers'])
    const drivers = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)

    // Prefer vz when offered (faster); otherwise qemu.
    if (drivers.includes('vz')) return 'vz'
    if (drivers.includes('qemu')) return 'qemu'
  } catch {
    // fall through to the safe default
  }
  return 'qemu'
}

/**
 * Parse the output of `limactl list --json` into instance names.
 *
 * Lima emits newline-delimited JSON — one self-contained object per instance,
 * not a JSON array — so this cannot use `JSON.parse` on the whole payload.
 * A malformed line is skipped rather than failing the whole listing, because a
 * single unparseable instance should not hide every other VM.
 */
export function parseLimaList(stdout: string): string[] {
  const names: string[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry = JSON.parse(trimmed) as { name?: unknown }
      if (typeof entry.name === 'string' && entry.name) names.push(entry.name)
    } catch {
      // Not a JSON line (a stray warning, a log line); ignore it.
    }
  }
  return names
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
    // A long script (the toolchain installer) would otherwise be dumped in full
    // on failure, burying the one line that says what actually went wrong.
    const joined = args.join(' ')
    const display = joined.length > 160 ? `${joined.slice(0, 157)}…` : joined
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
    // `vz` only exists on Apple Silicon; Intel Macs need `qemu`.
    const vmType = detectVmType((args) => this.raw(args, { allowFailure: true }))
    const args = [
      'create',
      '--name',
      machine,
      '--tty=false',
      `--vm-type=${vmType}`,
      `--cpus=${opts.cpus ?? 4}`,
      `--memory=${opts.memory ?? 8}`,
      // `--disk` is a bare number of GiB; it rejects any unit suffix.
      `--disk=${toLimaDiskGiB(opts.disk ?? '64GB')}`,
      // Lima 2.x expects `template:ubuntu`; the `://` form is deprecated.
      `template:${template}`,
    ]
    this.log.step(`Creating Lima VM ${machine} (${template}, ${vmType})…`)
    this.raw(args)
  }

  async run(machine: string, command: string, opts: { stream?: boolean; allowFailure?: boolean; input?: Buffer } = {}): Promise<OrbResult> {
    // `limactl shell` is interactive by default; --tty=false keeps it scriptable.
    // The flag must precede the instance name — anything after it is forwarded
    // to the guest command, so a trailing --tty=false is passed to bash itself.
    return this.raw(['shell', '--tty=false', machine, 'bash', '-lc', command], opts)
  }

  async start(machine: string): Promise<void> {
    // A failed start used to be swallowed here, so mercelle carried on and
    // failed much later with a confusing "instance is stopped" error from an
    // unrelated command. Surface the real reason now.
    const res = this.raw(['start', machine], { allowFailure: true })
    if (res.code !== 0) {
      const why = (res.stderr || res.stdout).trim()
      // The overwhelmingly common cause: qemu is not installed on the PATH.
      if (/qemu-system|failed to find the QEMU binary/i.test(why)) {
        throw new MercelleError(
          `Cannot start ${machine}: the QEMU binary is not on your PATH.`,
          [
            'Lima needs qemu-system-x86_64 (or the right arch) to run this VM.',
            '  brew install qemu',
            'Or install OrbStack, which mercelle prefers:  https://orbstack.dev/download',
          ],
        )
      }
      throw new MercelleError(`Failed to start ${machine}.`, [why.split('\n').slice(-3).join('\n')])
    }
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
      return parseLimaList(res.stdout)
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
    const child = spawn(this.bin, ['shell', '--tty=false', machine, 'bash', '-lc', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', handlers.onStdout ?? (() => {}))
    child.stderr?.on('data', handlers.onStderr ?? (() => {}))
    child.on('close', (code) => handlers.onClose?.(code ?? 0))
    return child
  }

  /**
   * Honour a custom host port.
   *
   * Lima's automatic forwarding maps guest:<port> to host:<port>, so without
   * this a `--host-port` different from `--port` never opens and the user gets
   * a connection refused on the URL mercelle just printed. Lima has no runtime
   * "set port" command, so the rule is written into lima.yaml and picked up
   * when the instance restarts.
   */
  async setHttpPort(machine: string, hostPort: number, guestPort = hostPort): Promise<void> {
    if (hostPort === guestPort) return // automatic forwarding already matches

    const yamlPath = join(this.home, machine, 'lima.yaml')
    if (!existsSync(yamlPath)) return

    let yaml: string
    try {
      yaml = readFileSync(yamlPath, 'utf8')
    } catch {
      return
    }

    this.log.step(`Forwarding guest:${guestPort} to localhost:${hostPort}…`)
    // Drop any rule this backend previously wrote, then append the current one.
    // Lima applies the last matching rule, so one managed block is enough.
    const block = [
      'portForwards:',
      `  - guestPort: ${guestPort}`,
      `    hostPort: ${hostPort}`,
      '    proto: "tcp"',
      '',
    ].join('\n')

    const withoutManaged = yaml.replace(
      /\n?portForwards:\n(?:[ \t]+-[^\n]*\n|[ \t]+[^\n]*\n)*/g,
      '\n',
    )
    const updated = `${withoutManaged.replace(/\n+$/, '\n')}${block}`
    try {
      writeFileSync(yamlPath, updated)
    } catch (err) {
      throw new MercelleError(`Could not set up port forwarding for ${machine}.`, [
        (err as Error).message,
        `Add this to ${yamlPath} by hand:`,
        `  portForwards:\n    - guestPort: ${guestPort}\n      hostPort: ${hostPort}\n      proto: "tcp"`,
      ])
    }

    // Lima reads portForwards when the VM boots, so a rule written while it is
    // already running does nothing until the next start. Saying so beats letting
    // the user discover it as a dead port.
    if (this.isRunning(machine)) {
      this.log.warn(
        `Port ${guestPort} → ${hostPort} takes effect after the VM restarts: mercelle down && mercelle up`,
      )
    }
  }

  /**
   * True when the instance is currently running.
   *
   * Best effort by design: it only decides whether to print a warning, so a
   * missing or broken `limactl` must return false rather than throw. The port
   * forward itself is already written by the time this is called.
   */
  private isRunning(machine: string): boolean {
    try {
      const res = this.raw(['list', '--json'], { allowFailure: true })
      if (res.code !== 0) return false
      for (const line of res.stdout.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as { name?: string; status?: string }
          if (entry.name === machine) return entry.status === 'Running'
        } catch {
          /* an unparseable line is not this machine */
        }
      }
    } catch {
      /* the binary is missing or unusable: stay quiet */
    }
    return false
  }

  installHint(): string[] {
    return [
      'Install Lima:  brew install lima',
      'Then re-run:    mercelle dev',
    ]
  }
}
