import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { c } from './logger.js'
import { discoverStack } from './stack.js'
import { generateSeedSql, planSeed } from './seed.js'
import type { MercelleConfig, VmBackend } from './types.js'
import type { Logger } from './types.js'
import { shellQuote } from './vm.js'

export interface DataOptions {
  cwd: string
  config: MercelleConfig
  orb: VmBackend
  logger: Logger
  /** Apply the generated seed inside each VM database. */
  apply?: boolean
  /** Row count per model. */
  rows?: number
}

/**
 * `mercelle data` — mock data for QA.
 *
 * mercelle never clones production data; the env guard keeps prod DSNs out of
 * the VM. Instead it generates synthetic rows with production-like shape from
 * the prisma schema: same models, believable values, deterministic across runs.
 */
export async function dataCommand(opts: DataOptions): Promise<number> {
  const { cwd, config, orb, logger: log } = opts
  const services = discoverStack(cwd)
  if (services.length === 0) {
    log.error(`No services found in ${cwd}.`)
    return 1
  }

  const rows = opts.rows ?? 10
  let touched = 0

  for (const service of services) {
    const plan = planSeed(service.path)
    if (plan.models.length === 0) {
      for (const w of plan.warnings) log.step(`${service.name}: ${w}`)
      continue
    }

    const sql = generateSeedSql(plan, { rowsPerModel: rows, projectKey: service.name })
    const seedDir = join(cwd, '.mercelle', 'seed')
    const outPath = join(seedDir, `${service.name}.sql`)
    try {
      mkdirSync(seedDir, { recursive: true })
      writeFileSync(outPath, sql)
    } catch (err) {
      log.error(`${service.name}: could not write seed file: ${(err as Error).message}`)
      continue
    }
    touched++
    log.success(`${service.name}: ${plan.models.length} models → ${c.dim(outPath.replace(cwd + '/', ''))}`)

    if (opts.apply) {
      const machine = `mercelle-${slug(cwd.split('/').pop() ?? 'app')}`
      const remote = `/tmp/mercelle-seed-${service.name}.sql`
      // Push the seed into the VM and let prisma apply it when available.
      const res = await orb.run(
        machine,
        [
          `cd ${shellQuote(join('~/mercelle-stack', service.name))}`,
          `if [ -f node_modules/.bin/prisma ]; then`,
          `  node_modules/.bin/prisma db execute --file ${remote} --schema prisma/schema.prisma`,
          `else`,
          `  echo 'no prisma CLI in the VM — apply manually: ' && echo '  ${remote}'`,
          `fi`,
        ].join('\n'),
        { allowFailure: true, stream: true },
      )
      if (res.code !== 0) {
        log.warn(`${service.name}: apply failed inside the VM — the seed file is at ${outPath}`)
      }
    }
  }

  if (touched === 0) {
    log.warn('No service had a prisma schema mercelle could seed.')
    return 1
  }

  log.info('')
  log.info(c.dim('Synthetic data only — mercelle never copies production rows into the VM.'))
  log.info(c.dim('Apply inside the VM:  mercelle data --apply  (uses prisma db execute)'))
  return 0
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app'
}
