/**
 * Shared types for mercelle.
 */

/** A Linux distribution supported by OrbStack machines. */
export type Distro = 'ubuntu' | 'debian' | 'fedora' | 'arch' | 'alma' | 'rocky' | 'amazonlinux' | 'oracle' | 'opensuse'

/** Frameworks mercelle knows how to run inside the VM. */
export type Framework =
  | 'nextjs'
  | 'astro'
  | 'nuxt'
  | 'nitro'
  | 'remix'
  | 'sveltekit'
  | 'vite'
  | 'express'
  | 'node'
  | 'unknown'

/** Package managers mercelle can use inside the VM. */
export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'

/** Supported VM backends. `auto` picks whichever is installed. */
export type Backend = 'orbstack' | 'lima' | 'auto'

/** The user-facing configuration, after merging defaults + file + flags. */
export interface MercelleConfig {
  /** VM distribution. */
  distro: Distro
  /** CPU cores assigned to the VM. */
  cpus: number
  /** Memory in GB. */
  memory: number
  /** Disk size in GB. */
  disk: string
  /** Port the dev server listens on *inside* the VM. */
  port: number
  /** Port to reach it on from macOS. Defaults to `port`. */
  hostPort: number | null
  /** Package manager to install with inside the VM. */
  packageManager: PackageManager
  /**
   * How project files get into the VM.
   * - `mount`: run directly off /mnt/mac (fastest, no copy, shared node_modules risk)
   * - `copy`: rsync the project into the VM (isolated, Linux-correct node_modules)
   */
  sync: 'mount' | 'copy'
  /** Reuse an existing VM instead of recreating it. */
  reuse: boolean
  /** Rebuild the VM (destroy + create) on next run. */
  fresh: boolean
  /** Rebuild node_modules inside the VM. */
  reinstall: boolean
  /** Print the commands mercelle runs without executing them. */
  dryRun: boolean
  /** Stream remote logs to the terminal. */
  verbose: boolean
  /** Path to the `orb` binary. Overridable for tests and non-standard installs. */
  orbBin: string
  /**
   * VM backend. `orbstack` is the default and the best-supported option.
   * `lima` is a fallback for Intel Macs that cannot run OrbStack.
   */
  backend: Backend
  /** Path to the `limactl` binary, used when backend is `lima`. */
  limaBin: string
  /** Forward these host env vars into the VM. */
  forwardEnv: string[]
  /** Extra env vars merged into the app inside the VM. */
  env: Record<string, string>
  /** Watch the project and re-run the dev command on change. */
  watch: boolean
  /** Vercel region reported to the app. */
  region: string
  /** Exit mercelle when the dev process exits. */
  once: boolean
  /** Open the web dashboard during `stack`/`ui`. */
  ui: boolean
  /** Port the web dashboard listens on. */
  uiPort: number
  /** Root directory the Run App picker scans (default ~/Developer). */
  devRoot: string
  /** Suffix for local app domains (default axxes.local). */
  domainSuffix: string
}

/** Fully resolved config plus derived paths. */
export interface ResolvedProject {
  /** Absolute path to the project root. */
  root: string
  /** Detected (or configured) framework. */
  framework: Framework
  /** Package manager to use. */
  packageManager: PackageManager
  /** The dev command that runs inside the VM. */
  devCommand: string
  /** The build command that runs inside the VM. */
  buildCommand: string
  /** Directory the project is served from inside the VM. */
  remoteRoot: string
  /** Name of the OrbStack machine backing this project. */
  machine: string
}

/** Result of a backend (orb/lima) invocation. */
export interface OrbResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * The VM operations mercelle needs, independent of the hypervisor.
 *
 * Both OrbStack and Lima implement this, so the rest of mercelle is written
 * once and works on whichever backend the machine supports.
 */
export interface VmBackend {
  /** Human-readable name, used in log output. */
  readonly name: string
  /** True when the backend's CLI is available on this machine. */
  isInstalled(): Promise<boolean>
  /** Create a VM. `machine` is a backend-specific instance name. */
  create(machine: string, distro: string, opts: { cpus?: number; memory?: number; disk?: string }): Promise<void>
  /** Run a shell command inside a VM. */
  run(machine: string, command: string, opts?: { stream?: boolean; allowFailure?: boolean; input?: Buffer }): Promise<OrbResult>
  /** Start a VM. No-op when already running. */
  start(machine: string): Promise<void>
  /** Stop a VM. */
  stop(machine: string): Promise<void>
  /** Delete a VM. */
  remove(machine: string): Promise<void>
  /** List VM names. */
  list(): Promise<string[]>
  /** Start a long-running command, returning a handle that can be killed. */
  spawn?(machine: string, command: string, handlers: { onStdout?: (c: Buffer) => void; onStderr?: (c: Buffer) => void; onClose?: (code: number) => void }): { kill: (signal?: NodeJS.Signals) => boolean } | null
  /** Expose the guest port on the host, when the backend supports remapping it. */
  setHttpPort?(machine: string, hostPort: number, guestPort?: number): Promise<void>
  /** Print a message about installing this backend. */
  installHint(): string[]
}

/** Log sink, so tests can capture output instead of printing it. */
export interface Logger {
  info: (msg: string) => void
  success: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  step: (msg: string) => void
  raw: (msg: string) => void
}
