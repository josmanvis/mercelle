import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBackend } from '../src/backend.js'
import { defaultConfig } from '../src/config.js'
import { MercelleError } from '../src/errors.js'
import { Lima, parseLimaList, toLimaDiskGiB } from '../src/lima.js'
import { Orb } from '../src/orb.js'
import { silentLogger } from './helpers.js'
import { createFakeLima } from './lima-fixture.js'

describe('toLimaDiskGiB', () => {
  it('converts the default OrbStack-style size to a bare GiB number', () => {
    // Regression: `limactl --disk` is a float32 in GiB and rejects "64GB"
    // and "64GiB" alike, so the unit must be stripped.
    expect(toLimaDiskGiB('64GB')).toBe(64)
    expect(toLimaDiskGiB('64GiB')).toBe(64)
  })

  it('converts other units to GiB', () => {
    expect(toLimaDiskGiB('2TB')).toBe(2048)
    expect(toLimaDiskGiB('1TiB')).toBe(1024)
    expect(toLimaDiskGiB('128GB')).toBe(128)
  })

  it('clamps tiny disks up to 1GiB', () => {
    // A sub-1GiB disk is not usable under QEMU, so the floor is deliberate.
    expect(toLimaDiskGiB('512MB')).toBe(1)
    expect(toLimaDiskGiB('100MB')).toBe(1)
  })

  it('tolerates spacing and decimals', () => {
    expect(toLimaDiskGiB(' 32 GB ')).toBe(32)
    expect(toLimaDiskGiB('1.5GB')).toBe(1.5)
  })

  it('never returns less than 1GiB', () => {
    expect(toLimaDiskGiB('garbage')).toBe(64)
  })
})

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
    expect(fake.calls()).toContain('template:almalinux')
    expect(fake.calls()).toContain('template:fedora')
  })

  it('selects the qemu driver when vz is unavailable', async () => {
    // Regression: `vz` is Apple-Silicon-only; Intel Macs must get `qemu`.
    const fake = createFakeLima()
    const lima = new Lima({ bin: fake.shim, logger: silentLogger })
    await lima.create('vm', 'ubuntu')

    expect(fake.calls()).toContain('--vm-type=qemu')
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

  it('passes --tty=false before the instance name', async () => {
    // Regression: limactl forwards args after the instance name to the guest, so
    // a trailing --tty=false reached bash and every VM command failed with
    // "--: invalid option". The fake limactl rejects that ordering outright.
    const fake = createFakeLima()
    const lima = new Lima({ bin: fake.shim, logger: silentLogger })

    const res = await lima.run('mercelle-app', 'echo hi')
    expect(res.code).toBe(0)
    expect(fake.calls()).toContain('["shell","--tty=false","mercelle-app","bash","-lc","echo hi"]')
  })

  it('runs shell commands and records the script', async () => {
    const fake = createFakeLima()
    const lima = new Lima({ bin: fake.shim, logger: silentLogger })
    await lima.run('vm', 'node -v')
    expect(fake.runScripts().some((s) => s.includes('node -v'))).toBe(true)
  })
})

describe('Lima.setHttpPort', () => {
  const limaYaml = ['memory: "8GiB"', 'cpus: 4', 'vmType: qemu', ''].join('\n')

  function makeInstance(): { lima: Lima; yamlPath: string } {
    const home = mkdtempSync(join(tmpdir(), 'mercelle-limahome-'))
    const dir = join(home, 'mercelle-app')
    mkdirSync(dir, { recursive: true })
    const yamlPath = join(dir, 'lima.yaml')
    writeFileSync(yamlPath, limaYaml)
    return { lima: new Lima({ bin: 'limactl', logger: silentLogger, limaHome: home }), yamlPath }
  }

  it('writes a port forward when the host port differs from the guest port', async () => {
    // Regression: setHttpPort was a no-op, so `--host-port 3100` never opened
    // anything and the URL mercelle printed was a dead port. Lima's automatic
    // forwarding only maps guest:<port> to host:<same port>.
    const { lima, yamlPath } = makeInstance()
    await lima.setHttpPort('mercelle-app', 3100, 3000)

    const yaml = readFileSync(yamlPath, 'utf8')
    expect(yaml).toContain('portForwards:')
    expect(yaml).toContain('guestPort: 3000')
    expect(yaml).toContain('hostPort: 3100')
    // The rest of the file must survive.
    expect(yaml).toContain('vmType: qemu')
  })

  it('does nothing when host and guest ports match', async () => {
    const { lima, yamlPath } = makeInstance()
    await lima.setHttpPort('mercelle-app', 3000, 3000)
    expect(readFileSync(yamlPath, 'utf8')).toBe(limaYaml)
  })

  it('replaces a previously written rule instead of appending a second one', async () => {
    const { lima, yamlPath } = makeInstance()
    await lima.setHttpPort('mercelle-app', 3100, 3000)
    await lima.setHttpPort('mercelle-app', 4100, 3000)

    const yaml = readFileSync(yamlPath, 'utf8')
    expect(yaml.match(/portForwards:/g)).toHaveLength(1)
    expect(yaml).toContain('hostPort: 4100')
    expect(yaml).not.toContain('hostPort: 3100')
  })

  it('is a no-op for a machine that does not exist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mercelle-limahome-'))
    const lima = new Lima({ bin: 'limactl', logger: silentLogger, limaHome: home })
    await expect(lima.setHttpPort('nope', 3100, 3000)).resolves.toBeUndefined()
  })
})

describe('parseLimaList', () => {
  it('reads newline-delimited JSON, the real `limactl list --json` shape', () => {
    // Regression: Lima 2.x prints one flat JSON object per line, not a JSON
    // array. JSON.parse() on the whole payload throws, which made list() return
    // [] and made mercelle try to create a VM that already existed.
    const stdout = [
      JSON.stringify({ name: 'mercelle-a', status: 'Running' }),
      JSON.stringify({ name: 'mercelle-b', status: 'Stopped' }),
    ].join('\n')

    expect(parseLimaList(stdout)).toEqual(['mercelle-a', 'mercelle-b'])
  })

  it('ignores blank lines and non-JSON noise', () => {
    const stdout = ['', 'warning: something', JSON.stringify({ name: 'mercelle-a' }), ''].join('\n')
    expect(parseLimaList(stdout)).toEqual(['mercelle-a'])
  })

  it('returns an empty list for empty output', () => {
    expect(parseLimaList('')).toEqual([])
  })

  it('skips entries without a usable name', () => {
    const stdout = [JSON.stringify({ status: 'Running' }), JSON.stringify({ name: 'ok' })].join('\n')
    expect(parseLimaList(stdout)).toEqual(['ok'])
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

describe('Lima start failures', () => {
  /** A limactl that fails `start` the way a missing QEMU binary does. */
  function startShim(exitCode: number, stderr: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-start-'))
    // A real executable: Lima spawns `bin` directly, so a path containing a
    // space (node + script) would not survive argv handling.
    const script = join(dir, 'limactl')
    writeFileSync(
      script,
      `#!/bin/sh
node "$(dirname "$0")/limactl.mjs" "$@"
exit $?`,
      { mode: 0o755 },
    )
    const impl = join(dir, 'limactl.mjs')
    writeFileSync(
      impl,
      `#!/usr/bin/env node
const argv = process.argv.slice(2)
if (argv[0] === 'start') { process.stderr.write(${JSON.stringify(stderr)}); process.exit(${exitCode}) }
if (argv[0] === '--version') { console.log('limactl version 2.2.0'); process.exit(0) }
process.exit(0)
`,
      { mode: 0o755 },
    )
    return script
  }

  it('surfaces a missing QEMU binary instead of failing later', async () => {
    // Regression: start() used allowFailure, so a failed start was swallowed and
    // the real problem only appeared much later as a confusing
    // "instance is stopped" message from an unrelated command.
    const shim = startShim(1, 'failed to find the QEMU binary for the architecture `x86_64`')
    const lima = new Lima({ bin: shim, logger: silentLogger })
    await expect(lima.start('vm')).rejects.toThrow(/QEMU binary is not on your PATH/)
  })

  it('reports the underlying reason for any other start failure', async () => {
    const shim = startShim(1, 'disk image is corrupt')
    const lima = new Lima({ bin: shim, logger: silentLogger })
    await expect(lima.start('vm')).rejects.toThrow(/Failed to start vm/)
  })

  it('does not throw when the start succeeds', async () => {
    const shim = startShim(0, '')
    const lima = new Lima({ bin: shim, logger: silentLogger })
    await expect(lima.start('vm')).resolves.toBeUndefined()
  })
})
