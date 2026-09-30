import { existsSync } from 'node:fs'
import { isPortOpen } from './orb.js'
import { c, consoleLogger } from './logger.js'
import { resolveProject } from './project.js'
import type { Logger, MercelleConfig, VmBackend } from './types.js'
import { NODE_VERSION, withNodePath } from './vm.js'

export interface DoctorOptions {
  config: MercelleConfig
  cwd: string
  orb: VmBackend
  logger?: Logger
}

interface Check {
  name: string
  ok: boolean
  detail: string
  fatal: boolean
}

/**
 * Verify the environment and explain anything that is wrong.
 *
 * Designed to be safe to run at any time and to never mutate state, so it can
 * be used as a CI preflight check.
 */
export async function doctor(opts: DoctorOptions): Promise<number> {
  const log = opts.logger ?? consoleLogger
  const { config, orb, cwd } = opts
  const checks: Check[] = []

  // 1. Backend availability.
  const installed = await orb.isInstalled()
  checks.push({
    name: orb.name === 'orbstack' ? 'OrbStack' : 'Lima',
    ok: installed,
    detail: installed ? `${orb.name} backend ready` : 'not found',
    fatal: true,
  })

  // 2. Project detection.
  let machine = ''
  try {
    const project = resolveProject(cwd)
    machine = project.machine
    checks.push({
      name: 'Project',
      ok: true,
      detail: `${project.framework} via ${project.packageManager} (${project.machine})`,
      fatal: true,
    })
  } catch (err) {
    checks.push({ name: 'Project', ok: false, detail: (err as Error).message, fatal: true })
  }

  // 2b. On the Lima backend, QEMU has to be on the PATH or nothing can start.
  if (orb.name === 'lima') {
    const qemu = await hasQemu()
    checks.push({
      name: 'QEMU',
      ok: qemu.ok,
      // Fatal: without it no VM can be created or started.
      detail: qemu.ok ? qemu.version : `${qemu.missing} is not on your PATH — run: brew install qemu`,
      fatal: true,
    })
  }

  // 3. VM existence (only meaningful once OrbStack is available).
  if (installed && machine) {
    const exists = await (await orb.list()).includes(machine)
    checks.push({
      name: 'VM',
      ok: exists,
      detail: exists ? `${machine} exists` : `${machine} not created yet (run mercelle up)`,
      fatal: false,
    })

    if (exists) {
      // nvm is not on PATH in a non-interactive login shell, so probe with the
      // same prelude the dev command uses or Node always looks absent.
      const node = await orb.run(machine, withNodePath('node -v'), { allowFailure: true })
      checks.push({
        name: `Node ${NODE_VERSION} in VM`,
        ok: node.code === 0,
        detail: node.code === 0 ? node.stdout.trim() : 'not installed in the VM',
        fatal: false,
      })

      const home = await orb.run(machine, 'echo $HOME', { allowFailure: true })
      checks.push({
        name: 'VM filesystem',
        ok: home.code === 0 && home.stdout.trim().startsWith('/'),
        detail: home.stdout.trim() || 'could not read $HOME',
        fatal: false,
      })
    }
  }

  // 4. Port availability on the host.
  const hostPort = config.hostPort ?? config.port
  const portFree = !(await isPortOpen(hostPort))
  checks.push({
    name: `Port ${hostPort}`,
    ok: portFree,
    detail: portFree ? 'available' : 'already in use on macOS',
    fatal: false,
  })

  // 5. Sync mode sanity.
  if (config.sync === 'mount') {
    checks.push({
      name: 'Sync mode',
      ok: true,
      detail: 'mount (shares macOS files; Linux node_modules still required)',
      fatal: false,
    })
  }

  // Report.
  log.info('')
  for (const check of checks) {
    // The logger already prefixes ✓/!/✗, so don't repeat the mark here.
    const detail = `${check.name.padEnd(18)} ${c.dim(check.detail)}`
    if (check.ok) log.success(detail)
    else if (check.fatal) log.error(detail)
    else log.warn(detail)
  }
  log.info('')

  const failed = checks.filter((check) => !check.ok && check.fatal)
  const warned = checks.filter((check) => !check.ok && !check.fatal)

  if (failed.length > 0) {
    log.error(`${failed.length} blocking issue${failed.length > 1 ? 's' : ''} found.`)
    if (!installed) {
      log.info(c.dim('  Install OrbStack from https://orbstack.dev/download and launch it once.'))
    }
    return 1
  }
  if (warned.length > 0) {
    log.warn(`${warned.length} warning${warned.length > 1 ? 's' : ''}. mercelle can still run.`)
    return 0
  }

  log.success('Everything checks out. Run `mercelle dev`.')
  return 0
}

/** True when this directory looks like something mercelle can run. */
export function isProjectDir(cwd: string): boolean {
  return existsSync(`${cwd}/package.json`)
}

/**
 * Is a QEMU binary for this machine's architecture on the PATH?
 *
 * Lima needs it to run the VM, and it is not installed by default on macOS. A
 * missing binary used to surface as a wall of installer script followed by
 * "instance is stopped", so it is checked up front and reported plainly.
 */
export async function hasQemu(): Promise<{ ok: boolean; version: string; missing: string }> {
  const { execFile } = await import('node:child_process')
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const binary = `qemu-system-${arch}`
  const version = await new Promise<string>((done) => {
    execFile(binary, ['--version'], { timeout: 5000 }, (_err, stdout) => {
      done(String(stdout).split('\n')[0]?.trim() ?? '')
    })
  })
  return { ok: version.length > 0, version: version || binary, missing: binary }
}
