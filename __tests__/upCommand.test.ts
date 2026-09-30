import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appLogFile, waitForProcess } from '../src/upCommand.js'
import { assertNotNested } from '../src/dev.js'
import type { ResolvedProject, VmBackend } from '../src/types.js'

const savedEnv = { ...process.env }
afterEach(() => {
  process.env = { ...savedEnv }
})

/** A backend whose `run` answers with whatever the test wants. */
function backend(reply: (command: string) => { code: number; stdout: string }): VmBackend {
  return {
    name: 'lima',
    isInstalled: async () => true,
    list: async () => ['m'],
    create: async () => {},
    start: async () => {},
    stop: async () => {},
    remove: async () => {},
    run: async (_m: string, command: string) => reply(command),
    setHttpPort: async () => {},
    installHint: () => [],
  } as unknown as VmBackend
}

describe('assertNotNested', () => {
  const base: ResolvedProject = {
    root: '/some/app',
    framework: 'node',
    packageManager: 'npm',
    devCommand: 'node s.js',
    buildCommand: '',
    remoteRoot: 'mercelle/app',
    machine: 'mercelle-app',
  }

  it('allows a normal project', () => {
    delete process.env.MERCELLE
    expect(() => assertNotNested(base)).not.toThrow()
  })

  it('refuses to run inside a mercelle VM', () => {
    // Regression: mercelle's own dev script is `tsx src/cli.ts`, so running
    // mercelle in this repo booted a VM and launched mercelle again inside it,
    // where there is no limactl — a bare "spawnSync limactl ENOENT".
    process.env.MERCELLE = '1'
    expect(() => assertNotNested(base)).toThrow(/already running inside a mercelle VM/)
  })

  it('refuses to point mercelle at its own source tree', () => {
    delete process.env.MERCELLE
    const root = mkdtempSync(join(tmpdir(), 'mercelle-self-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'skill'), { recursive: true })
    writeFileSync(join(root, 'src', 'cli.ts'), '//')
    writeFileSync(join(root, 'skill', 'SKILL.md'), '#')
    expect(() => assertNotNested({ ...base, root })).toThrow(/mercelle's own source tree/)
  })
})

describe('waitForProcess', () => {
  it('reports healthy when the launched pid is alive', async () => {
    const orb = backend(() => ({ code: 0, stdout: 'alive\n' }))
    expect(await waitForProcess(orb, 'm', '123', 1000)).toEqual({ ok: true })
  })

  it('reports failure when the process died immediately', async () => {
    // The port-clash case: the app exits at once, and something else already
    // holds the port — so probing the port would wrongly look healthy.
    const orb = backend(() => ({ code: 0, stdout: 'gone\n' }))
    expect(await waitForProcess(orb, 'm', '123', 1000)).toEqual({ ok: false })
  })

  it('rejects a pid it cannot parse rather than probing blindly', async () => {
    let called = false
    const orb = backend(() => {
      called = true
      return { code: 0, stdout: 'alive\n' }
    })
    expect(await waitForProcess(orb, 'm', 'not-a-pid', 500)).toEqual({ ok: false })
    expect(called).toBe(false)
  })

  it('gives up rather than hanging when the VM is unreachable', async () => {
    const orb = backend(() => {
      throw new Error('vm gone')
    })
    expect(await waitForProcess(orb, 'm', '123', 600)).toEqual({ ok: false })
  })
})

describe('appLogFile', () => {
  it('names the log per machine so apps do not overwrite each other', () => {
    expect(appLogFile('mercelle-web')).toBe('/tmp/mercelle-mercelle-web.log')
    expect(appLogFile('mercelle-web')).not.toBe(appLogFile('mercelle-api'))
  })
})
