import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAppEnv, dev } from '../src/dev.js'
import { defaultConfig } from '../src/config.js'
import { resolveProject } from '../src/project.js'
import { VmManager } from '../src/vm.js'
import { createFakeOrb, silentLogger } from './helpers.js'

/** A minimal but realistic Next.js project on disk. */
function makeNextProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mercelle-dev-'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'shop', scripts: { dev: 'next dev', build: 'next build' }, dependencies: { next: '16.1.1' } }),
  )
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  mkdirSync(join(dir, 'app'), { recursive: true })
  writeFileSync(join(dir, 'app', 'page.tsx'), 'export default () => <h1>hi</h1>')
  // A file that must never be shipped into the VM.
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'macos binary')
  return dir
}

describe('buildAppEnv', () => {
  it('merges Vercel env, .env files, forwarded vars and config overrides', () => {
    const dir = makeNextProject()
    writeFileSync(join(dir, '.env.local'), 'API_KEY=from-file\nSHARED=from-file')

    const project = resolveProject(dir)
    const config = { ...defaultConfig, forwardEnv: ['HOST_TOKEN'], env: { SHARED: 'from-config' } }
    process.env.HOST_TOKEN = 'host-value'

    const env = buildAppEnv(project, config, 3000)

    expect(env.VERCEL_ENV).toBe('development')
    expect(env.API_KEY).toBe('from-file')
    expect(env.HOST_TOKEN).toBe('host-value')
    // config.env wins over the .env file
    expect(env.SHARED).toBe('from-config')
  })

  it('does not leak unforwarded host variables', () => {
    const dir = makeNextProject()
    process.env.SECRET_UNRELATED = 'nope'
    const env = buildAppEnv(resolveProject(dir), defaultConfig, 3000)
    expect(env.SECRET_UNRELATED).toBeUndefined()
  })
})

describe('VmManager', () => {
  it('creates the machine when it does not exist', async () => {
    const fake = createFakeOrb()
    const dir = makeNextProject()
    const project = resolveProject(dir)
    const vm = new VmManager({ orb: fake.orb, config: defaultConfig, project, logger: silentLogger })

    const { created } = await vm.ensureMachine()
    expect(created).toBe(true)
    expect(fake.machines()[0]?.name).toBe('mercelle-shop')
  })

  it('reuses an existing machine', async () => {
    const fake = createFakeOrb()
    const project = resolveProject(makeNextProject())
    const vm = new VmManager({ orb: fake.orb, config: defaultConfig, project, logger: silentLogger })

    await fake.orb.createMachine('mercelle-shop', 'ubuntu')
    // Count calls made by ensureMachine only, ignoring the setup above.
    const before = fake.calls().length
    const { created } = await vm.ensureMachine()

    expect(created).toBe(false)
    const during = fake.calls().slice(before)
    expect(during.filter((a) => a[0] === 'create')).toHaveLength(0)
  })

  it('recreates the machine when fresh is set', async () => {
    const fake = createFakeOrb()
    const project = resolveProject(makeNextProject())
    await fake.orb.createMachine('mercelle-shop', 'ubuntu')
    const before = fake.calls().length

    const vm = new VmManager({ orb: fake.orb, config: { ...defaultConfig, fresh: true }, project, logger: silentLogger })
    await vm.ensureMachine()

    const during = fake.calls().slice(before).map((a) => a[0])
    expect(during).toContain('delete')
    expect(during.filter((c) => c === 'create')).toHaveLength(1)
  })

  it('refuses to create a machine when reuse is disabled', async () => {
    const fake = createFakeOrb()
    const project = resolveProject(makeNextProject())
    const vm = new VmManager({ orb: fake.orb, config: { ...defaultConfig, reuse: false }, project, logger: silentLogger })

    await expect(vm.ensureMachine()).rejects.toThrow(/reuse is disabled/)
  })

  it('resolves the remote project path under the VM home dir', async () => {
    const fake = createFakeOrb()
    const project = resolveProject(makeNextProject())
    const vm = new VmManager({ orb: fake.orb, config: defaultConfig, project, logger: silentLogger })

    expect(await vm.remoteRoot('/home/tester')).toBe('/home/tester/mercelle/mercelle-shop')
  })

  it('streams a tar archive into the VM, excluding node_modules', async () => {
    const fake = createFakeOrb()
    const project = resolveProject(makeNextProject())
    const vm = new VmManager({ orb: fake.orb, config: defaultConfig, project, logger: silentLogger })

    await vm.syncToVm('/home/tester/mercelle/mercelle-shop')

    expect(fake.stdinBytes()).toBeGreaterThan(0)
    // The archive must be non-trivial yet must not contain the macOS build.
    expect(fake.configEntries().length).toBe(0)
  })

  it('skips dependency install when node_modules is already present', async () => {
    const fake = createFakeOrb()
    fake.setModulesPresent(true)
    const project = resolveProject(makeNextProject())
    const vm = new VmManager({ orb: fake.orb, config: defaultConfig, project, logger: silentLogger })

    await vm.installDeps('/home/tester/mercelle/mercelle-shop')
    expect(fake.runScripts().some((s) => s.includes('npm ci'))).toBe(true)
  })

  it('surfaces a clear error when the install fails', async () => {
    const fake = createFakeOrb()
    await fake.orb.createMachine('mercelle-shop', 'ubuntu')
    fake.setFail('mercelle-shop', true)
    const project = resolveProject(makeNextProject())
    const vm = new VmManager({ orb: fake.orb, config: defaultConfig, project, logger: silentLogger })

    await expect(vm.installDeps('/home/tester/mercelle/mercelle-shop')).rejects.toThrow(/Dependency installation failed/)
  })
})

describe('VmManager mount mode', () => {
  it('maps the project path under /mnt/mac', async () => {
    const fake = createFakeOrb()
    const dir = makeNextProject()
    const project = resolveProject(dir)
    const vm = new VmManager({
      orb: fake.orb,
      config: { ...defaultConfig, sync: 'mount' },
      project,
      logger: silentLogger,
    })

    expect(await vm.remoteRoot('/home/tester')).toBe(`/mnt/mac${dir}`)
  })

  it('keeps node_modules on the VM disk, not the Mac', async () => {
    const fake = createFakeOrb()
    const project = resolveProject(makeNextProject())
    const vm = new VmManager({
      orb: fake.orb,
      config: { ...defaultConfig, sync: 'mount' },
      project,
      logger: silentLogger,
    })

    const modules = await vm.modulesDir('/home/tester')
    expect(modules).toBe('/home/tester/.mercelle-modules/mercelle-shop/node_modules')
    expect(modules.startsWith('/home/tester')).toBe(true)
  })

  it('does not copy files in mount mode', async () => {
    const fake = createFakeOrb()
    const project = resolveProject(makeNextProject())
    const vm = new VmManager({
      orb: fake.orb,
      config: { ...defaultConfig, sync: 'mount' },
      project,
      logger: silentLogger,
    })

    await vm.syncToVm('/mnt/mac/whatever')
    // No archive should have been streamed into the VM.
    expect(fake.stdinBytes()).toBe(0)
  })

  it('refuses to clobber a real macOS node_modules directory', async () => {
    const fake = createFakeOrb()
    const dir = makeNextProject()
    // makeNextProject creates a real node_modules directory.
    const project = resolveProject(dir)
    const vm = new VmManager({
      orb: fake.orb,
      config: { ...defaultConfig, sync: 'mount' },
      project,
      logger: silentLogger,
    })

    await expect(vm.prepareMount('/home/tester')).rejects.toThrow(/real directory exists/)
  })

  it('accepts an existing symlinked node_modules', async () => {
    const fake = createFakeOrb()
    const dir = makeNextProject()
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
    symlinkSync('/home/tester/.mercelle-modules/mercelle-shop/node_modules', join(dir, 'node_modules'))

    const vm = new VmManager({
      orb: fake.orb,
      config: { ...defaultConfig, sync: 'mount' },
      project: resolveProject(dir),
      logger: silentLogger,
    })

    await expect(vm.prepareMount('/home/tester')).resolves.toBeUndefined()
    expect(fake.runScripts().some((s) => s.includes('ln -s'))).toBe(true)
  })
})
