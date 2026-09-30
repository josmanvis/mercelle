import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  guardEnv,
  guardEnvValue,
  loadEnvFiles,
  parseDotenv,
  shellQuote,
  toEnvPrefix,
  vercelSystemEnv,
} from '../src/env.js'

describe('guardEnvValue', () => {
  it('allows local SQLite file paths', () => {
    expect(guardEnvValue('DATABASE_URL', 'file:./dev.db').safe).toBe(true)
    expect(guardEnvValue('DATABASE_URL', './data.db').safe).toBe(true)
    expect(guardEnvValue('DATABASE_URL', 'sqlite:./local.db').safe).toBe(true)
  })

  it('allows localhost connections', () => {
    expect(guardEnvValue('DATABASE_URL', 'postgresql://user:pw@localhost:5432/app').safe).toBe(true)
    expect(guardEnvValue('DATABASE_URL', 'postgresql://user:pw@127.0.0.1:5432/app').safe).toBe(true)
  })

  it('blocks Neon / Vercel Postgres production URLs', () => {
    const res = guardEnvValue('DATABASE_URL', 'postgresql://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/db?sslmode=require')
    expect(res.safe).toBe(false)
    expect(res.reason).toMatch(/Neon/i)
  })

  it('blocks Supabase, Railway, Render and Fly', () => {
    expect(guardEnvValue('DATABASE_URL', 'postgresql://u:p@db.abc.supabase.co:5432/postgres').safe).toBe(false)
    expect(guardEnvValue('DATABASE_URL', 'postgresql://u:p@railway.app:5432/app').safe).toBe(false)
    expect(guardEnvValue('DATABASE_URL', 'postgresql://u:p@svc.onrender.com/app').safe).toBe(false)
    expect(guardEnvValue('DATABASE_URL', 'postgresql://u:p@db.fly.dev/app').safe).toBe(false)
  })

  it('blocks AWS RDS production URLs', () => {
    expect(guardEnvValue('DATABASE_URL', 'mysql://u:p@inst.abc.us-east-1.rds.amazonaws.com:3306/app').safe).toBe(false)
  })

  it('blocks production axxes.club hosts', () => {
    expect(guardEnvValue('DATABASE_URL', 'postgresql://u:p@db.axxes.club:5432/app').safe).toBe(false)
  })

  it('guards every DSN-shaped key', () => {
    for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'DB_URL', 'PG_URL', 'DIRECT_URL']) {
      expect(guardEnvValue(key, 'postgresql://u:p@ep-x.neon.tech/db').safe, key).toBe(false)
    }
  })

  it('does not guard unrelated keys', () => {
    expect(guardEnvValue('STRIPE_SECRET_KEY', 'sk_live_abc123').safe).toBe(true)
    expect(guardEnvValue('NEXT_PUBLIC_VERCEL_URL', 'https://axxes.club').safe).toBe(true)
    expect(guardEnvValue('CLERK_SECRET_KEY', 'sk_test_x').safe).toBe(true)
  })
})

describe('guardEnv', () => {
  it('keeps safe values and reports the rejected ones', () => {
    const { safe, rejected } = guardEnv({
      PORT: '3000',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/app',
      DIRECT_URL: 'postgresql://u:p@ep-x.neon.tech/db',
    })

    expect(safe.PORT).toBe('3000')
    expect(safe.DATABASE_URL).toContain('localhost')
    expect(safe.DIRECT_URL).toBeUndefined()
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.key).toBe('DIRECT_URL')
  })

  it('returns an empty rejection list when everything is safe', () => {
    const { rejected } = guardEnv({ A: '1', DATABASE_URL: 'file:./dev.db' })
    expect(rejected).toEqual([])
  })
})


describe('parseDotenv', () => {
  it('parses simple assignments', () => {
    expect(parseDotenv('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('ignores comments and blank lines', () => {
    expect(parseDotenv('# a comment\n\nFOO=bar\n')).toEqual({ FOO: 'bar' })
  })

  it('handles export prefixes', () => {
    expect(parseDotenv('export TOKEN=abc123')).toEqual({ TOKEN: 'abc123' })
  })

  it('strips surrounding double quotes', () => {
    expect(parseDotenv('URL="https://example.com"')).toEqual({ URL: 'https://example.com' })
  })

  it('preserves characters inside single quotes', () => {
    expect(parseDotenv("PASSWORD='p@ss # word'")).toEqual({ PASSWORD: 'p@ss # word' })
  })

  it('strips inline comments from unquoted values only', () => {
    expect(parseDotenv('A=1 # note')).toEqual({ A: '1' })
    expect(parseDotenv('B="1 # kept"')).toEqual({ B: '1 # kept' })
  })

  it('supports multi-line double-quoted values', () => {
    const input = 'KEY="-----BEGIN-----\nline2\n-----END-----"\nNEXT=1'
    const out = parseDotenv(input)
    expect(out.KEY).toBe('-----BEGIN-----\nline2\n-----END-----')
    expect(out.NEXT).toBe('1')
  })

  it('keeps an empty value as an empty string', () => {
    expect(parseDotenv('EMPTY=')).toEqual({ EMPTY: '' })
  })

  it('allows keys with dots and dashes', () => {
    expect(parseDotenv('a.b-c=1')).toEqual({ 'a.b-c': '1' })
  })
})

describe('loadEnvFiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercelle-env-'))

  it('applies later files with higher precedence', () => {
    writeFileSync(join(dir, '.env'), 'A=base\nB=base\n')
    writeFileSync(join(dir, '.env.local'), 'B=local\n')
    writeFileSync(join(dir, '.env.development'), 'C=dev\n')

    expect(loadEnvFiles(dir)).toEqual({ A: 'base', B: 'local', C: 'dev' })
  })

  it('returns an empty object when no files exist', () => {
    expect(loadEnvFiles(join(dir, 'missing'))).toEqual({})
  })
})

describe('shellQuote', () => {
  it('wraps values in single quotes', () => {
    expect(shellQuote('abc')).toBe("'abc'")
  })

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})

describe('toEnvPrefix', () => {
  it('renders export statements', () => {
    expect(toEnvPrefix({ A: '1', B: '2' })).toBe("export A='1'; export B='2'")
  })

  it('emits no trailing separator so it can be joined with &&', () => {
    // Regression: the old value ended in "; ", so joining with " && " produced
    // "…; && exec …" and bash died with "syntax error near unexpected token &&".
    const prefix = toEnvPrefix({ A: '1' })
    expect(prefix).not.toMatch(/;\s*$/)
    expect(`cd /app && ${prefix} && exec node server.js`).toMatch(/&& exec node server\.js$/)
  })

  it('returns an empty string for no variables', () => {
    expect(toEnvPrefix({})).toBe('')
  })

  it('keeps ${PATH} expandable instead of quoting it literally', () => {
    // Regression: single-quoting '${PATH}' made the shell store those literal
    // characters, wiping the real PATH — the VM lost the nvm Node directory and
    // every command failed with "exec: tsx: not found".
    const prefix = toEnvPrefix({ PATH: '/app/node_modules/.bin:${PATH}' })
    expect(prefix).toContain('"')
    expect(prefix).not.toMatch(/'\$\{PATH\}'/)
  })

  it('still single-quotes values with no variable reference', () => {
    // Values without a `$` reference keep the safest form.
    expect(toEnvPrefix({ X: 'a"b' })).toBe(`export X='a"b'`)
    expect(toEnvPrefix({ Y: "it's" })).toBe(`export Y='it'\\''s'`)
    // A bare $NAME is a reference too, so it must stay expandable.
    expect(toEnvPrefix({ Z: 'prefix-$HOME' })).toBe('export Z="prefix-$HOME"')
  })

  it('escapes quotes and backslashes around an expanded reference', () => {
    const prefix = toEnvPrefix({ P: 'a"b\\c:${PATH}' })
    // Double-quoted, so the embedded " and \ must be escaped to survive.
    expect(prefix).toBe('export P="a\\"b\\\\c:${PATH}"')
  })

  it('produces a PATH line a real shell expands correctly', () => {
    // End-to-end shape check without a VM: bash must see a value that expands.
    const prefix = toEnvPrefix({ PATH: '/app/node_modules/.bin:${PATH}' })
    expect(`${prefix}`).toMatch(/^export PATH="\/app\/node_modules\/\.bin:\$\{PATH\}"$/)
  })
})

describe('vercelSystemEnv', () => {
  const base = {
    projectName: 'my-app',
    framework: 'nextjs' as const,
    machine: 'mercelle-my-app',
    port: 3000,
    hostPort: 3000,
    region: 'iad1',
    // Not a git repo, so git lookups fail and must degrade gracefully.
    root: tmpdir(),
  }

  it('sets the Vercel development environment markers', () => {
    const env = vercelSystemEnv(base)
    expect(env.VERCEL).toBe('1')
    expect(env.VERCEL_ENV).toBe('development')
    expect(env.CI).toBe('1')
    expect(env.NEXT_PUBLIC_VERCEL_ENV).toBe('development')
  })

  it('exposes the host port in VERCEL_URL', () => {
    const env = vercelSystemEnv({ ...base, hostPort: 4321 })
    expect(env.VERCEL_URL).toBe('localhost:4321')
    expect(env.NEXT_PUBLIC_VERCEL_URL).toBe('localhost:4321')
  })

  it('records the VM name and region', () => {
    const env = vercelSystemEnv({ ...base, region: 'fra1' })
    expect(env.MERCELLE_VM).toBe('mercelle-my-app')
    expect(env.VERCEL_REGION).toBe('fra1')
  })

  it('sets PORT from the in-VM port', () => {
    expect(vercelSystemEnv({ ...base, port: 4000 })['PORT']).toBe('4000')
  })
})
