import { c } from './logger.js'
import { discoverStack, writeStackManifest, type StackService } from './stack.js'
import type { Logger, MercelleConfig, VmBackend } from './types.js'
import { VmManager } from './vm.js'
import { toEnvPrefix } from './env.js'
import { resolveProject } from './project.js'
import { guardEnv } from './env.js'

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

/** Where the stack manifest lives inside the VM. */
const REMOTE_STACK_ROOT = '~/mercelle-stack'

/**
 * Boot every service in a workspace inside the VM.
 *
 * Each service runs in the same Linux VM, with Linux-installed dependencies and
 * local/synthetic env only. No production data or credentials are used: `.env`
 * files are excluded from the sync, and any value that looks like a production
 * DSN is stripped by the env guard.
 */
export async function stackCommand(opts: StackOptions): Promise<number> {
  const { cwd, config, orb, logger: log } = opts
  const dryRun = opts.dryRun ?? config.dryRun

  const all = discoverStack(cwd)
  if (all.length === 0) {
    log.error(`No runnable services found in ${cwd}.`)
    log.info('Each service needs a package.json with a "dev" script.')
    return 1
  }

  const wanted = new Set(opts.only ?? [])
  const skipped = new Set(opts.skip ?? [])
  const services = all
    .filter((s) => (wanted.size > 0 ? wanted.has(s.name) : true))
    .filter((s) => !skipped.has(s.name))

  log.info(`Discovered ${c.bold(String(all.length))} service${all.length === 1 ? '' : 's'} in ${c.dim(cwd)}`)
  for (const s of services) {
    log.step(`${s.name.padEnd(26)} ${s.framework.padEnd(8)} :${s.port}  ${s.devCommand}`)
  }
  log.info('')

  if (dryRun) {
    log.info(c.dim('[dry-run] would sync each service and start it inside the VM'))
    return 0
  }

  // The stack shares one VM, named after the workspace.
  const project = resolveProject(cwd)
  const vm = new VmManager({ orb, config, project, logger: log })

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
      project: { ...project, root: service.path, machine: `${project.machine}-${service.name}` },
      logger: log,
    })

    log.info(`\n${c.bold(service.name)} ${c.dim(`(${service.framework})`)}`)
    try {
      await serviceVm.syncToVm(`${remoteBase}/${service.name}`)
      await serviceVm.installDeps(`${remoteBase}/${service.name}`)
      synced.push(service)
    } catch (err) {
      // One broken service must not stop the rest of the stack.
      log.error(`${service.name}: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  if (synced.length === 0) {
    log.error('No services could be prepared.')
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

    const script = [
      `cd ${remoteBase}/${service.name}`,
      toEnvPrefix(env),
      `nohup ${service.devCommand} > /tmp/${service.name}.log 2>&1 &`,
      `echo $!`,
    ].join(' && ')

    const res = await orb.run(project.machine, script, { allowFailure: true })
    if (res.code === 0) {
      log.success(`${service.name.padEnd(26)} :${service.port}  pid ${res.stdout.trim()}`)
    } else {
      log.error(`${service.name}: failed to start`)
    }
  }

  log.info('')
  log.success(`${synced.length} service${synced.length === 1 ? '' : 's'} starting in the VM.`)
  log.info(`  Logs inside the VM:  mercelle shell  →  tail -f /tmp/<service>.log`)
  log.info(`  Machine: ${project.machine} ${c.dim(`(remote base ${remoteBase})`)}`)
  return 0
}
