import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coerceFlags, parseArgs, VALUE_FLAGS } from '../src/args.js'
import { defaultConfig, mergeFlags, parseConfig } from '../src/config.js'
import { MercelleError } from '../src/errors.js'
import { resolveConfig } from '../src/loadConfig.js'

describe('parseArgs', () => {
  it('parses boolean switches and positionals', () => {
    const { flags, positional } = parseArgs(['dev', '--fresh', '--verbose'])
    expect(positional).toEqual(['dev'])
    expect(flags).toEqual({ fresh: true, verbose: true })
  })

  it('parses --flag value pairs', () => {
    expect(parseArgs(['--port', '4000']).flags).toEqual({ port: '4000' })
  })

  it('parses --flag=value pairs', () => {
    expect(parseArgs(['--port=4000']).flags).toEqual({ port: '4000' })
  })

  it('handles --no-flag negation', () => {
    expect(parseArgs(['--no-watch']).flags).toEqual({ watch: false })
  })

  it('throws when a value flag is missing its value', () => {
    expect(() => parseArgs(['--port'])).toThrow(MercelleError)
    expect(() => parseArgs(['--port', '--fresh'])).toThrow(/needs a value/)
  })

  it('keeps every known value flag in VALUE_FLAGS', () => {
    for (const flag of ['port', 'host-port', 'memory', 'cpus', 'disk', 'distro']) {
      expect(VALUE_FLAGS.has(flag)).toBe(true)
    }
  })
})

describe('coerceFlags', () => {
  it('converts numeric flags to numbers', () => {
    expect(coerceFlags({ port: '4000', memory: '16', cpus: '8' })).toEqual({
      port: 4000,
      memory: 16,
      cpus: 8,
    })
  })

  it('maps hyphenated flag names onto config keys', () => {
    expect(coerceFlags({ 'host-port': '8080', 'orb-bin': '/usr/local/bin/orb' })).toEqual({
      hostPort: 8080,
      orbBin: '/usr/local/bin/orb',
    })
  })

  it('splits comma-separated forward lists', () => {
    expect(coerceFlags({ forward: 'A,B , C' })).toEqual({ forwardEnv: ['A', 'B', 'C'] })
  })

  it('ignores unknown flags', () => {
    expect(coerceFlags({ nonsense: 'x' })).toEqual({})
  })
})

describe('parseConfig', () => {
  it('fills in defaults for an empty object', () => {
    const config = parseConfig({})
    expect(config.distro).toBe(defaultConfig.distro)
    expect(config.port).toBe(3000)
    expect(config.sync).toBe('copy')
  })

  it('keeps user overrides', () => {
    const config = parseConfig({ port: 8080, memory: 16, sync: 'mount' })
    expect(config.port).toBe(8080)
    expect(config.memory).toBe(16)
    expect(config.sync).toBe('mount')
  })

  it('rejects invalid values', () => {
    expect(() => parseConfig({ port: 99999 })).toThrow()
    expect(() => parseConfig({ sync: 'teleport' })).toThrow()
    expect(() => parseConfig({ distro: 'plan9' })).toThrow()
  })

  it('always produces a concrete packageManager', () => {
    expect(parseConfig({}).packageManager).toBe('npm')
    expect(parseConfig({ packageManager: 'pnpm' }).packageManager).toBe('pnpm')
  })
})

describe('mergeFlags', () => {
  it('overrides config values with flags', () => {
    expect(mergeFlags(parseConfig({ port: 3000 }), { port: 5000 }).port).toBe(5000)
  })

  it('ignores undefined and unknown keys', () => {
    const merged = mergeFlags(parseConfig({}), { port: undefined, bogus: 'x' } as Record<string, unknown>)
    expect(merged.port).toBe(3000)
    expect('bogus' in merged).toBe(false)
  })
})

describe('resolveConfig', () => {
  const original = { ...process.env }
  afterEach(() => {
    process.env = { ...original }
  })

  it('reads mercelle.config.json from the project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-cfg-'))
    writeFileSync(join(dir, 'mercelle.config.json'), JSON.stringify({ port: 4321, memory: 12 }))

    const config = resolveConfig(dir, {})
    expect(config.port).toBe(4321)
    expect(config.memory).toBe(12)
  })

  it('reads a mercelle key from package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-cfg-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', mercelle: { port: 7777 } }))

    expect(resolveConfig(dir, {}).port).toBe(7777)
  })

  it('prefers the config file over package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-cfg-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ mercelle: { port: 7777 } }))
    writeFileSync(join(dir, 'mercelle.config.json'), JSON.stringify({ port: 8888 }))

    expect(resolveConfig(dir, {}).port).toBe(8888)
  })

  it('applies flags over file config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-cfg-'))
    writeFileSync(join(dir, 'mercelle.config.json'), JSON.stringify({ port: 4321 }))

    expect(resolveConfig(dir, { port: '5555' }).port).toBe(5555)
  })

  it('lets environment variables override everything', () => {
    process.env.MERCELLE_PORT = '9999'
    process.env.MERCELLE_MEMORY = '24'
    const config = resolveConfig(mkdtempSync(join(tmpdir(), 'mercelle-cfg-')), { port: '5555' })
    expect(config.port).toBe(9999)
    expect(config.memory).toBe(24)
  })

  it('reports a helpful error for malformed config JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-cfg-'))
    writeFileSync(join(dir, 'mercelle.config.json'), '{ broken')
    expect(() => resolveConfig(dir, {})).toThrow(MercelleError)
  })
})
