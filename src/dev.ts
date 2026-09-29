import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createBackend } from './backend.js'
import { loadEnvFiles, toEnvPrefix, vercelSystemEnv } from './env.js'
import { MercelleError } from './errors.js'
import { c, consoleLogger } from './logger.js'
import { resolveProject } from './project.js'
import type { Logger, MercelleConfig, ResolvedProject, VmBackend } from './types.js'
import { shellQuote, VmManager } from './vm.js'
import { watchProject } from './watch.js'

export interface DevOptions {
  config: MercelleConfig
  cwd?: string
  logger?: Logger
  /** Inject a backend (tests); otherwise one is chosen from config. */
  orb?: VmBackend
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
 * Run the app's dev server inside a Linux VM.
 *
 * Both supported backends forward the VM's listening ports to macOS
 * automatically, so the app is reachable at `localhost:<port>` on the host with
 * no port-forwarding setup.
 */
export async function dev(opts: DevOptions): Promise<DevResult> {
  const log = opts.logger ?? consoleLogger
  const config = opts.config
  const project = resolveProject(opts.cwd ?? process.cwd(), {
    packageManager: config.packageManager !== 'npm' ? config.packageManager : undefined,
  })

  const orb = opts.orb ?? (await createBackend(config, log))

  const hostPort = config.hostPort ?? config.port
  const vm = new VmManager({ orb, config, project, logger: log })

  await vm.ensureMachine()
  const home = await vm.getHome()
  const remoteRoot = await vm.remoteRoot(home)

  await vm.provision()
  // In mount mode this must happen before install, so node_modules resolves to a
  // Linux directory rather than any macOS install sitting in the project.
  await vm.prepareMount(home)
  await vm.syncToVm(remoteRoot)

  // Skip reinstall when a Linux node_modules already exists, unless forced.
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

  // Give the machine a stable local hostname for the port we are serving.
  // Backends that forward ports automatically make this a no-op.
  await orb.setHttpPort?.(project.machine, hostPort)

  const env = buildAppEnv(project, config, hostPort)

  // OrbStack exposes a per-machine hostname; other backends only forward ports.
  const isOrbStack = orb.name === 'orbstack'
  const vmHost = isOrbStack ? `${project.machine}.orb.local` : 'localhost'
  const vmUrl = `http://${vmHost}:${hostPort}`

  /** The exact command line the app runs inside the VM. */
  const devCommandLine = [
    `cd ${shellQuote(remoteRoot)}`,
    toEnvPrefix(env),
    `exec ${project.devCommand} --port ${config.port}`,
  ].join(' && ')

  log.info(`\n  ${c.bold('Local')}   ${c.cyan(`http://localhost:${hostPort}`)}`)
  if (isOrbStack) {
    log.info(`  ${c.bold('orb.local')} ${c.cyan(`http://${vmHost}:${hostPort}`)}`)
  }
  log.info(`  ${c.bold('VM')}      ${orb.name} ${c.dim(`(${project.framework}, ${project.packageManager})`)}\n`)

  // In watch mode, start the server in the background and restart it on change.
  // In `once` mode, run it in the foreground and return when it exits.
  if (config.watch && !config.once) {
    return runWatching({ config, log, project, orb, vm, remoteRoot, devCommandLine, hostPort })
  }

  const res = await orb.run(project.machine, devCommandLine, { stream: true })

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
  log: Logger
  project: ResolvedProject
  orb: VmBackend
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

  let child: NonNullable<ReturnType<NonNullable<VmBackend['spawn']>>> | null = null

  const start = () => {
    // The VM's stdio is forwarded, so the app's output lands here.
    child = orb.spawn?.(project.machine, devCommandLine, {
      onStdout: (chunk: Buffer) => log.raw(chunk.toString()),
      onStderr: (chunk: Buffer) => log.raw(chunk.toString()),
      onClose: (code: number) => {
        // A close during a restart is expected; don't warn about it.
        if (!restarting) log.warn(`Dev server exited with code ${code}.`)
      },
    }) ?? null
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
        // In mount mode the VM already sees the edited files, so there is
        // nothing to copy; just restart the process.
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
