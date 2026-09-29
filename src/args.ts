import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultConfig, mergeFlags, parseConfig } from './config.js'
import { MercelleError } from './errors.js'
import { c } from './logger.js'
import { readPackageJson } from './project.js'
import type { MercelleConfig } from './types.js'

/** Flags that take a value; everything else is a boolean switch. */
export const VALUE_FLAGS = new Set([
  'cpus',
  'memory',
  'disk',
  'port',
  'host-port',
  'distro',
  'sync',
  'package-manager',
  'orb-bin',
  'lima-bin',
  'backend',
  'region',
  'forward',
])

/** Map CLI flag names onto config keys. */
const FLAG_TO_KEY: Record<string, keyof MercelleConfig> = {
  cpus: 'cpus',
  memory: 'memory',
  disk: 'disk',
  port: 'port',
  'host-port': 'hostPort',
  distro: 'distro',
  sync: 'sync',
  'package-manager': 'packageManager',
  'orb-bin': 'orbBin',
  'lima-bin': 'limaBin',
  backend: 'backend',
  region: 'region',
  forward: 'forwardEnv',
}

/** Minimal argv parser: `--flag value`, `--flag=value`, `--no-flag`. */
export function parseArgs(argv: string[]): { flags: Record<string, unknown>; positional: string[] } {
  const flags: Record<string, unknown> = {}
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string

    if (!arg.startsWith('-')) {
      positional.push(arg)
      continue
    }

    const body = arg.replace(/^--?/, '')
    const eq = body.indexOf('=')
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }

    // `--no-x` explicitly disables a boolean option.
    if (body.startsWith('no-')) {
      flags[body.slice(3)] = false
      continue
    }

    if (VALUE_FLAGS.has(body)) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) {
        throw new MercelleError(`Flag --${body} needs a value.`)
      }
      flags[body] = next
      i++
      continue
    }

    flags[body] = true
  }

  return { flags, positional }
}

/** Convert raw string flags into the types the config schema expects. */
export function coerceFlags(flags: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(flags)) {
    const key = FLAG_TO_KEY[name]
    if (!key) continue
    if (name === 'forward') {
      out[key] =
        typeof value === 'string'
          ? value
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean)
          : value
      continue
    }
    if (name === 'cpus' || name === 'memory' || name === 'port' || name === 'host-port') {
      out[key] = Number(value)
      continue
    }
    out[key] = value
  }
  return out
}
