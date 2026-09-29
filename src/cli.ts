#!/usr/bin/env node
import { parseArgs } from './args.js'
import { dev } from './dev.js'
import { doctor } from './doctor.js'
import { MercelleError } from './errors.js'
import { HELP, VERSION } from './help.js'
import { c, consoleLogger } from './logger.js'
import { resolveConfig } from './loadConfig.js'
import { Orb } from './orb.js'
import { resolveProject } from './project.js'
import { VmManager } from './vm.js'

/** Run the CLI. Returns a process exit code instead of calling process.exit. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { flags, positional } = parseArgs(argv)
  const command = positional[0] ?? 'dev'

  if (flags.version) {
    console.log(VERSION)
    return 0
  }
  if (flags.help || flags.h || command === 'help') {
    console.log(HELP)
    return 0
  }

  const cwd = process.cwd()
  const config = resolveConfig(cwd, flags)
  if (flags.verbose) config.verbose = true
  if (flags.dryRun ?? flags['dry-run']) config.dryRun = true
  if (flags.fresh) config.fresh = true
  if (flags.reinstall) config.reinstall = true
  if (flags.watch === false) config.watch = false
  if (flags.once) config.once = true

  const orb = new Orb({ bin: config.orbBin, dryRun: config.dryRun })
  const log = consoleLogger

  switch (command) {
    case 'dev': {
      const result = await dev({ config, cwd, orb, logger: log })
      return result.exitCode
    }

    case 'up': {
      const project = resolveProject(cwd)
      const vm = new VmManager({ orb, config, project, logger: log })
      await vm.ensureMachine()
      await vm.provision()
      log.success(`VM ${c.bold(project.machine)} is ready.`)
      return 0
    }

    case 'build': {
      const project = resolveProject(cwd)
      const vm = new VmManager({ orb, config, project, logger: log })
      await vm.ensureMachine()
      const remoteRoot = await vm.remoteRoot()
      await vm.syncToVm(remoteRoot)
      await vm.installDeps(remoteRoot)
      const res = await orb.runInMachine(project.machine, `cd '${remoteRoot}' && ${project.buildCommand}`, {
        stream: true,
      })
      return res.code
    }

    case 'shell': {
      const project = resolveProject(cwd)
      await orb.ensureRunning(project.machine)
      await orb.shell(project.machine)
      return 0
    }

    case 'env': {
      const project = resolveProject(cwd)
      const { buildAppEnv } = await import('./dev.js')
      const env = buildAppEnv(project, config, config.hostPort ?? config.port)
      for (const [key, value] of Object.entries(env)) console.log(`${key}=${value}`)
      return 0
    }

    case 'status': {
      const project = resolveProject(cwd)
      const exists = await orb.machineExists(project.machine)
      const port = config.hostPort ?? config.port
      console.log(`VM:        ${project.machine} (${exists ? 'exists' : 'not created'})`)
      console.log(`Framework: ${project.framework}`)
      console.log(`URL:       http://localhost:${port}`)
      return exists ? 0 : 1
    }

    case 'down': {
      const project = resolveProject(cwd)
      await orb.stop(project.machine)
      log.success(`Stopped ${project.machine}.`)
      return 0
    }

    case 'destroy': {
      const project = resolveProject(cwd)
      await orb.deleteMachine(project.machine)
      log.success(`Deleted ${project.machine}.`)
      return 0
    }

    case 'doctor':
      return doctor({ config, cwd, orb, logger: log })

    default:
      log.error(`Unknown command: ${command}`)
      console.log(HELP)
      return 1
  }
}

// Only run when invoked directly, so tests can import `main` safely.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (err instanceof MercelleError) {
        consoleLogger.error(err.message)
        for (const hint of err.hints) consoleLogger.info(c.dim(`  ${hint}`))
        process.exit(1)
      }
      consoleLogger.error((err as Error)?.stack ?? String(err))
      process.exit(1)
    })
}
