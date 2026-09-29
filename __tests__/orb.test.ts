import { describe, expect, it } from 'vitest'
import { Orb, parseMachineList } from '../src/orb.js'
import { OrbCommandError, OrbStackMissingError } from '../src/errors.js'
import { createFakeOrb, silentLogger } from './helpers.js'

describe('parseMachineList', () => {
  it('extracts names from a table and skips the header', () => {
    const out = parseMachineList('NAME            DISTRO    STATE\nmercelle-app    ubuntu    running\nother           debian    stopped\n')
    expect(out).toEqual(['mercelle-app', 'other'])
  })

  it('returns an empty list for empty input', () => {
    expect(parseMachineList('')).toEqual([])
    expect(parseMachineList('\n\n  \n')).toEqual([])
  })

  it('ignores non-name lines', () => {
    expect(parseMachineList('│ name │ state │\n│ a    │ run   │\n')).toEqual([])
  })
})

describe('Orb.formatCommand', () => {
  it('leaves simple args unquoted', () => {
    expect(Orb.formatCommand('orb', ['list'])).toBe('orb list')
  })

  it('quotes args containing spaces', () => {
    expect(Orb.formatCommand('orb', ['run', '-m', 'app', 'bash', '-lc', 'echo $HOME'])).toBe(
      "orb run -m app bash -lc 'echo $HOME'",
    )
  })

  it('escapes single quotes safely', () => {
    expect(Orb.formatCommand('orb', ['run', "it's"])).toBe("orb run 'it'\\''s'")
  })
})

describe('Orb (against a real fake binary)', () => {
  it('reports installation via the version subcommand', async () => {
    const fake = createFakeOrb()
    expect(await fake.orb.isInstalled()).toBe(true)
  })

  it('returns an empty machine list initially', async () => {
    const fake = createFakeOrb()
    expect(await fake.orb.listMachines()).toEqual([])
    expect(await fake.orb.machineExists('nope')).toBe(false)
  })

  it('creates a machine and then finds it', async () => {
    const fake = createFakeOrb()
    await fake.orb.createMachine('mercelle-app', 'ubuntu', { cpus: 2, memory: 4, disk: '20GB' })

    expect(await fake.orb.machineExists('mercelle-app')).toBe(true)
    expect(fake.machines()[0]).toMatchObject({ name: 'mercelle-app', distro: 'ubuntu' })
  })

  it('passes resource flags through to create', async () => {
    const fake = createFakeOrb()
    await fake.orb.createMachine('m1', 'debian', { cpus: 8, memory: 16, disk: '50GB' })

    const call = fake.calls().find((args) => args[0] === 'create')
    expect(call).toEqual(['create', 'debian', 'm1', '--cpus', '8', '--memory', '16', '--disk', '50GB'])
  })

  it('throws OrbCommandError when a command fails', async () => {
    const fake = createFakeOrb()
    await fake.orb.createMachine('boom', 'ubuntu')
    // Creating a machine that already exists is a hard failure.
    await expect(fake.orb.createMachine('boom', 'ubuntu')).rejects.toBeInstanceOf(OrbCommandError)
  })

  it('treats delete and stop as idempotent', async () => {
    const fake = createFakeOrb()
    await fake.orb.createMachine('gone', 'ubuntu')
    // Both should resolve even when the machine is already absent.
    await expect(fake.orb.deleteMachine('gone')).resolves.toBeUndefined()
    await expect(fake.orb.deleteMachine('gone')).resolves.toBeUndefined()
    await expect(fake.orb.stop('never-existed')).resolves.toBeUndefined()
  })

  it('does not throw when allowFailure is set', async () => {
    const fake = createFakeOrb()
    const res = await fake.orb.exec(['delete', 'ghost'], { allowFailure: true })
    expect(res.code).not.toBe(0)
  })

  it('streams stdin to a child process', async () => {
    const fake = createFakeOrb()
    const payload = Buffer.from('a'.repeat(2048))
    const res = await fake.orb.exec(['run', '-m', 'x', 'bash', '-lc', 'cat'], { input: payload })
    expect(res.code).toBe(0)
    expect(fake.stdinBytes()).toBe(2048)
  })

  it('surfaces ENOENT as OrbStackMissingError', async () => {
    const missing = new Orb({ bin: '/definitely/not/here/orb', logger: silentLogger })
    await expect(missing.exec(['version'])).rejects.toBeInstanceOf(OrbStackMissingError)
  })

  it('honours dry-run without touching the machine', async () => {
    const fake = createFakeOrb()
    const dry = new Orb({ bin: process.execPath, logger: silentLogger, dryRun: true })
    const result = await dry.exec(['create', 'ubuntu', 'never'], {})
    expect(result.code).toBe(0)
    // The real spawn is skipped, so nothing was recorded.
    expect(fake.calls()).toHaveLength(0)
  })

  it('reports a machine as missing when ensureRunning is called for an unknown name', async () => {
    const fake = createFakeOrb()
    await expect(fake.orb.ensureRunning('ghost')).rejects.toThrow(/does not exist/)
  })
})
