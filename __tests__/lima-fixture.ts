import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A fake `limactl` that logs its argv and answers the probes mercelle makes.
 * Writing it as a real executable means the Lima backend is exercised through
 * an actual subprocess, matching how the OrbStack tests work.
 */
export function createFakeLima(): { shim: string; stateDir: string; calls: () => string; runScripts: () => string[] } {
  const stateDir = mkdtempSync(join(tmpdir(), 'mercelle-lima-'))
  mkdirSync(stateDir, { recursive: true })

  const script = join(stateDir, 'limactl.mjs')
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const state = process.env.FAKE_LIMA_STATE
mkdirSync(state, { recursive: true })
const argv = process.argv.slice(2)
appendFileSync(join(state, 'calls.log'), JSON.stringify(argv) + '\\n')
const cmd = argv[0]
const machinesFile = join(state, 'machines.json')
const read = () => (existsSync(machinesFile) ? JSON.parse(readFileSync(machinesFile, 'utf8')) : [])
const write = (m) => writeFileSync(machinesFile, JSON.stringify(m))

if (cmd === '--version') { console.log('limactl version 2.2.0'); process.exit(0) }

if (cmd === 'create' && argv.includes('--list-drivers')) {
  // This machine is Intel: Lima offers only qemu here.
  console.log('qemu')
  process.exit(0)
}

if (cmd === 'list') {
  if (argv.includes('--json')) {
    // Real \`limactl list --json\` emits newline-delimited JSON — one flat
    // object per instance — not a wrapper with an "instances" array.
    for (const n of read()) console.log(JSON.stringify({ name: n, status: 'Running' }))
  } else {
    console.log(read().join('\\n'))
  }
  process.exit(0)
}

if (cmd === 'create') {
  const name = argv[argv.indexOf('--name') + 1]
  if (!name) { console.error('missing --name'); process.exit(1) }
  write([...read(), name])
  console.log('created ' + name)
  process.exit(0)
}

if (cmd === 'start' || cmd === 'stop' || cmd === 'delete') {
  const name = argv[1]
  if (cmd === 'delete') { write(read().filter((n) => n !== name)); process.exit(0) }
  if (!read().includes(name)) { console.error('no such instance'); process.exit(1) }
  process.exit(0)
}

if (cmd === 'shell') {
  // Real limactl takes flags before the instance name, so the first
  // non-flag argument is the instance and everything after it is the command.
  const rest = argv.slice(1)
  const nameIdx = rest.findIndex((a) => !a.startsWith('-'))
  const name = rest[nameIdx]
  const after = rest.slice(nameIdx + 1)
  // Only --tty is the trap: limactl passes it through to bash, which dies with
  // "--: invalid option". The command's own flags (bash -lc) are legitimate.
  if (after.some((a) => a.startsWith('--tty'))) {
    console.error('unsupported: --tty after instance name in shell')
    process.exit(1)
  }
  const script2 = after[after.length - 1] || ''
  // Only wait on stdin when the caller is streaming an archive. Otherwise the
  // parent may leave stdin open, and waiting would hang the command forever.
  if (process.env.FAKE_LIMA_READ_STDIN === '1') {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => {
      if (chunks.length) writeFileSync(join(state, 'stdin.bin'), Buffer.concat(chunks))
      respond()
    })
  } else {
    respond()
  }

  function respond() {
    if (existsSync(join(state, name + '.fail'))) { console.error('scripted failure'); process.exit(1) }
    if (script2.includes('echo $HOME')) console.log('/home/user.linux')
    else if (script2.includes('node -v')) console.log('v22.11.0')
    appendFileSync(join(state, 'run.log'), name + ': ' + script2 + '\\n')
    console.log('[lima] ' + script2.split('\\n')[0])
    process.exit(0)
  }
  process.exit(0)
}

console.error('unsupported: ' + cmd)
process.exit(1)
`,
  )

  // A /bin/sh shim so Lima can invoke the .mjs directly as a "binary".
  const shim = join(stateDir, 'limactl')
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
  process.env.FAKE_LIMA_STATE = stateDir

  const readLines = (file: string): string[] => {
    try {
      return readFileSync(join(stateDir, file), 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  return {
    shim,
    stateDir,
    calls: () => readLines('calls.log').join('\n'),
    runScripts: () => readLines('run.log'),
  }
}

/** The fake shell: make it read stdin (to capture streamed archives). */
export function fakeLimaReadsStdin(): void {
  process.env.FAKE_LIMA_READ_STDIN = '1'
}
