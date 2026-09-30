import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DOMAIN_SUFFIX,
  domainRoutes,
  hostsBlock,
  installHostsEntries,
  readManagedHosts,
  removeHostsBlock,
  upsertHostsBlock,
} from '../src/domains.js'
import { silentLogger } from './helpers.js'

const routes = domainRoutes([
  { name: 'web', port: 3000 },
  { name: 'api', port: 3187 },
])

describe('domainRoutes', () => {
  it('maps services to <name>.axxes.local domains', () => {
    expect(DEFAULT_DOMAIN_SUFFIX).toBe('axxes.local')
    expect(routes).toEqual([
      { service: 'web', domain: 'web.axxes.local', port: 3000, url: 'http://web.axxes.local' },
      { service: 'api', domain: 'api.axxes.local', port: 3187, url: 'http://api.axxes.local' },
    ])
  })

  it('honours a custom suffix', () => {
    const custom = domainRoutes([{ name: 'web', port: 3000 }], 'qa.corp.internal')
    expect(custom[0]?.domain).toBe('web.qa.corp.internal')
  })
})

describe('hosts block management', () => {
  it('appends the managed block to an existing hosts file', () => {
    const existing = '127.0.0.1 localhost\n::1 localhost\n'
    const next = upsertHostsBlock(existing, routes)
    expect(next).toContain('127.0.0.1\tweb.axxes.local')
    expect(next).toContain('# mercelle:begin')
    expect(next).toContain('127.0.0.1 localhost')
  })

  it('replaces the block on re-install instead of duplicating it', () => {
    const once = upsertHostsBlock('127.0.0.1 localhost\n', routes)
    const twice = upsertHostsBlock(once, [routes[0]!])
    expect(twice.match(/mercelle:begin/g)).toHaveLength(1)
    expect(twice).not.toContain('api.axxes.local')
    expect(twice).toContain('web.axxes.local')
  })

  it('removes the block surgically', () => {
    const withBlock = upsertHostsBlock('127.0.0.1 localhost\n', routes)
    const removed = removeHostsBlock(withBlock)
    expect(removed).not.toContain('mercelle:begin')
    expect(removed).not.toContain('axxes.local')
    expect(removed).toContain('127.0.0.1 localhost')
    expect(removeHostsBlock('no block here')).toBe('no block here')
  })

  it('parses managed entries back out', () => {
    const withBlock = upsertHostsBlock('', routes)
    expect(readManagedHosts(withBlock)).toEqual(['web.axxes.local', 'api.axxes.local'])
    expect(readManagedHosts('127.0.0.1 localhost')).toEqual([])
  })

  it('renders a printable block', () => {
    const block = hostsBlock(routes)
    expect(block).toContain('# mercelle:begin')
    expect(block.split('\n').filter((l) => l.startsWith('127.0.0.1'))).toHaveLength(2)
    expect(hostsBlock([])).toBe('')
  })
})

describe('installHostsEntries', () => {
  it('writes a temp hosts file and reports success when permitted', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-hosts-'))
    const hostsPath = join(dir, 'hosts')

    writeFileSync(hostsPath, '127.0.0.1 localhost\n')
    const res = await installHostsEntries(routes, hostsPath, silentLogger)
    expect(res.written).toBe(true)
    const content = readFileSync(hostsPath, 'utf8')
    expect(content).toContain('web.axxes.local')
    expect(content).toContain('127.0.0.1 localhost')
  })

  it('falls back to a manual command when the file is not writable', async () => {
    const res = await installHostsEntries(routes, '/definitely/not/writable/hosts', silentLogger)
    expect(res.written).toBe(false)
    expect(res.manualCommand).toContain('sudo tee /etc/hosts')
  })
})
