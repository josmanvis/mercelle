import { describe, expect, it } from 'vitest'
import { createBackend } from '../src/backend.js'
import { defaultConfig } from '../src/config.js'
import { MercelleError } from '../src/errors.js'
import { Lima } from '../src/lima.js'
import { Orb } from '../src/orb.js'
import { silentLogger } from './helpers.js'
import { createFakeLima } from './lima-fixture.js'

describe('Lima backend', () => {
  it('detects the limactl binary', async () => {
    const fake = createFakeLima()
    const lima = new Lima({ bin: fake.shim, logger: silentLogger })
    expect(await lima.isInstalled()).toBe(true)
  })

  it('creates, lists, and removes instances', async () => {
    const fake = createFakeLima()
    const lima = new Lima({ bin: fake.shim, logger: silentLogger })

    expect(await lima.list()).toEqual([])
    await lima.create('mercelle-app', 'ubuntu', { cpus: 2, memory: 4, disk: '20GiB' })
    expect(await lima.list()).toContain('mercelle-app')

    await lima.remove('mercelle-app')
    expect(await lima.list()).not.toContain('mercelle-app')
  })

  it('maps mercelle distros onto Lima templates', async () => {
    const fake = createFakeLima()
    const lima = new Lima({ bin: fake.shim, logger: silentLogger })

    await lima.create('vm-alma', 'alma')
    await lima.create('vm-fedora', 'fedora')

    // 'alma' must become Lima's 'almalinux' template, not 'alma'.
    expect(fake.calls()).toContain('template://almalinux')
    expect(fake.calls()).toContain('template://fedora')
  })

  it('passes resource flags through to create', async () => {
    const fake = createFakeLima()
    const lima = new Lima({ bin: fake.shim, logger: silentLogger })

    await lima.create('vm', 'ubuntu', { cpus: 8, memory: 16, disk: '64GiB' })
    expect(fake.calls()).toContain('--cpus=8')
    expect(fake.calls()).toContain('--memory=16')
  })

  it('resolves $HOME inside the VM', async () => {
    const fake = createFakeLima()
    const lima = new Lima({ bin: fake.shim, logger: silentLogger })
    const res = await lima.run('vm', 'echo $HOME')
    // The fake prints the value plus a summary line, so match on the first line.
    expect(res.stdout.split('\n')[0]?.trim()).toBe('/home/user.linux')
  })

  it('runs shell commands and records the script', async () => {
    const fake = createFakeLima()
    const lima = new Lima({ bin: fake.shim, logger: silentLogger })
    await lima.run('vm', 'node -v')
    expect(fake.runScripts().some((s) => s.includes('node -v'))).toBe(true)
  })
})

describe('createBackend', () => {
  it('honours an explicit orbstack choice', async () => {
    const backend = await createBackend({ ...defaultConfig, backend: 'orbstack' }, silentLogger)
    expect(backend).toBeInstanceOf(Orb)
    expect(backend.name).toBe('orbstack')
  })

  it('honours an explicit lima choice', async () => {
    const fake = createFakeLima()
    const backend = await createBackend({ ...defaultConfig, backend: 'lima', limaBin: fake.shim }, silentLogger)
    expect(backend).toBeInstanceOf(Lima)
  })

  it('falls back to Lima when OrbStack is absent', async () => {
    const fake = createFakeLima()
    const backend = await createBackend(
      { ...defaultConfig, backend: 'auto', orbBin: '/nope/orb', limaBin: fake.shim },
      silentLogger,
    )
    expect(backend).toBeInstanceOf(Lima)
  })

  it('throws a helpful error when no backend is available', async () => {
    await expect(
      createBackend(
        { ...defaultConfig, backend: 'auto', orbBin: '/nope/orb', limaBin: '/nope/limactl' },
        silentLogger,
      ),
    ).rejects.toBeInstanceOf(MercelleError)
  })
})
