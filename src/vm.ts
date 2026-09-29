import { spawnSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { MercelleError } from './errors.js'
import { c, consoleLogger } from './logger.js'
import { Orb } from './orb.js'
import type { Logger, MercelleConfig, ResolvedProject } from './types.js'

/** Files and directories never copied into the VM. */
export const DEFAULT_IGNORES = [
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  '.mercelle',
  '.DS_Store',
  'coverage',
  '.vercel',
]

/** Node version installed inside the VM. Kept in one place so it is easy to bump. */
export const NODE_VERSION = '22'

/**
 * Map a macOS path to the same path as seen from inside an OrbStack machine.
 * OrbStack mounts the Mac filesystem at /mnt/mac.
 */
export function macPathInVm(macPath: string): string {
  return `/mnt/mac${macPath.startsWith('/') ? macPath : `/${macPath}`}`
}

export interface VmManagerOptions {
  orb: Orb
  config: MercelleConfig
  project: ResolvedProject
  logger?: Logger
}

/** A provisioned VM, plus the paths mercelle needs to run commands in it. */
export interface VmInfo {
  machine: string
  /** Absolute path of the project inside the VM. */
  remoteRoot: string
  /** Home directory of the VM user. */
  home: string
  /** True when this call created the machine. */
  created: boolean
}

/** Quote a value for safe use inside a single-quoted shell string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Owns the lifecycle of the OrbStack machine: create it, install a Linux
 * toolchain in it, and keep the project mirrored inside it.
 */
export class VmManager {
  private readonly orb: Orb
  private readonly config: MercelleConfig
  private readonly project: ResolvedProject
  private readonly log: Logger

  constructor(opts: VmManagerOptions) {
    this.orb = opts.orb
    this.config = opts.config
    this.project = opts.project
    this.log = opts.logger ?? consoleLogger
  }

  /**
   * Make sure a suitable machine exists and is running.
   * Honours `fresh` (rebuild) and `reuse` (don't destroy on failure).
   */
  async ensureMachine(): Promise<{ created: boolean }> {
    const { machine } = this.project
    const exists = await this.orb.machineExists(machine)

    if (exists && this.config.fresh) {
      this.log.info(`Rebuilding VM ${c.bold(machine)} (--fresh)…`)
      await this.orb.deleteMachine(machine)
      await this.orb.createMachine(machine, this.config.distro, {
        cpus: this.config.cpus,
        memory: this.config.memory,
        disk: this.config.disk,
      })
      await this.orb.start(machine)
      return { created: true }
    }

    if (!exists) {
      if (!this.config.reuse) {
        throw new MercelleError(`VM ${machine} is missing and reuse is disabled.`, ['Run `mercelle up` first.'])
      }
      this.log.info(`Creating ${c.bold(this.config.distro)} VM ${c.bold(machine)}…`)
      await this.orb.createMachine(machine, this.config.distro, {
        cpus: this.config.cpus,
        memory: this.config.memory,
        disk: this.config.disk,
      })
      await this.orb.start(machine)
      return { created: true }
    }

    this.log.step(`Reusing VM ${machine}`)
    await this.orb.start(machine)
    return { created: false }
  }

  /** The VM user's home directory, resolved at runtime. */
  async getHome(): Promise<string> {
    const res = await this.orb.runInMachine(this.project.machine, 'echo $HOME', { allowFailure: true })
    const home = res.stdout.trim()
    return home || '/home/mercelle'
  }

  /** True when the machine already has the Linux toolchain mercelle needs. */
  private async isProvisioned(): Promise<boolean> {
    const res = await this.orb.runInMachine(
      this.project.machine,
      'command -v node && command -v git && command -v curl >/dev/null 2>&1',
      { allowFailure: true },
    )
    return res.code === 0
  }

  /**
   * Install Node, git, build tools, and the package manager inside the VM.
   * This is what makes the environment genuinely Linux, which is the whole point.
   */
  async provision(): Promise<void> {
    if (!(await this.isProvisioned()) || this.config.reinstall) {
      this.log.info('Installing Linux toolchain in the VM (this happens once)…')
      await this.installToolchain()
    }

    const pm = this.project.packageManager
    if (pm !== 'npm') {
      const has = await this.orb.runInMachine(this.project.machine, `command -v ${pm}`, { allowFailure: true })
      if (has.code !== 0 || this.config.reinstall) {
        this.log.step(`Installing ${pm} in the VM…`)
        await this.installPackageManager(pm)
      }
    }
    this.log.success('VM is ready.')
  }

  /** Install distro packages, then Node via nvm, then corepack. */
  private async installToolchain(): Promise<void> {
    const machine = this.project.machine
    const script = [
      'set -e',
      'export DEBIAN_FRONTEND=noninteractive',
      // Debian/Ubuntu family.
      'if command -v apt-get >/dev/null 2>&1; then',
      '  sudo apt-get update -qq',
      '  sudo apt-get install -y -qq curl ca-certificates git build-essential python3 rsync tar >/dev/null',
      // Fedora/RHEL family.
      'elif command -v dnf >/dev/null 2>&1; then',
      '  sudo dnf install -y -q curl ca-certificates git gcc gcc-c++ make python3 rsync tar >/dev/null',
      'elif command -v pacman >/dev/null 2>&1; then',
      '  sudo pacman -Sy --noconfirm curl ca-certificates git base-devel python rsync tar >/dev/null',
      'fi',
      // Node via nvm so the version is explicit and easy to change.
      'export NVM_DIR="$HOME/.nvm"',
      'if [ ! -s "$NVM_DIR/nvm.sh" ]; then',
      '  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash',
      'fi',
      '. "$NVM_DIR/nvm.sh"',
      `nvm install ${NODE_VERSION} >/dev/null`,
      `nvm alias default ${NODE_VERSION} >/dev/null`,
      'nvm use default >/dev/null',
      // Make node available to non-interactive login shells.
      'PROFILE="$HOME/.bashrc"',
      'grep -q NVM_DIR "$PROFILE" 2>/dev/null || printf \'\\nexport NVM_DIR="$HOME/.nvm"\\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\\n\' >> "$PROFILE"',
      'corepack enable >/dev/null 2>&1 || true',
    ].join('\n')

    const res = await this.orb.runInMachine(machine, script, { stream: this.config.verbose })
    if (res.code !== 0) {
      throw new MercelleError('Failed to provision the VM toolchain.', [
        res.stderr.trim().split('\n').slice(-5).join('\n') || 'The install script exited non-zero.',
      ])
    }
  }

  /** Install a package manager globally inside the VM. */
  private async installPackageManager(pm: string): Promise<void> {
    const machine = this.project.machine
    const script = `set -e; . "$HOME/.nvm/nvm.sh"; corepack enable >/dev/null 2>&1 || true; corepack prepare ${pm}@latest --activate`
    const res = await this.orb.runInMachine(machine, script, { stream: this.config.verbose })

    if (res.code !== 0) {
      // Corepack is unavailable on some distros; fall back to the official installer.
      const fallback =
        pm === 'pnpm'
          ? 'curl -fsSL https://get.pnpm.io/install.sh | sh -'
          : pm === 'yarn'
            ? 'npm install -g yarn'
            : 'curl -fsSL https://bun.sh/install | bash'
      const retry = await this.orb.runInMachine(machine, `set -e; . "$HOME/.nvm/nvm.sh"; ${fallback}`, {
        stream: this.config.verbose,
      })
      if (retry.code !== 0) {
        throw new MercelleError(`Failed to install ${pm} inside the VM.`, [retry.stderr.trim()])
      }
    }
  }

  /**
   * Remote absolute path for the project.
   *
   * In `mount` mode the VM reads the project straight off the Mac's shared
   * filesystem at /mnt/mac, so no copy is needed and edits are visible
   * immediately. In `copy` mode the project is tarred into the VM's own disk.
   */
  async remoteRoot(home?: string): Promise<string> {
    if (this.config.sync === 'mount') return macPathInVm(this.project.root)
    const h = home ?? (await this.getHome())
    return `${h}/${this.project.remoteRoot}`
  }

  /** Where Linux node_modules live in the VM (always VM-local, never on the Mac). */
  async modulesDir(home?: string): Promise<string> {
    const h = home ?? (await this.getHome())
    return `${h}/.mercelle-modules/${this.project.machine}/node_modules`
  }

  /**
   * In mount mode, node_modules still has to be a Linux install: the project
   * directory itself lives on the Mac filesystem, so we point its node_modules
   * at a directory that lives on the VM's own disk.
   */
  async prepareMount(home?: string): Promise<void> {
    if (this.config.sync !== 'mount') return

    const h = home ?? (await this.getHome())
    const modules = await this.modulesDir(h)
    const link = join(this.project.root, 'node_modules')

    // Refuse to clobber a real macOS install: silently replacing it would be
    // destructive, and sharing Darwin binaries with Linux breaks native modules.
    const existing = lstatSync(link, { throwIfNoEntry: false })
    if (existing && !existing.isSymbolicLink()) {
      throw new MercelleError(
        'mount mode needs node_modules to be a symlink, but a real directory exists.',
        [
          `Move it aside first:  mv ${shellQuote(link)} ${shellQuote(`${link}.macos`)}`,
          'Then re-run `mercelle dev`.',
          'Or use the default copy mode: `mercelle dev --sync copy`.',
        ],
      )
    }

    this.log.step('Linking a Linux node_modules into the mounted project…')
    const script = [
      `set -e`,
      `mkdir -p ${shellQuote(modules)}`,
      // Only relink when the target is missing or already points somewhere else.
      `if [ ! -L ${shellQuote(link)} ] || [ "$(readlink ${shellQuote(link)})" != ${shellQuote(modules)} ]; then`,
      `  rm -rf ${shellQuote(link)}`,
      `  ln -s ${shellQuote(modules)} ${shellQuote(link)}`,
      `fi`,
    ].join('\n')

    const res = await this.orb.runInMachine(this.project.machine, script, { allowFailure: true })
    if (res.code !== 0) {
      throw new MercelleError('Failed to set up the Linux node_modules link for mount mode.', [
        res.stderr.trim() || 'Could not create the symlink inside the VM.',
      ])
    }
  }

  /** Excludes used when syncing, honouring the project's .gitignore-ish defaults. */
  private excludeArgs(): string {
    return DEFAULT_IGNORES.map((d) => `--exclude=${d}`).join(' ')
  }

  /**
   * Mirror the project into the VM using tar over stdin.
   * Excludes node_modules and build output: dependencies are installed inside
   * the VM so they are compiled for Linux, not macOS.
   *
   * A no-op in mount mode, where the VM already reads the live files from
   * /mnt/mac and there is nothing to copy.
   */
  async syncToVm(remoteRoot: string): Promise<void> {
    if (this.config.sync === 'mount') {
      this.log.step('Mount mode: the VM reads your files live from /mnt/mac.')
      return
    }

    this.log.step('Syncing project into the VM…')
    const archive = createTarArchive(this.project.root, this.excludeArgs())
    const res = await this.orb.exec(
      ['run', '-m', this.project.machine, 'bash', '-lc', `mkdir -p ${shellQuote(remoteRoot)} && tar -x -C ${shellQuote(remoteRoot)}`],
      { input: archive, stream: this.config.verbose },
    )
    if (res.code !== 0) {
      throw new MercelleError('Failed to sync the project into the VM.', [res.stderr.trim()])
    }
  }

  /**
   * Install dependencies inside the VM using the detected package manager.
   * Separate from the dev command so a dependency change is picked up on the
   * next `mercelle dev` without the user having to remember to reinstall.
   */
  async installDeps(remoteRoot: string): Promise<void> {
    const { packageManager: pm } = this.project
    this.log.step(`Installing dependencies with ${c.bold(pm)} inside the VM…`)

    // Prefer a frozen/clean install, but fall back so a stale lockfile does not
    // hard-fail a dev session.
    const command =
      pm === 'npm'
        ? 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund'
        : `${pm} install --frozen-lockfile || ${pm} install`

    const res = await this.orb.runInMachine(
      this.project.machine,
      `cd ${shellQuote(remoteRoot)} && ${command}`,
      // allowFailure so a failed install surfaces mercelle's own actionable
      // message rather than a raw command-exit error.
      { stream: true, allowFailure: true },
    )
    if (res.code !== 0) {
      throw new MercelleError('Dependency installation failed in the VM.', [
        res.stderr.trim().split('\n').slice(-8).join('\n') || `${pm} install exited with code ${res.code}`,
      ])
    }
    this.log.success('Dependencies installed (Linux binaries).')
  }
}

/**
 * Build a gzipped tar of the project directory, excluding build artifacts and
 * dependencies. Uses the system `tar` for speed and native archive support.
 */
export function createTarArchive(root: string, excludeArgs: string): Buffer {
  const args = ['-czf', '-', ...excludeArgs.split(' ').filter(Boolean), '.']
  const result = spawnSync('tar', args, { cwd: root, maxBuffer: 1024 * 1024 * 512 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new MercelleError('Failed to archive the project for sync.', [result.stderr.toString().trim()])
  }
  return result.stdout
}
