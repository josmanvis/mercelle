import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnvFiles, toEnvPrefix, vercelSystemEnv } from './env.js'
import { MercelleError, OrbStackMissingError } from './errors.js'
import { c, consoleLogger } from './logger.js'
import { Orb } from './orb.js'
import { resolveProject } from './project.js'
import type { MercelleConfig, ResolvedProject } from './types.js'
import { shellQuote, VmManager } from './vm.js'
import { watchProject } from './watch.js'

export interface DevOptions {
  config: MercelleConfig
  cwd?: string
  logger?: typeof consoleLogger
  orb?: Orb
}

export interface DevResult {
  project: ResolvedProject
  url: string
  orbUrl: string
  hostPort: number
  exitCode: number
}

/** Build the full environment the app sees inside the VM. */
export function buildAppEnv(
  project: ResolvedProject,
  config: MercelleConfig,
  hostPort: number,
): Record<string, string> {
  const fileEnv = loadEnvFiles(project.root)

  // Only forward host variables the user opted into, never the whole env.
  const forwarded: Record<string, string> = {}
  for (const key of config.forwardEnv) {
    const value = process.env[key]
    if (value !== undefined) forwarded[key] = value
  }

  return {
    ...vercelSystemEnv({
      projectName: project.machine.replace(/^mercelle-/, ''),
      framework: project.framework,
      machine: project.machine,
      port: config.port,
      hostPort,
      region: config.region,
      root: project.root,
    }),
    ...fileEnv,
    ...forwarded,
    ...config.env,
  }
}

/**
 * Run the app's dev server inside the OrbStack VM.
 *
 * OrbStack forwards the VM's listening ports to macOS automatically, so the app
 * is reachable at `localhost:<port>` on the host with no port-forwarding setup.
 */
export async function dev(opts: DevOptions): Promise<DevResult> {
  const log = opts.logger ?? consoleLogger
  const config = opts.config
  const project = resolveProject(opts.cwd ?? process.cwd(), {
    packageManager: config.packageManager !== 'npm' ? config.packageManager : undefined,
  })

  const orb = opts.orb ?? new Orb({ bin: config.orbBin, logger: log, dryRun: config.dryRun })
  if (!(await orb.isInstalled())) {
    throw new OrbStackMissingError('`orb version` did not succeed.')
  }

  const hostPort = config.hostPort ?? config.port
  const vm = new VmManager({ orb, config, project, logger: log })

  await vm.ensureMachine()
  const home = await vm.getHome()
  const remoteRoot = await vm.remoteRoot(home)

  await vm.provision()
  await vm.syncToVm(remoteRoot)

  // Skip reinstall when a Linux node_modules already exists, unless forced.
  const hasModules = await orb.runInMachine(
    project.machine,
    `test -d ${shellQuote(join(remoteRoot, 'node_modules'))}`,
    { allowFailure: true },
  )
  if (hasModules.code !== 0 || config.reinstall) {
    await vm.installDeps(remoteRoot)
  } else {
    log.step('Dependencies already installed in the VM.')
  }

  // Give the machine a stable local hostname for the port we are serving.
  await orb.setHttpPort(project.machine, hostPort)

  const env = buildAppEnv(project, config, hostPort)

  /** The exact command line the app runs inside the VM. */
  const devCommandLine = [
    `cd ${shellQuote(remoteRoot)}`,
    toEnvPrefix(env),
    `exec ${project.devCommand} --port ${config.port}`,
  ].join(' && ')

  log.info(`\n  ${c.bold('Local')}   ${c.cyan(`http://localhost:${hostPort}`)}`)
  log.info(`  ${c.bold('orb.local')} ${c.cyan(`http://${project.machine}.orb.local:${hostPort}`)}`)
  log.info(`  ${c.bold('Framework')} ${project.framework} ${c.dim(`(${project.packageManager})`)}\n`)

  // In watch mode, start the server in the background and restart it on change.
  // In `once` mode, run it in the foreground and return when it exits.
  if (config.watch && !config.once) {
    return runWatching({ config, log, project, orb, vm, remoteRoot, devCommandLine, hostPort })
  }

  const res = await orb.runInMachine(project.machine, devCommandLine, {
    stream: true,
    onLine: (line) => log.raw(`${line}\n`),
  })

  if (res.code !== 0) {
    log.warn(`Dev server exited with code ${res.code}.`)
  }

  return {
    project,
    url: `http://localhost:${hostPort}`,
    orbUrl: `http://${project.machine}.orb.local:${hostPort}`,
    hostPort,
    exitCode: res.code,
  }
}

interface WatchArgs {
  config: MercelleConfig
  log: typeof consoleLogger
  project: ResolvedProject
  orb: Orb
  vm: VmManager
  remoteRoot: string
  devCommandLine: string
  hostPort: number
}

/**
 * Run the dev server under a file watcher: each save re-syncs changed files
 * into the VM and restarts the process so the app picks them up.
 */
async function runWatching(args: WatchArgs): Promise<DevResult> {
  const { log, project, orb, vm, remoteRoot, devCommandLine, hostPort } = args

  let child: ReturnType<Orb['spawnInMachine']> = null

  const start = () => {
    // `orb run` forwards the VM's stdio, so the app's output lands here.
    child = orb.spawnInMachine(project.machine, devCommandLine, {
      onStdout: (chunk) => log.raw(chunk.toString()),
      onStderr: (chunk) => log.raw(chunk.toString()),
      onClose: (code) => {
        // A close during a restart is expected; don't warn about it.
        if (!restarting) log.warn(`Dev server exited with code ${code}.`)
      },
    })
  }

  let restarting = false

  const stop = async (): Promise<void> => {
    const current = child
    child = null
    if (!current) return
    current.kill('SIGTERM')
    // Escalate if the process ignores SIGTERM.
    setTimeout(() => current.kill('SIGKILL'), 5000).unref?.()
  }

  start()

  const watcher = await watchProject({
    root: project.root,
    logger: log,
    onChange: async (files) => {
      if (restarting) return
      restarting = true
      try {
        log.step(`${files.length} file${files.length > 1 ? 's' : ''} changed — restarting in the VM…`)
        await stop()
        await vm.syncToVm(remoteRoot)
        start()
      } finally {
        restarting = false
      }
    },
  })

  // Tear the server and watcher down cleanly on Ctrl-C.
  const shutdown = async () => {
    log.step('Shutting down…')
    await watcher.close()
    await stop()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())

  // Only claim to be watching once chokidar has finished its initial scan,
  // otherwise an edit made in that window would be silently missed.
  await watcher.ready()
  log.step('Watching for changes. Press Ctrl-C to stop.')

  // Block forever; the watcher keeps the process alive.
  await new Promise<void>(() => {})

  return {
    project,
    url: `http://localhost:${hostPort}`,
    orbUrl: `http://${project.machine}.orb.local:${hostPort}`,
    hostPort,
    exitCode: 0,
  }
}
