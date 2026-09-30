import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkspaceProject } from '../src/stackCommand.js'
import { NODE_PATH_PRELUDE } from '../src/vm.js'
import { toEnvPrefix } from '../src/env.js'

describe('resolveWorkspaceProject', () => {
  it('names the machine after the directory when the root is not a project', () => {
    // Regression: `mercelle stack` failed with "No package.json found" on the
    // very layout it exists for — a directory of apps with no package.json.
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-ws-'))
    const project = resolveWorkspaceProject(dir)
    expect(project.machine).toMatch(/^mercelle-/)
    expect(project.root).toBe(dir)
  })

  it('throws a clear error for a directory that does not exist', () => {
    expect(() => resolveWorkspaceProject('/definitely/not/here')).toThrow(/not found/i)
  })
})

describe('stack service start script', () => {
  /** The exact shape stackCommand builds to launch a service. */
  const buildScript = (remoteDir: string, devCommand: string): string => {
    const setup = [
      `cd '${remoteDir}'`,
      NODE_PATH_PRELUDE,
      toEnvPrefix({ VERCEL: '1', PORT: '3067' }),
      `export PATH="${remoteDir}/node_modules/.bin":$PATH`,
    ].join(' && ')
    return `${setup}; nohup ${devCommand} > /tmp/svc.log 2>&1 & echo $!`
  }

  it('is valid bash: the backgrounding & cannot be followed by &&', () => {
    // Regression: joining every part with " && " put `nohup … &` next to an
    // `&&`, which bash rejects outright, so no stack service ever started.
    const script = buildScript('/tmp/svc', 'node server.js')
    expect(script).not.toMatch(/&\s*&&/)
    expect(execFileSync('bash', ['-n'], { input: script }).toString()).toBe('')
  })

  it('puts node and the local bin directory on PATH', () => {
    // Without nvm, a non-interactive login shell has no `node` at all.
    const script = buildScript('/tmp/svc', 'node server.js')
    expect(script).toContain('nvm.sh')
    expect(script).toMatch(/export PATH="\/tmp\/svc\/node_modules\/\.bin":\$PATH/)
  })

  it('stays syntactically valid for every dev command shape', () => {
    for (const cmd of ['node server.js', 'next dev', 'tsx src/cli.ts', 'npm run dev']) {
      expect(execFileSync('bash', ['-n'], { input: buildScript('/tmp/svc', cmd) }).toString()).toBe('')
    }
  })
})
