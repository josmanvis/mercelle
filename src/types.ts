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

/** Result of an `orb` invocation. */
export interface OrbResult {
  code: number
  stdout: string
  stderr: string
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
