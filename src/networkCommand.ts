import { c } from './logger.js'
import { discoverStack } from './stack.js'
import { discoverNetworkGraph, renderNetworkSvg, summariseNetwork } from './network.js'
import type { MercelleConfig } from './types.js'
import type { Logger } from './types.js'

export interface NetworkCommandOptions {
  cwd: string
  config: MercelleConfig
  logger: Logger
  /** Print the raw graph as JSON instead of a summary. */
  json?: boolean
  /** Write the SVG to this path instead of stdout. */
  out?: string
}

/**
 * `mercelle network` — show how the services in a workspace are wired together.
 *
 * Reads URLs out of the source and env files to work out which app calls which,
 * and which datastore each one talks to. Nothing is booted and no VM is touched,
 * so it is safe to run anywhere and instant to answer.
 */
export async function networkCommand(opts: NetworkCommandOptions): Promise<number> {
  const { cwd, config, logger: log } = opts
  const services = discoverStack(cwd)
  if (services.length === 0) {
    log.error(`No runnable services found in ${cwd}.`)
    log.info('Each service needs a package.json with a "dev" script.')
    return 1
  }

  const graph = discoverNetworkGraph(
    services.map((s) => ({ name: s.name, path: s.path, port: s.port, framework: s.framework })),
    { domainSuffix: config.domainSuffix ?? 'axxes.local' },
  )

  for (const w of graph.warnings) log.warn(w)

  if (opts.json) {
    console.log(JSON.stringify(graph, null, 2))
    return 0
  }

  const svg = renderNetworkSvg(graph)
  if (opts.out) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(opts.out, svg)
    log.success(`Wrote the network map to ${c.bold(opts.out)}`)
  } else if (process.stdout.isTTY) {
    // A terminal can render the picture directly; a pipe would just get noise.
    console.log(svg)
  }

  log.info('')
  log.info(`  ${c.bold('Network')}  ${c.dim(summariseNetwork(graph))}`)
  for (const edge of graph.edges) {
    const where = edge.evidence ? c.dim(`  (${edge.evidence})`) : ''
    log.info(`  ${edge.from} ${c.dim('→')} ${edge.to}  ${c.dim(edge.label ?? edge.kind)}${where}`)
  }
  if (graph.edges.length === 0) {
    log.info(c.dim('  No connections found between these services.'))
  }
  log.info('')
  log.info(c.dim('  Inferred by reading URLs out of the source — check it against reality.'))

  return 0
}
