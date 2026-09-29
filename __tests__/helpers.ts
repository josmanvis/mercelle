import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Orb } from '../src/orb.js'
import { Orb as OrbClass } from '../src/orb.js'
import type { Logger } from '../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE_ORB = join(here, 'fixtures', 'fake-orb.mjs')

// Make sure the fixture is executable even if the repo was cloned without the bit.
try {
  chmodSync(FAKE_ORB, 0o755)
} catch {
  /* best effort */
}

export interface FakeOrb {
  orb: Orb
  stateDir: string
  /** Every argv the fake received, one JSON array per line. */
  calls: () => string[][]
  /** Machines currently recorded as existing. */
  machines: () => { name: string; distro: string; state: string }[]
  /** Commands passed to `orb run`, as "machine: script" lines. */
  runScripts: () => string[]
  /** Scripted stdout for a machine's `run` calls. */
  setStdout: (machine: string, text: string) => void
  /** Make `run` fail for a machine. */
  setFail: (machine: string, fail: boolean) => void
  /** Toggle whether node_modules appear installed. */
  setModulesPresent: (present: boolean) => void
  /** Keys set via `orb config set`. */
  configEntries: () => string[]
  /** Bytes the fake received on stdin. */
  stdinBytes: () => number
}

/** A Logger that swallows output so tests stay readable. */
export const silentLogger: Logger = {
  info: () => {},
  success: () => {},
  warn: () => {},
  error: () => {},
  step: () => {},
  raw: () => {},
}

/** Create an Orb instance wired to the fake binary with isolated state. */
export function createFakeOrb(): FakeOrb {
  const stateDir = mkdtempSync(join(tmpdir(), 'mercelle-orb-'))
  const orb = new OrbClass({ bin: process.execPath, logger: silentLogger })

  // Wrap exec so every invocation goes through the node shim that sets
  // FAKE_ORB_STATE, keeping the real spawn semantics intact.
  const originalExec = orb.exec.bind(orb)
  orb.exec = (async (args: string[], opts = {}) =>
    originalExec([FAKE_ORB, ...args], { ...opts, env: { ...process.env, FAKE_ORB_STATE: stateDir } })) as typeof orb.exec

  const readLines = (file: string): string[] => {
    const p = join(stateDir, file)
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8').split('\n').filter(Boolean)
  }

  return {
    orb,
    stateDir,
    calls: () => readLines('calls.log').map((l) => JSON.parse(l) as string[]),
    machines: () => (existsSync(join(stateDir, 'machines.json')) ? JSON.parse(readFileSync(join(stateDir, 'machines.json'), 'utf8')) : []),
    runScripts: () => readLines('run.log'),
    setStdout: (machine, text) => writeFileSync(join(stateDir, `${machine}.stdout`), text),
    setFail: (machine, fail) => {
      const p = join(stateDir, `${machine}.fail`)
      if (fail) writeFileSync(p, 'fail')
      else if (existsSync(p)) spawnSync('rm', ['-f', p])
    },
    setModulesPresent: (present) => {
      const p = join(stateDir, 'no_modules')
      if (!present) writeFileSync(p, '1')
      else if (existsSync(p)) spawnSync('rm', ['-f', p])
    },
    configEntries: () => readLines('config.log'),
    stdinBytes: () => {
      const p = join(stateDir, 'stdin.bin')
      return existsSync(p) ? readFileSync(p).length : 0
    },
  }
}
