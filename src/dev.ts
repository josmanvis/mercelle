import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createBackend } from './backend.js'
import { guardEnv, loadEnvFiles, toEnvPrefix, vercelSystemEnv } from './env.js'
import { MercelleError } from './errors.js'
import { c, consoleLogger } from './logger.js'
import { resolveProject } from './project.js'
import type { Logger, MercelleConfig, ResolvedProject, VmBackend } from './types.js'
import { shellQuote, VmManager, NODE_PATH_PRELUDE } from './vm.js'
import { watchProject } from './watch.js'

export interface DevOptions {
  config: MercelleConfig
  cwd?: string
  logger?: Logger
  /** Inject a backend (tests); otherwise one is chosen from config. */
  orb?: VmBackend
}

/**
 * Build the exact command line the app runs inside the VM.
 *
 * Two PATH problems have to be solved for a non-interactive login shell:
 *  - nvm is not loaded, so `node`/`npm` are missing entirely;
 *  - the project's node_modules/.bin is not on PATH, so a dev command naming a
 *    local tool directly (`tsx src/cli.ts`) cannot resolve it. `npm run` adds
 *    that itself, but a bare command does not.
 */
export function buildDevCommandLine(opts: {
  remoteRoot: string
  env: Record<string, string>
  devCommand: string
  port: number
}): string {
  const { remoteRoot, env, devCommand, port } = opts
  return [
    `cd ${shellQuote(remoteRoot)}`,
    NODE_PATH_PRELUDE,
    toEnvPrefix(env),
    // Double quotes so $PATH expands at runtime; toEnvPrefix single-quotes
    // values, which would freeze the literal text "${PATH}" into the PATH.
    `export PATH="${remoteRoot}/node_modules/.bin":\$PATH`,
    // Record the PID that is about to become the dev server. `exec` keeps the
    // same PID, so this file always names the process holding the port — which
    // is the only reliable way to stop it, since matching on the listening
    // socket races the server's own startup.
    `echo $$ > ${devPidFile(port)}`,
    `exec ${devCommand} --port ${port}`,
  ].join(' && ')
}

/** Path (inside the VM) of the file holding the running dev server's PID. */
export function devPidFile(port: number): string {
  return `/tmp/mercelle-dev-${port}.pid`
}

export interface DevResult {
  project: ResolvedProject
  url: string
  orbUrl: string
  hostPort: number
  exitCode: number
}

/**
 * Refuse to run mercelle inside a mercelle VM, or to point mercelle at its own
 * source tree.
 *
 * mercelle's own `dev` script is `tsx src/cli.ts`, so `mercelle dev` in this
 * repo would boot a VM and then run mercelle *again* inside it — where there is
 * no `limactl`, surfacing as a bare "spawnSync limactl ENOENT" with no clue as
 * to why. Both cases are caught up front and explained.
 */
export function assertNotNested(project: ResolvedProject): void {
  if (process.env.MERCELLE === '1') {
    throw new MercelleError('mercelle is already running inside a mercelle VM.', [
      'Running it again would nest one mercelle inside another.',
      'On the Mac, run:  mercelle down   (then re-run your command)',
    ])
  }

  // The project is mercelle itself: its package name plus its own CLI entry.
  if (project.root && existsSync(join(project.root, 'skill', 'SKILL.md')) && existsSync(join(project.root, 'src', 'cli.ts'))) {
    throw new MercelleError('This is mercelle\'s own source tree.', [
      '`mercelle dev` here would start mercelle inside a VM, which cannot work.',
      'To run mercelle itself on macOS:  npm run dev --prefix /path/to/mercelle',
      'To test another app:               cd into that app, then run mercelle',
    ])
  }
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

  const merged = {
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

  // Strip anything that would give the VM a production database or host.
  return guardEnv(merged).safe
}

/**
 * Like buildAppEnv, but also reports values dropped by the production guard.
 * The CLI uses this so a blocked credential is visible rather than silent.
 */
export function buildAppEnvWithReport(
  project: ResolvedProject,
  config: MercelleConfig,
  hostPort: number,
): { env: Record<string, string>; rejected: { key: string; reason: string }[] } {
  const fileEnv = loadEnvFiles(project.root)
  const forwarded: Record<string, string> = {}
  for (const key of config.forwardEnv) {
    const value = process.env[key]
    if (value !== undefined) forwarded[key] = value
  }

  const { safe, rejected } = guardEnv({
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
  })

  return { env: safe, rejected }
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

  assertNotNested(project)

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
  await orb.setHttpPort?.(project.machine, hostPort, config.port)

  const { env, rejected } = buildAppEnvWithReport(project, config, hostPort)

  // Tell the user loudly if a production credential was withheld.
  for (const r of rejected) {
    log.warn(`${r.reason}`)
  }

  // OrbStack exposes a per-machine hostname; other backends only forward ports.
  const isOrbStack = orb.name === 'orbstack'
  const vmHost = isOrbStack ? `${project.machine}.orb.local` : 'localhost'
  const vmUrl = `http://${vmHost}:${hostPort}`

  /** The exact command line the app runs inside the VM. */
  const devCommandLine = buildDevCommandLine({
    remoteRoot,
    env,
    devCommand: project.devCommand,
    port: config.port,
  })

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
 * How long the restart guard stays closed after a restart begins.
 *
 * A single save can produce more than one watcher event (editors often write a
 * temp file and rename it). Acting on the second event would start a second dev
 * server on the same port, so the duplicate is swallowed for this long.
 */
const RESTART_GUARD_MS = 750

/**
 * Run the dev server under a file watcher: each save re-syncs changed files
 * into the VM and restarts the process so the app picks them up.
 */
async function runWatching(args: WatchArgs): Promise<DevResult> {
  const { config, log, project, orb, vm, remoteRoot, devCommandLine, hostPort } = args

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

  /**
   * Stop the dev server.
   *
   * Killing the local `limactl`/`orb` client is not enough: it only tears down
   * the SSH connection, while the app keeps running *inside* the VM and keeps
   * holding the port, so the next start dies with EADDRINUSE.
   *
   * The dev server writes its own PID to a file (see buildDevCommandLine), so we
   * kill that exact process. Discovering it from the listening socket instead is
   * unreliable: the lookup races the server's startup and can return nothing,
   * leaving the old server alive. The port is then polled until it is really
   * free before the new server is allowed to bind.
   */
  const stop = async (): Promise<void> => {
    const current = child
    child = null
    if (!current) return
    current.kill('SIGTERM')
    // Escalate if the local client ignores SIGTERM.
    setTimeout(() => current.kill('SIGKILL'), 5000).unref?.()

    const port = String(config.port)
    const pidFile = devPidFile(config.port)
    // Fall back to the listening socket in case the pid file is missing (an
    // older run, or a server that died before it could write one).
    const findPids = `(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep ":$port " | grep -o "pid=[0-9]*" | cut -d= -f2 | sort -u`
    const script = [
      // Give the previous server a moment to write its pid file.
      `for w in $(seq 1 20); do [ -s ${pidFile} ] && break; sleep 0.1; done`,
      `pids=$(cat ${pidFile} 2>/dev/null)`,
      `[ -z "$pids" ] && pids=$(${findPids})`,
      `[ -n "$pids" ] && kill $pids 2>/dev/null`,
      // Wait for the port to be released before returning, otherwise the new
      // server starts while the old one still holds it.
      `for i in $(seq 1 60); do`,
      `  [ -z "$(${findPids})" ] && break`,
      `  if [ $i -eq 10 ] || [ $i -eq 30 ]; then`,
      `    [ -n "$pids" ] && kill -9 $pids 2>/dev/null`,
      `  fi`,
      `  sleep 0.1`,
      `done`,
      `rm -f ${pidFile}`,
      `true`,
    ].join('\n')

    await orb
      .run(project.machine, script, { allowFailure: true })
      .catch(() => ({ code: 1, stdout: '', stderr: '' }))
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
        // A restart can trip the watcher again (the sync writes into the project
        // tree, and the editor may emit a second event for one save). Leave the
        // guard closed briefly so a duplicate event cannot start a second dev
        // server on the same port, which would fail with EADDRINUSE.
        await new Promise((r) => setTimeout(r, RESTART_GUARD_MS))
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
