import { existsSync } from 'node:fs'
import { isPortOpen } from './orb.js'
import { c, consoleLogger } from './logger.js'
import { resolveProject } from './project.js'
import type { Logger, MercelleConfig, VmBackend } from './types.js'
import { NODE_VERSION } from './vm.js'

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
      const node = await orb.run(machine, 'node -v', { allowFailure: true })
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
