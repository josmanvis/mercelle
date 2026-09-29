import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { coerceFlags } from './args.js'
import { mergeFlags, parseConfig } from './config.js'
import { MercelleError } from './errors.js'
import { readPackageJson } from './project.js'
import type { MercelleConfig } from './types.js'

/**
 * Load user config from `mercelle.config.json`, or a `mercelle` key in
 * package.json. Both are plain JSON so they work without a build step.
 */
export function loadProjectConfig(cwd: string): Record<string, unknown> {
  const jsonConfig = join(cwd, 'mercelle.config.json')
  if (existsSync(jsonConfig)) {
    try {
      return JSON.parse(readFileSync(jsonConfig, 'utf8')) as Record<string, unknown>
    } catch (err) {
      throw new MercelleError(`Could not parse mercelle.config.json: ${(err as Error).message}`)
    }
  }

  const pkg = readPackageJson(cwd)
  const embedded = pkg ? (pkg as { mercelle?: unknown }).mercelle : undefined
  if (embedded && typeof embedded === 'object') {
    return embedded as Record<string, unknown>
  }
  return {}
}

/** Resolve the effective config: defaults < config file < flags < env. */
export function resolveConfig(cwd: string, flags: Record<string, unknown> = {}): MercelleConfig {
  const fileConfig = loadProjectConfig(cwd)
  let config = parseConfig(fileConfig)
  config = mergeFlags(config, coerceFlags(flags))

  // Environment overrides, handy in CI and scripts.
  const env = process.env
  if (env.MERCELLE_DISTRO) config.distro = env.MERCELLE_DISTRO as MercelleConfig['distro']
  if (env.MERCELLE_PORT) config.port = Number(env.MERCELLE_PORT)
  if (env.MERCELLE_MEMORY) config.memory = Number(env.MERCELLE_MEMORY)
  if (env.MERCELLE_CPUS) config.cpus = Number(env.MERCELLE_CPUS)
  if (env.MERCELLE_ORB_BIN) config.orbBin = env.MERCELLE_ORB_BIN

  return config
}
