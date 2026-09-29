import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Framework } from './types.js'

/**
 * Parse a dotenv file into key/value pairs.
 *
 * Supports `KEY=value`, `export KEY=value`, quoted values (single and double),
 * `#` comments, and multi-line double-quoted values.
 */
export function parseDotenv(contents: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = contents.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const key = match[1] as string
    let value = (match[2] ?? '').trim()

    // Multi-line values: keep consuming lines until the closing quote.
    if (value.startsWith('"') && !value.endsWith('"') && value.length > 1) {
      const parts = [value.slice(1)]
      for (i = i + 1; i < lines.length; i++) {
        const next = lines[i] ?? ''
        if (next.trimEnd().endsWith('"')) {
          parts.push(next.trimEnd().slice(0, -1))
          break
        }
        parts.push(next)
      }
      value = parts.join('\n')
    } else if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
      value = value.slice(1, -1)
    } else if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"')
    } else {
      // Strip trailing inline comments from unquoted values.
      const hash = value.indexOf(' #')
      if (hash !== -1) value = value.slice(0, hash).trimEnd()
    }

    out[key] = value
  }
  return out
}

/** Read and parse a dotenv file, returning {} when it does not exist. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  try {
    return parseDotenv(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Load .env files in the order Vercel does, so local behaviour matches deploys.
 * Later files win.
 */
export function loadEnvFiles(root: string, mode = 'development'): Record<string, string> {
  const candidates = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]
  const merged: Record<string, string> = {}
  for (const name of candidates) {
    Object.assign(merged, readEnvFile(join(root, name)))
  }
  return merged
}

/** Read a single value out of the repo's .git, for VERCEL_GIT_* parity. */
function gitInfo(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

export interface VercelEnvOptions {
  projectName: string
  framework: Framework
  machine: string
  port: number
  hostPort: number
  region: string
  root: string
}

/**
 * Build the Vercel system environment variables.
 *
 * These are the values Vercel injects at runtime. Supplying them locally means
 * code that branches on `process.env.VERCEL_ENV` (very common in Next.js apps)
 * behaves the same way here as it does after a deploy.
 */
export function vercelSystemEnv(opts: VercelEnvOptions): Record<string, string> {
  const { projectName, machine, port, hostPort, region, root } = opts
  const branch = gitInfo(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'main'
  const sha = gitInfo(root, ['rev-parse', 'HEAD']) ?? 'local'
  const shortSha = sha.slice(0, 7)
  const url = `localhost:${hostPort}`
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-')

  const env: Record<string, string> = {
    VERCEL: '1',
    CI: '1',
    VERCEL_ENV: 'development',
    VERCEL_REGION: region,
    VERCEL_URL: url,
    VERCEL_BRANCH_URL: url,
    VERCEL_PREVIEW_URL: url,
    VERCEL_PROJECT_ID: `mercelle_${slug}`,
    VERCEL_PROJECT_NAME: projectName,
    VERCEL_ORG_ID: 'mercelle',
    VERCEL_GIT_PROVIDER: 'github',
    VERCEL_GIT_REPO_SLUG: slug,
    VERCEL_GIT_REPO_OWNER: 'local',
    VERCEL_GIT_COMMIT_REF: branch,
    VERCEL_GIT_COMMIT_SHA: sha,
    VERCEL_GIT_COMMIT_MESSAGE: 'mercelle local development',
    VERCEL_GIT_COMMIT_AUTHOR_LOGIN: 'local',
    VERCEL_GIT_PREVIOUS_SHA: sha,
    VERCEL_GIT_TAGGED_REF: '',
    NEXT_PUBLIC_VERCEL_URL: url,
    NEXT_PUBLIC_VERCEL_REGION: region,
    NEXT_PUBLIC_VERCEL_ENV: 'development',
    MERCELLE: '1',
    MERCELLE_VM: machine,
    PORT: String(port),
  }

  // Only expose the port to the app, not our internal VM bookkeeping.
  return env
}

/** Escape a value for safe use inside a single-quoted shell string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Render an env object as `KEY='value'` pairs prefixed to a command. */
export function toEnvPrefix(env: Record<string, string>): string {
  const entries = Object.entries(env)
  if (entries.length === 0) return ''
  return `${entries.map(([k, v]) => `export ${k}=${shellQuote(v)}`).join('; ')}; `
}
