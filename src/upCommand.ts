import { c } from './logger.js'
import { assertNotNested, buildAppEnvWithReport } from './dev.js'
import { resolveProject } from './project.js'
import { NODE_PATH_PRELUDE, VmManager, shellQuote } from './vm.js'
import { toEnvPrefix } from './env.js'
import { join } from 'node:path'
import type { Logger, MercelleConfig, VmBackend } from './types.js'

export interface UpOptions {
  cwd: string
  config: MercelleConfig
  orb: VmBackend
  logger: Logger
}

/**
 * `mercelle up [<dir>]` — bring an app up inside the VM and leave it running.
 *
 * This is the "test it on mercelle before it goes to Vercel" path. Unlike
 * `mercelle dev` it is not a foreground watcher: the app is started in the
 * background with a log file and a pid file, exactly as a deployment would be,
 * and the command returns once the app is serving.
 *
 * It previously only created the VM and installed the toolchain, which meant
 * `up` never actually ran anything.
 */
export async function upCommand(opts: UpOptions): Promise<number> {
  const { cwd, config, orb, logger: log } = opts
  const project = resolveProject(cwd)
  assertNotNested(project)
  const vm = new VmManager({ orb, config, project, logger: log })

  await vm.ensureMachine()
  const home = await vm.getHome()
  const remoteRoot = await vm.remoteRoot(home)
  await vm.provision()
  log.success(`VM ${c.bold(project.machine)} is ready.`)

  // In mount mode the Linux node_modules has to exist before deps are installed.
  await vm.prepareMount(home)
  await vm.syncToVm(remoteRoot)

  const hasModules = await orb.run(
    project.machine,
    `test -d ${shellQuote(join(remoteRoot, 'node_modules'))}`,
    { allowFailure: true },
  )
  if (hasModules.code !== 0 || config.reinstall) {
    await vm.installDeps(remoteRoot)
  } else {
    log.step('Dependencies already installed in the VM.')
  }

  const hostPort = config.hostPort ?? config.port
  await orb.setHttpPort?.(project.machine, hostPort, config.port)

  const { env, rejected } = buildAppEnvWithReport(project, config, hostPort)
  for (const r of rejected) log.warn(r.reason)

  // Start it in the background. A previous run of this app is stopped first, so
  // `up` is safe to repeat and never leaves two servers fighting for the port.
  const logFile = appLogFile(project.machine)
  const setup = [
    `cd ${shellQuote(remoteRoot)}`,
    NODE_PATH_PRELUDE,
    toEnvPrefix(env),
    `export PATH="${remoteRoot}/node_modules/.bin":$PATH`,
  ].join(' && ')
  // `&` terminates a command, so the launch cannot be followed by `&&`.
  const script = `${setup}; nohup ${project.devCommand} > ${logFile} 2>&1 & echo $!`

  const res = await orb.run(project.machine, script, { allowFailure: true })
  if (res.code !== 0) {
    log.error(`${project.machine}: failed to start ${c.bold(project.devCommand)}`)
    log.info(c.dim(`  See the output with:  mercelle logs ${project.machine}`))
    return 1
  }

  const pid = res.stdout.trim()

  // A pid is not proof of a running app. The process can die a moment later —
  // most often EADDRINUSE, because something already holds the port inside the
  // VM. Check the *pid we launched* is still alive: probing the port is no good,
  // because whatever already held it would answer and look healthy.
  const healthy = await waitForProcess(orb, project.machine, pid, 6000)
  if (!healthy.ok) {
    log.error(`${project.machine} started (pid ${pid}) but is not serving on port ${config.port}.`)
    const tail = await orb.run(
      project.machine,
      // The interesting line is the error itself, which sits at the top of a
      // stack trace; the frames underneath are noise.
      `grep -m1 -E "Error|EADDR" ${logFile} 2>/dev/null`,
      { allowFailure: true },
    )
    if (tail.stdout.trim()) {
      log.info('')
      log.info(`  ${c.red(tail.stdout.trim())}`)
    }
    if (/EADDRINUSE/.test(tail.stdout)) {
      log.info('')
      log.info(`  Port ${config.port} is already taken inside the VM.`)
      log.info(c.dim(`  Pick another:  mercelle up --port ${config.port + 1} --host-port ${config.port + 1}`))
    }
    return 1
  }

  log.info('')
  log.info(`  ${c.bold('Local')}   ${c.cyan(`http://localhost:${hostPort}`)}`)
  log.info(`  ${c.bold('app')}     ${c.dim(`(${project.framework}, ${project.packageManager})`)}`)
  log.info(`  ${c.bold('pid')}     ${pid}`)
  log.info(`  ${c.bold('logs')}    ${c.dim(logFile)} ${c.dim('(inside the VM)')}`)
  log.info('')
  log.info(c.dim('  It keeps running after this command exits. Stop it with mercelle down.'))
  log.info(c.dim('  Follow the logs with:  mercelle logs'))

  return 0
}

/** Where an app's output is written inside the VM. */
export function appLogFile(machine: string): string {
  return `/tmp/mercelle-${machine}.log`
}

/** Where the running app's PID is recorded inside the VM. */
export function appPidFile(machine: string): string {
  return `/tmp/mercelle-${machine}.pid`
}

export interface LogsOptions {
  cwd: string
  config: MercelleConfig
  orb: VmBackend
  logger: Logger
  /** Only stream this machine's log. */
  only?: string
  /** How many lines of history to replay per app. */
  lines?: number
}

/**
 * `mercelle logs` — tail the output of everything running in the VM.
 *
 * This is the "what is actually happening across all my apps" view: every
 * mercelle-started service in one stream, prefixed with its name, so a request
 * failing in one service is visible next to the caller that made it.
 */
export async function logsCommand(opts: LogsOptions): Promise<number> {
  const { orb, logger: log } = opts
  const machines = await orb.list()
  if (machines.length === 0) {
    log.error('No mercelle VMs exist yet. Run `mercelle up` in a project first.')
    return 1
  }

  // Only tail VMs that are actually up. Asking a stopped instance to stream
  // prints limactl's "instance is stopped" fatal to stderr and yields nothing,
  // which buried the real output under noise from every old VM.
  const up = await Promise.all(machines.map(async (m) => ({ m, ok: await isRunning(orb, m) })))
  const running = up.filter((u) => u.ok).map((u) => u.m)

  const targets = opts.only ? running.filter((m) => m === opts.only) : running
  if (targets.length === 0) {
    if (opts.only) {
      log.error(`${opts.only} is not running. Start it with: mercelle up`)
    } else {
      log.error('No mercelle VMs are running. Bring one up with: mercelle up')
    }
    return 1
  }

  const lines = opts.lines ?? 20
  log.info('')
  log.info(c.dim(`  Tailing ${targets.length} app log${targets.length === 1 ? '' : 's'}. Ctrl-C to stop.`))
  log.info('')

  // One shell per machine, streaming with the machine name as a prefix. The
  // guest-side loop re-reads the file so a rotated or appended log keeps up.
  let carry = ''
  const handles = targets.map((machine) =>
    orb.spawn?.(
      machine,
      [
        `f=${appLogFile(machine)}`,
        // Show the tail we already have, then follow.
        `tail -n ${lines} "$f" 2>/dev/null || echo "(no log yet for ${machine})"`,
        `tail -f "$f" 2>/dev/null`,
      ].join('\n'),
      {
        onStdout: (chunk: Buffer) => {
          // Chunks do not respect line boundaries, so hold a partial tail and
          // prefix each line separately — otherwise several log lines arrive
          // fused together on one row.
          const parts = (carry + chunk.toString()).split('\n')
          carry = parts.pop() ?? ''
          for (const line of parts) {
            if (line.trim()) log.raw(`${c.cyan(machine.padEnd(22))} ${line}\n`)
          }
        },
        onStderr: (chunk: Buffer) => log.raw(chunk.toString()),
        onClose: () => process.exit(0),
      },
    ),
  )

  const active = handles.filter(Boolean)
  if (active.length === 0) {
    log.error('This backend cannot stream logs.')
    return 1
  }


  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      for (const h of active) h?.kill('SIGTERM')
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
  return 0
}


/** True when a machine is up and will accept a command. */
async function isRunning(orb: VmBackend, machine: string): Promise<boolean> {
  try {
    const res = await orb.run(machine, 'true', { allowFailure: true })
    return res.code === 0
  } catch {
    return false
  }
}

/**
 * Wait for a freshly launched process to still be alive.
 *
 * Probing the port is not enough: when something already held it (the usual
 * cause of the failure we are trying to catch) the probe would succeed and
 * mercelle would happily print a URL that never serves this app. Liveness of
 * the pid we just started is the honest signal.
 */
export async function waitForProcess(
  orb: VmBackend,
  machine: string,
  pid: string,
  timeoutMs = 6000,
): Promise<{ ok: boolean }> {
  if (!/^\d+$/.test(pid.trim())) return { ok: false }
  const deadline = Date.now() + timeoutMs
  const probe = `kill -0 ${pid.trim()} 2>/dev/null && echo alive || echo gone`
  while (Date.now() < deadline) {
    try {
      const res = await orb.run(machine, probe, { allowFailure: true })
      if (res.stdout.trim().endsWith('alive')) return { ok: true }
      // It answered "gone" on the first probe: the app is not coming up.
      return { ok: false }
    } catch {
      /* retry until the deadline */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return { ok: false }
}
