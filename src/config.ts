import { z } from 'zod'
import type { MercelleConfig } from './types.js'

/** Schema for `mercelle.config.ts` / the `mercelle` key in package.json. */
export const configSchema = z.object({
  distro: z.enum(['ubuntu', 'debian', 'fedora', 'arch', 'alma', 'rocky', 'amazonlinux', 'oracle', 'opensuse']).default('ubuntu'),
  cpus: z.number().int().min(1).max(64).default(4),
  memory: z.number().int().min(1).max(256).default(8),
  disk: z.string().default('64GB'),
  port: z.number().int().min(1).max(65535).default(3000),
  hostPort: z.number().int().min(1).max(65535).nullable().default(null),
  packageManager: z.enum(['pnpm', 'yarn', 'bun', 'npm']).optional(),
  sync: z.enum(['mount', 'copy']).default('copy'),
  reuse: z.boolean().default(true),
  fresh: z.boolean().default(false),
  reinstall: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  verbose: z.boolean().default(false),
  orbBin: z.string().default('orb'),
  forwardEnv: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  watch: z.boolean().default(true),
  region: z.string().default('iad1'),
  once: z.boolean().default(false),
})

export type ConfigInput = z.input<typeof configSchema>

/** Built-in defaults, before any config file or CLI flags are applied. */
export const defaultConfig: MercelleConfig = {
  distro: 'ubuntu',
  cpus: 4,
  memory: 8,
  disk: '64GB',
  port: 3000,
  hostPort: null,
  packageManager: 'npm',
  sync: 'copy',
  reuse: true,
  fresh: false,
  reinstall: false,
  dryRun: false,
  verbose: false,
  orbBin: 'orb',
  forwardEnv: [],
  env: {},
  watch: true,
  region: 'iad1',
  once: false,
}

/** Validate and fill in defaults for a user-supplied config object. */
export function parseConfig(input: unknown = {}): MercelleConfig {
  const parsed = configSchema.parse(input ?? {})
  return {
    ...defaultConfig,
    ...parsed,
    // packageManager is optional in the schema; keep the concrete default.
    packageManager: parsed.packageManager ?? defaultConfig.packageManager,
  }
}

/** Parse CLI flags over an already-resolved config, ignoring unknown keys. */
export function mergeFlags(base: MercelleConfig, flags: Record<string, unknown>): MercelleConfig {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined) continue
    if (!(key in defaultConfig)) continue
    out[key] = value
  }
  return out as unknown as MercelleConfig
}
