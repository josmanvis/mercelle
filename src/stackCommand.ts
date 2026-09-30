import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  Dashboard,
  teeLog,
  tailAppLog,
  type DatabaseRow,
  type DomainRow,
} from './dashboard.js'
import { c } from './logger.js'
import { discoverCatalog, readStats, suggestApps } from './catalog.js'
import { discoverStack, writeStackManifest, type StackService } from './stack.js'
import { discoverNetworkGraph, summariseNetwork } from './network.js'
import type { Logger, MercelleConfig, VmBackend } from './types.js'
import { VmManager, NODE_PATH_PRELUDE, shellQuote } from './vm.js'
import { toEnvPrefix } from './env.js'
import { toMachineName } from './project.js'
import { ProjectDetectionError } from './errors.js'
import type { ResolvedProject } from './types.js'
import { guardEnv } from './env.js'
import { domainRoutes, startDomainProxy } from './domains.js'

/**
 * Describe the *workspace* that a stack runs in.
 *
 * `resolveProject` insists on a package.json because a single app always has
 * one. A stack is different: the directory mercelle is pointed at holds several
 * services and usually has no package.json of its own, so requiring one made
 * `mercelle stack` fail on the very layout it is built for. The machine is
 * named after the directory, and the dev/build commands are irrelevant here
 * because each service supplies its own.
 */
export function resolveWorkspaceProject(rootInput: string): ResolvedProject {
  const root = resolve(rootInput)
  if (!existsSync(root)) {
    throw new ProjectDetectionError(`Workspace directory not found: ${root}`)
  }
  const name = basename(root)
  return {
    root,
    framework: 'node',
    packageManager: 'npm',
    devCommand: '',
    buildCommand: '',
    remoteRoot: `mercelle/${toMachineName(name).replace(/^mercelle-/, '')}`,
    machine: toMachineName(name),
  }
}

export interface StackOptions {
  cwd: string
  config: MercelleConfig
  orb: VmBackend
  logger: Logger
  /** Only boot these service names. */
  only?: string[]
  /** Boot these instead of all discovered services. */
  skip?: string[]
  /** Report what would run without starting anything. */
  dryRun?: boolean
}

/**
 * Guess the database behind a service from the same signals the dependency
 * scan uses: prisma/drizzle directories and the dependencies themselves.
 * Pure file reads, so it is safe to call before anything is installed.
 */
export function detectDatabaseProvider(dir: string): string | null {
  let deps: Record<string, string> = {}
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    deps = { ...pkg.dependencies, ...pkg.devDependencies }
  } catch {
    /* treated as "no database" below */
  }

  if (existsSync(join(dir, 'prisma')) || deps['@prisma/client']) return 'prisma'
  if (existsSync(join(dir, 'drizzle')) || deps['drizzle-orm']) return 'drizzle'
  if (deps['mongoose'] || deps['mongodb']) return 'mongodb'
  if (deps['mysql2']) return 'mysql'
  if (deps['pg'] || deps['postgres']) return 'postgres'
  if (deps['redis'] || deps['ioredis']) return 'redis'
  if (deps['better-sqlite3'] || deps['sqlite3']) return 'sqlite'
  return null
}

/**
 * Boot every service in a workspace inside the VM.
 *
 * Each service runs in the same Linux VM, with Linux-installed dependencies and
 * local/synthetic env only. No production data or credentials are used: `.env`
 * files are excluded from the sync, and any value that looks like a production
 * DSN is stripped by the env guard.
 *
 * While the stack spins up, the web dashboard mirrors the boot log; once the
 * services are up it lists every running app, its database and any issues.
 */
export async function stackCommand(opts: StackOptions): Promise<number> {
  const { cwd, config, orb, logger: baseLog } = opts
  const dryRun = opts.dryRun ?? config.dryRun

  const all = discoverStack(cwd)
  if (all.length === 0) {
    baseLog.error(`No runnable services found in ${cwd}.`)
    baseLog.info('Each service needs a package.json with a "dev" script.')
    return 1
  }

  // The dashboard comes up first, so the boot itself is visible in the web UI.
  // The VM name is only known once the project is resolved, so the log-tail
  // hook reads it through a closure that is filled in later.
  let stackMachine = ''
  const dashboard = new Dashboard({
    port: config.uiPort ?? undefined,
    open: config.ui ?? true,
    tail: (app) => tailAppLog(orb, stackMachine, app),
    // Every app's output in one stream, so a failure can be read next to the
    // calls that caused it.
    tailAll: async () => {
      const blocks: string[] = []
      for (const service of services) {
        try {
          const text = await tailAppLog(orb, stackMachine, {
            name: service.name,
            framework: service.framework,
            port: service.port,
            url: '',
            status: 'unknown',
          })
          if (text.trim()) blocks.push(`── ${service.name} ──\n${text.replace(/\n+$/, '')}`)
        } catch {
          /* one unreadable log must not blank the others */
        }
      }
      return blocks.join('\n\n')
    },
  })
  const log = teeLog(baseLog, dashboard)

  let listenPort: number
  try {
    listenPort = await dashboard.start()
  } catch (err) {
    // A dashboard that cannot bind must never take the stack down with it.
    listenPort = 0
    baseLog.warn(`dashboard unavailable: ${(err as Error).message}`)
  }

  const wanted = new Set(opts.only ?? [])
  const skipped = new Set(opts.skip ?? [])
  const services = all
    .filter((s) => (wanted.size > 0 ? wanted.has(s.name) : true))
    .filter((s) => !skipped.has(s.name))

  // Register every app before the boot starts so the UI can show their state
  // transitioning from "starting" to "running" (or "error") live.
  for (const s of services) {
    dashboard.addApp({
      name: s.name,
      framework: s.framework,
      port: s.port,
      url: `http://localhost:${s.port}`,
      status: 'starting',
      pid: null,
    })
  }

  // Databases: derived from the same signals as the service scan (prisma/
  // drizzle directories and dependencies). Production DSNs are always withheld
  // by the env guard, so anything the VM sees is local by construction.
  dashboard.setDatabases(
    services.map((s): DatabaseRow => {
      const provider = detectDatabaseProvider(s.path)
      return provider
        ? { service: s.name, provider, env: 'local', detail: 'runs inside the VM; production DSNs are withheld' }
        : { service: s.name, provider: null, env: 'none', detail: 'no database detected in this service' }
    }),
  )

  log.info(`Discovered ${c.bold(String(all.length))} service${all.length === 1 ? '' : 's'} in ${c.dim(cwd)}`)
  for (const s of services) {
    log.step(`${s.name.padEnd(26)} ${s.framework.padEnd(8)} :${s.port}  ${s.devCommand}`)
  }
  log.info('')
  if (listenPort > 0) log.info(`Dashboard: ${c.cyan(`http://localhost:${listenPort}`)}`)

  // Local axxes domains: <service>.axxes.local, routed by a host-side proxy.
  const routes = domainRoutes(services)
  dashboard.setDomains(routes.map((r) => ({ service: r.service, domain: r.domain, url: r.url })))
  for (const r of routes) {
    const app = services.find((s) => s.name === r.service)
    if (app) dashboard.addApp({ name: app.name, framework: app.framework, port: app.port, url: r.url, status: 'starting', pid: null })
  }

  // How the services are wired to each other, inferred by reading URLs out of
  // the source. Pure file reading, so it works before anything is installed and
  // reflects the checked-out environment rather than a guess.
  try {
    const graph = discoverNetworkGraph(
      services.map((s) => ({
        name: s.name,
        path: s.path,
        port: s.port,
        framework: s.framework,
      })),
      { domainSuffix: config.domainSuffix ?? 'axxes.local' },
    )
    dashboard.setNetwork(graph)
    for (const w of graph.warnings) log.warn(w)
    if (graph.edges.length > 0) {
      log.info(`Network: ${c.dim(summariseNetwork(graph))}`)
    }
  } catch (err) {
    // The map is a nicety; never let it block a boot.
    baseLog.warn(`network discovery failed: ${(err as Error).message}`)
  }

  // QA suggestions from run history across the whole catalog.
  try {
    const devRoot = config.devRoot ?? join(homedir(), 'Developer')
    const catalog = discoverCatalog(devRoot)
    dashboard.setSuggestions(suggestApps(catalog).map((e) => e.name))
  } catch {
    /* suggestions are best-effort */
  }

  if (dryRun) {
    log.info(c.dim('[dry-run] would sync each service and start it inside the VM'))
    await dashboard.stop()
    return 0
  }

  // The stack shares one VM, named after the workspace.
  //
  // A workspace root is not itself an app — it is a directory of apps — so it
  // often has no package.json of its own. resolveWorkspaceProject() handles
  // that instead of failing with "No package.json found".
  const project = resolveWorkspaceProject(cwd)
  stackMachine = project.machine
  const vm = new VmManager({ orb, config, project, logger: log })
  dashboard.setMeta({ backend: orb.name, machine: project.machine })

  await vm.ensureMachine()
  const home = await vm.getHome()
  const remoteBase = `${home}/mercelle-stack`

  await vm.provision()

  // Sync each service, then install its dependencies inside the VM.
  const synced: StackService[] = []
  for (const service of services) {
    const serviceConfig: MercelleConfig = {
      ...config,
      // Each service is treated as its own project root for sync purposes.
      sync: 'copy',
    }
    const serviceVm = new VmManager({
      orb,
      config: serviceConfig,
      // Each service is its own project root, but they all run in the *same*
      // workspace VM. Pointing this at a per-service machine (`<stack>-<svc>`)
      // made every sync and install target a machine that is never created.
      project: { ...project, root: service.path },
      logger: log,
    })

    log.info(`\n${c.bold(service.name)} ${c.dim(`(${service.framework})`)}`)
    try {
      await serviceVm.syncToVm(`${remoteBase}/${service.name}`)
      await serviceVm.installDeps(`${remoteBase}/${service.name}`)
      synced.push(service)
    } catch (err) {
      // One broken service must not stop the rest of the stack.
      dashboard.setAppStatus(service.name, 'error')
      log.error(`${service.name}: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  if (synced.length === 0) {
    log.error('No services could be prepared.')
    await dashboard.stop()
    return 1
  }

  // Record the stack so other tooling (and humans) can see what is running.
  writeStackManifest(synced, `${cwd}/.mercelle/stack.json`)

  // Start every prepared service in the background, each logging to its own file.
  log.info('')
  for (const service of synced) {
    const env = guardEnv({
      VERCEL: '1',
      VERCEL_ENV: 'development',
      MERCELLE: '1',
      MERCELLE_STACK: 'axxes',
      PORT: String(service.port),
    }).safe

    const remoteDir = `${remoteBase}/${service.name}`
    // The backgrounding `&` terminates a command, so it cannot be followed by
    // `&&`. Joining the whole script with `&&` therefore made every service fail
    // with "syntax error near unexpected token `&&`" before it ever started.
    const setup = [
      `cd ${shellQuote(remoteDir)}`,
      // A non-interactive login shell has no nvm, so `node` is not on PATH and
      // services died with "node: command not found". The project's
      // node_modules/.bin has to be added too, for a dev command that names a
      // local tool directly (`tsx src/cli.ts`).
      NODE_PATH_PRELUDE,
      toEnvPrefix(env),
      `export PATH="${remoteDir}/node_modules/.bin":\$PATH`,
    ].join(' && ')
    const script = `${setup}; nohup ${service.devCommand} > /tmp/${service.name}.log 2>&1 & echo $!`

    const res = await orb.run(project.machine, script, { allowFailure: true })
    if (res.code === 0) {
      const pid = res.stdout.trim()
      dashboard.setAppStatus(service.name, 'running', { pid })
      log.success(`${service.name.padEnd(26)} :${service.port}  pid ${pid}`)
    } else {
      dashboard.setAppStatus(service.name, 'error')
      log.error(`${service.name}: failed to start`)
    }
  }

  dashboard.markBooted()
  log.info('')
  log.success(`${synced.length} service${synced.length === 1 ? '' : 's'} starting in the VM.`)

  // Host-side proxy: routes web.axxes.local → the app's port. Best effort;
  // plain localhost URLs keep working if it cannot bind.
  let proxy: ReturnType<typeof startDomainProxy> = null
  try {
    proxy = startDomainProxy(routes, { logger: log })
  } catch (err) {
    log.warn(`domain proxy unavailable: ${(err as Error).message}`)
  }

  log.info('  Local domains:')
  for (const r of routes) {
    log.info(`    ${c.cyan(r.url.padEnd(34))} ${c.dim(`→ ${r.service} (localhost:${r.port})`)}`)
  }
  log.info(c.dim('    Install system-wide:  mercelle domains --install'))
  if (listenPort > 0) log.info(`  Dashboard:           ${c.cyan(`http://localhost:${listenPort}`)}`)
  log.info(`  Logs inside the VM:  mercelle shell  →  tail -f /tmp/<service>.log`)
  log.info(`  Machine: ${project.machine} ${c.dim(`(remote base ${remoteBase})`)}`)

  // A TTY session stays alive so the dashboard (and the stack) keep running.
  // Piped/CI runs exit: there is nobody watching a browser there.
  if (process.stdout.isTTY) {
    let shuttingDown = false
    log.info(c.dim('  Press Ctrl-C to stop the stack and the dashboard.'))
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        if (shuttingDown) return
        shuttingDown = true
        log.step('Shutting down…')
        void Promise.all([dashboard.stop(), proxy?.close() ?? Promise.resolve()]).then(() => resolve())
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    })
    return 0
  }

  await dashboard.stop()
  return 0
}
