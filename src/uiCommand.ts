import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Dashboard, tailAppLog } from './dashboard.js'
import { c } from './logger.js'
import { resolveProject } from './project.js'
import type { StackService } from './stack.js'
import type { Logger, MercelleConfig, VmBackend } from './types.js'

export interface UiOptions {
  cwd: string
  config: MercelleConfig
  orb: VmBackend
  logger: Logger
}

/**
 * Show the dashboard for a stack that is already running.
 *
 * The state is read from `.mercelle/stack.json`, which `mercelle stack` writes
 * when it boots the stack. This lets a second terminal (or a fresh mercelle
 * process) attach to a running stack without re-booting anything.
 */
export async function uiCommand(opts: UiOptions): Promise<number> {
  const { cwd, config, orb, logger: log } = opts

  const manifestPath = join(cwd, '.mercelle', 'stack.json')
  if (!existsSync(manifestPath)) {
    log.error(`No mercelle stack found in ${cwd}.`)
    log.info('Run `mercelle stack` first — it starts the dashboard automatically.')
    return 1
  }

  const machine = resolveProject(cwd).machine
  let services: StackService[] = []
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { services?: StackService[] }
    services = Array.isArray(parsed.services) ? parsed.services : []
  } catch {
    log.error(`Could not parse ${manifestPath}.`)
    log.info('Delete it and run `mercelle stack` again.')
    return 1
  }

  if (services.length === 0) {
    log.error('The stack manifest lists no services.')
    log.info('Run `mercelle stack` to boot the stack.')
    return 1
  }

  const dashboard = new Dashboard({
    port: config.uiPort ?? undefined,
    open: config.ui ?? true,
    tail: (app) => tailAppLog(orb, machine, app),
  })
  dashboard.setMeta({ backend: orb.name, machine })
  dashboard.markBooted()

  for (const s of services) {
    dashboard.addApp({
      name: s.name,
      framework: s.framework,
      port: s.port,
      url: `http://localhost:${s.port}`,
      // The manifest only records what was started; liveness is refreshed
      // below by probing each port through the VM.
      status: 'unknown',
      pid: null,
    })
  }

  const started = await dashboard.start()
  log.success(`Dashboard: ${c.cyan(`http://localhost:${started}`)}`)
  log.info(c.dim('Press Ctrl-C to stop the dashboard.'))

  // Refresh liveness (and the DSN guard state) once per poll interval, so the
  // UI reflects an app that has crashed or been stopped since the boot.
  const refresh = async (): Promise<void> => {
    for (const s of services) {
      const res = await orb.run(
        machine,
        `exec 3<>/dev/tcp/127.0.0.1/${s.port} 2>/dev/null && echo open || echo closed`,
        { allowFailure: true },
      )
      const up = res.code === 0 && res.stdout.trim() === 'open'
      dashboard.setAppStatus(s.name, up ? 'running' : 'stopped')
    }
  }

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    log.step('Shutting down…')
    void dashboard.stop().then(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  await refresh()
  const timer = setInterval(() => void refresh(), 3000)
  // Keep the process alive until interrupted; the interval alone would do it,
  // but unref it so shutdown is not delayed by a pending timer tick.
  timer.unref?.()

  await new Promise<void>(() => {})
  return 0
}
