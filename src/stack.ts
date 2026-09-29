import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PackageManager } from './types.js'

/** A single service in the stack. */
export interface StackService {
  /** Directory name under the workspace root. */
  name: string
  /** Absolute path on the Mac. */
  path: string
  /** Framework label, for display. */
  framework: string
  /** The dev command mercelle will run. */
  devCommand: string
  packageManager: PackageManager
  /** True when the project has a database (prisma/drizzle). */
  hasDatabase: boolean
  /** Port to serve on inside the VM. */
  port: number
  /** True when the service should be started by default. */
  enabled: boolean
}

/** Names that are infrastructure or tooling rather than deployable services. */
const EXCLUDE_PATTERNS = [
  /^_/,
  /^mercelle$/,
  /-test$/,
  /-phase\d+$/,
  /-awards$/,
  /node_modules$/,
  /^\./,
]

/** Detect the package manager for a directory. */
function detectPm(dir: string): PackageManager {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/** Read framework + scripts from a package.json without executing anything. */
function readServiceMeta(dir: string): { framework: string; devCommand: string; hasDatabase: boolean } | null {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null

  let pkg: {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const framework =
    (['next', 'nuxt', 'astro', '@sveltejs/kit', 'vite', 'hono', 'fastify', 'express'] as const).find(
      (f) => f in deps,
    ) ?? 'node'

  const hasDatabase =
    existsSync(join(dir, 'prisma')) ||
    existsSync(join(dir, 'drizzle.config.ts')) ||
    existsSync(join(dir, 'drizzle.config.js')) ||
    existsSync(join(dir, 'db'))

  return { framework, devCommand: pkg.scripts?.dev ?? '', hasDatabase }
}

/**
 * Discover every runnable service in a workspace directory.
 *
 * Ports are assigned deterministically from the service name so a given
 * service always lands on the same port across boots — stable URLs matter when
 * several services are running at once.
 */
export function discoverStack(root: string, opts: { basePort?: number } = {}): StackService[] {
  const basePort = opts.basePort ?? 3000
  const services: StackService[] = []

  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }

  // Provisional ports from a stable hash, then de-duplicated below.
  for (const name of entries.sort()) {
    if (EXCLUDE_PATTERNS.some((re) => re.test(name))) continue

    const dir = join(root, name)
    if (!existsSync(join(dir, 'package.json'))) continue

    const meta = readServiceMeta(dir)
    if (!meta || !meta.devCommand) continue

    services.push({
      name,
      path: dir,
      framework: meta.framework,
      devCommand: meta.devCommand,
      packageManager: detectPm(dir),
      hasDatabase: meta.hasDatabase,
      // Stable per-service port: hash the name into the base range.
      port: basePort + (stableHash(name) % 100),
      enabled: true,
    })
  }

  return assignUniquePorts(services, basePort)
}

/**
 * Resolve port collisions deterministically.
 *
 * Hash-based ports can collide, which would make two services fight over the
 * same port. Walk the list in name order and push any clash forward to the
 * next free slot, so the result is stable for a given set of services.
 */
export function assignUniquePorts(services: StackService[], basePort = 3000): StackService[] {
  const used = new Set<number>()
  return services.map((service) => {
    let port = service.port
    while (used.has(port)) {
      port = port >= basePort + 999 ? basePort : port + 1
    }
    used.add(port)
    return { ...service, port }
  })
}

/** Small deterministic string hash (FNV-1a), so ports are reproducible. */
export function stableHash(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** Write the discovered stack to disk so the CLI and VM can share it. */
export function writeStackManifest(services: StackService[], path: string): void {
  writeFileSync(path, JSON.stringify({ services }, null, 2))
}