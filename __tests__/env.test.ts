import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadEnvFiles, parseDotenv, shellQuote, toEnvPrefix, vercelSystemEnv } from '../src/env.js'

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
    expect(toEnvPrefix({ A: '1', B: '2' })).toBe("export A='1'; export B='2'; ")
  })

  it('returns an empty string for no variables', () => {
    expect(toEnvPrefix({})).toBe('')
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
