#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBackend } from './backend.js'
import { parseArgs } from './args.js'
import { discoverCatalog, recordRun } from './catalog.js'
import { dev, buildAppEnvWithReport } from './dev.js'
import { buildCommandLine } from './build.js'
import { doctor } from './doctor.js'
import { MercelleError } from './errors.js'
import { HELP, VERSION } from './help.js'
import { c, consoleLogger } from './logger.js'
import { resolveConfig } from './loadConfig.js'
import { Orb } from './orb.js'
import { pickApp } from './pick.js'
import { resolveProject } from './project.js'
import { VmManager } from './vm.js'

/** Run the CLI. Returns a process exit code instead of calling process.exit. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { flags, positional } = parseArgs(argv)
  let command = positional[0] ?? 'dev'

  if (flags.version) {
    console.log(VERSION)
    return 0
  }
  if (flags.help || flags.h || command === 'help') {
    console.log(HELP)
    return 0
  }

  let cwd = process.cwd()

  // The magic default: bare `mercelle` outside a project opens the Run App
  // picker instead of failing with a project-detection error.
  if (command === 'dev' && !flags.help) {
    const hasPkg = await import('node:fs').then((fs) => fs.existsSync(join(cwd, 'package.json')))
    if (!hasPkg) {
      command = 'run'
      console.error(`${c.cyan('mercelle')} ${c.dim('no project here — opening the Run App picker…')}`)
    }
  }

  const config = resolveConfig(cwd, flags)
  if (flags.verbose) config.verbose = true
  if (flags.dryRun ?? flags['dry-run']) config.dryRun = true
  if (flags.fresh) config.fresh = true
  if (flags.reinstall) config.reinstall = true
  if (flags.watch === false) config.watch = false
  if (flags.once) config.once = true
  if (flags.ui === false) config.ui = false

  const log = consoleLogger
  const orb = await createBackend(config, log)

  switch (command) {
    case 'run': {
      // `mercelle run` — pick from the catalog or take an explicit path.
      const targetArg = positional[1]
      const catalog = discoverCatalog(targetArg || config.devRoot || undefined)
      let target: string | null = targetArg ?? null

      if (!target) {
        const picked = await pickApp(catalog, {
          stdin: process.stdin,
          stdout: process.stdout,
          interactive: Boolean(process.stdin.isTTY),
        })
        if (!picked) {
          log.error(
            catalog.length === 0
              ? `No runnable projects found under ${config.devRoot ?? '~/Developer'}.`
              : 'No app selected. Pass a path: mercelle run ~/Developer/axxes/web',
          )
          return 1
        }
        target = picked.path
      }

      // Detect the target project, then run it exactly like `dev` does — but
      // from the picked directory, recording the run for suggestions.
      const project = resolveProject(target)
      recordRun(project.root)
      log.success(`Running ${c.bold(project.machine)} ${c.dim(`(${project.framework})`)}`)
      const result = await dev({ config, cwd: project.root, orb, logger: log })
      return result.exitCode
    }

    case 'dev': {
      const result = await dev({ config, cwd, orb, logger: log })
      return result.exitCode
    }

    case 'up': {
      // `mercelle up [<dir>]` — bring an app up inside the VM and leave it
      // running, the way you would deploy it. Defaults to the current directory.
      const { upCommand } = await import('./upCommand.js')
      const target = positional[1]
      if (target) cwd = resolve(dirname(process.cwd()), target)
      return upCommand({ cwd, config, orb, logger: log })
    }

    case 'build': {
      const project = resolveProject(cwd)
      const vm = new VmManager({ orb, config, project, logger: log })
      await vm.ensureMachine()
      await vm.provision()
      const remoteRoot = await vm.remoteRoot()
      await vm.syncToVm(remoteRoot)
      await vm.installDeps(remoteRoot)
      const { env, rejected } = buildAppEnvWithReport(project, config, config.hostPort ?? config.port)
      for (const item of rejected) log.warn(item.reason)
      const res = await orb.run(
        project.machine,
        buildCommandLine(remoteRoot, env, project.buildCommand),
        { stream: true },
      )
      return res.code
    }

    case 'shell': {
      const project = resolveProject(cwd)
      await orb.start(project.machine)
      // Both backends attach an interactive shell to the running VM.
      await orb.run(project.machine, 'exec bash -l', { stream: true })
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
      const exists = (await orb.list()).includes(project.machine)
      const port = config.hostPort ?? config.port
      console.log(`VM:        ${project.machine} (${exists ? 'exists' : 'not created'})`)
      console.log(`Backend:   ${orb.name}`)
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
      await orb.remove(project.machine)
      log.success(`Deleted ${project.machine}.`)
      return 0
    }

    case 'stack': {
      const { stackCommand } = await import('./stackCommand.js')
      return stackCommand({ cwd, config, orb, logger: log })
    }

    case 'ui': {
      const { uiCommand } = await import('./uiCommand.js')
      return uiCommand({ cwd, config, orb, logger: log })
    }

    case 'domains': {
      const { domainsCommand } = await import('./domainsCommand.js')
      return domainsCommand({
        cwd,
        config,
        logger: log,
        install: flags.install === true,
        remove: flags.remove === true,
      })
    }

    case 'data': {
      const { dataCommand } = await import('./dataCommand.js')
      return dataCommand({
        cwd,
        config,
        orb,
        logger: log,
        apply: flags.apply === true,
        rows: flags.rows ? Number(flags.rows) : undefined,
      })
    }

    case 'network': {
      const { networkCommand } = await import('./networkCommand.js')
      return networkCommand({
        cwd,
        config,
        logger: log,
        json: flags.json === true,
        out: typeof flags.out === 'string' ? flags.out : undefined,
      })
    }

    case 'logs': {
      const { logsCommand } = await import('./upCommand.js')
      return logsCommand({
        cwd,
        config,
        orb,
        logger: log,
        only: positional[1],
        lines: flags.lines ? Number(flags.lines) : undefined,
      })
    }

    case 'doctor':
      return doctor({ config, cwd, orb, logger: log })

    default:
      log.error(`Unknown command: ${command}`)
      console.log(HELP)
      return 1
  }
}

/**
 * True when this module is the process entrypoint.
 *
 * Compares *realpath*-resolved paths: when installed via `npm link` (or any
 * symlinked bin), `process.argv[1]` is the symlink while `import.meta.url` is
 * the real file, so a plain string comparison would silently never match and
 * the CLI would do nothing.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false

  // fileURLToPath avoids percent-encoding issues with spaces in the path.
  const self = fileURLToPath(import.meta.url)

  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }

  if (real(entry) === real(self)) return true

  // `npm link` points at dist/cli.js, but also allow running the source via tsx.
  return real(entry) === real(self.replace(/\.js$/, '.ts'))
}

if (isEntryPoint()) {
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
