import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { ProjectDetectionError } from './errors.js'
import type { Framework, PackageManager, ResolvedProject } from './types.js'

/** Minimal shape of the fields mercelle reads from package.json. */
export interface PackageJson {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  packageManager?: string
  workspaces?: string[] | { packages?: string[] }
}

/** Read and parse package.json, returning null when absent or malformed. */
export function readPackageJson(root: string): PackageJson | null {
  const file = join(root, 'package.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageJson
  } catch {
    return null
  }
}

/** Detect the package manager from lockfiles, then the `packageManager` field. */
export function detectPackageManager(root: string, pkg?: PackageJson | null): PackageManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'package-lock.json'))) return 'npm'

  const declared = pkg?.packageManager
  if (declared) {
    const name = declared.split('@')[0]
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name
  }
  return 'npm'
}

/** All dependency names from both dependency maps. */
function allDeps(pkg: PackageJson): Set<string> {
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
}

/** Detect the app framework from dependency names and config files. */
export function detectFramework(root: string, pkg: PackageJson): Framework {
  const deps = allDeps(pkg)

  if (deps.has('next')) return 'nextjs'
  if (existsSync(join(root, 'nuxt.config.ts')) || deps.has('nuxt')) return 'nuxt'
  if (deps.has('astro')) return 'astro'
  if (deps.has('nitropack') || existsSync(join(root, 'nitro.config.ts'))) return 'nitro'
  if (deps.has('@remix-run/dev') || deps.has('@remix-run/react')) return 'remix'
  if (deps.has('@sveltejs/kit')) return 'sveltekit'
  if (deps.has('vite')) return 'vite'
  if (deps.has('express')) return 'express'
  return 'node'
}

/** The default dev command for a framework, used when the project has no `dev` script. */
export function defaultDevCommand(framework: Framework, pm: PackageManager): string {
  const run = (script: string) => (pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`)
  switch (framework) {
    case 'nextjs':
      return 'next dev'
    case 'nuxt':
      return 'nuxt dev'
    case 'astro':
      return 'astro dev'
    case 'nitro':
      return 'nitro dev'
    case 'remix':
      return 'remix vite:dev'
    case 'sveltekit':
      return 'vite dev'
    case 'vite':
      return 'vite dev'
    case 'express':
      return run('dev')
    case 'node':
      return run('dev')
    default:
      // Exhaustiveness guard: a new framework must declare its dev command.
      return run('dev')
  }
}

/** Turn a project directory name into a DNS/OrbStack-safe machine name. */
export function toMachineName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return `mercelle-${slug || 'app'}`
}

/**
 * Inspect a directory and work out how to run it inside a VM.
 * Throws when the directory is not a runnable Node project.
 */
export function resolveProject(
  rootInput: string,
  overrides: Partial<Pick<ResolvedProject, 'framework' | 'packageManager' | 'devCommand' | 'machine'>> = {},
): ResolvedProject {
  const root = resolve(rootInput)
  if (!existsSync(root)) {
    throw new ProjectDetectionError(`Project directory not found: ${root}`)
  }

  const pkg = readPackageJson(root)
  if (!pkg) {
    throw new ProjectDetectionError(`No package.json found in ${root}.`, [
      'mercelle runs Node projects. Run this from the root of your app.',
    ])
  }

  const framework = overrides.framework ?? detectFramework(root, pkg)
  const packageManager = overrides.packageManager ?? detectPackageManager(root, pkg)
  const devCommand = overrides.devCommand ?? pkg.scripts?.dev ?? defaultDevCommand(framework, packageManager)
  const buildCommand = pkg.scripts?.build ?? 'npm run build'
  const machine = overrides.machine ?? toMachineName(pkg.name ?? basename(root))

  return {
    root,
    framework,
    packageManager,
    devCommand,
    buildCommand,
    // Remote path is appended with the machine's home dir at runtime.
    remoteRoot: `mercelle/${machine}`,
    machine,
  }
}

