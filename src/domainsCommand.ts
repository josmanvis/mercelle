import { readFileSync } from 'node:fs'
import { discoverStack } from './stack.js'
import { c } from './logger.js'
import {
  DEFAULT_DOMAIN_SUFFIX,
  domainRoutes,
  hostsBlock,
  installHostsEntries,
  readManagedHosts,
} from './domains.js'
import type { Logger, MercelleConfig } from './types.js'

export interface DomainsOptions {
  cwd: string
  config: MercelleConfig
  /** Present in the CLI signature; unused for printing routes. */
  logger: Logger
  /** Remove the mercelle hosts block instead of printing it. */
  remove?: boolean
  /** Write the hosts entries, prompting for sudo when needed. */
  install?: boolean
}

/**
 * `mercelle domains` — show or manage the local axxes domain map.
 *
 * Printing is always safe. `--install` writes /etc/hosts (sudo prompt when
 * needed); `--remove` strips mercelle's block surgically.
 */
export async function domainsCommand(opts: DomainsOptions): Promise<number> {
  const log = opts.logger
  const services = discoverStack(opts.cwd).map((s) => ({ name: s.name, port: s.port }))
  const suffix = opts.config.domainSuffix || DEFAULT_DOMAIN_SUFFIX
  const routes = domainRoutes(services, suffix)

  if (opts.remove) {
    const { removeHostsBlock } = await import('./domains.js')
    let existing = ''
    try {
      existing = readFileSync('/etc/hosts', 'utf8')
    } catch {
      log.error('Could not read /etc/hosts.')
      return 1
    }
    const next = removeHostsBlock(existing)
    if (next === existing) {
      log.info('No mercelle hosts entries found — nothing to remove.')
      return 0
    }
    try {
      const { writeFileSync } = await import('node:fs')
      writeFileSync('/etc/hosts', next, { mode: 0o644 })
      log.success('Removed mercelle hosts entries.')
      return 0
    } catch {
      log.error('Removing the block needs permission to write /etc/hosts.')
      log.info('Run: sudo nano /etc/hosts  (delete the mercelle block by hand)')
      return 1
    }
  }

  if (routes.length === 0) {
    log.error(`No services found in ${opts.cwd} — nothing to map.`)
    log.info('Run this from a workspace with runnable services (see `mercelle stack`).')
    return 1
  }

  if (opts.install) {
    const res = await installHostsEntries(routes)
    if (res.written) {
      log.success(`Installed ${routes.length} hosts entries and flushed the DNS cache.`)
    } else if (res.manualCommand) {
      log.warn('mercelle cannot write /etc/hosts without sudo.')
      log.info('Run this, then re-check with `mercelle domains`:')
      console.log(res.manualCommand)
    }
    return res.written ? 0 : 1
  }

  log.info(`axxes local domains (suffix ${c.bold(suffix)}):`)
  for (const r of routes) {
    log.success(`${r.domain.padEnd(30)} → ${c.cyan(`localhost:${r.port}`)}`)
  }
  log.info('')
  log.info(c.dim('Install them system-wide (needs one sudo prompt):  mercelle domains --install'))
  log.info(c.dim('Remove them later:                                 mercelle domains --remove'))
  log.info('')
  log.info(c.dim('Current /etc/hosts block managed by mercelle:'))
  let managed: string[] = []
  try {
    managed = readManagedHosts(readFileSync('/etc/hosts', 'utf8'))
  } catch {
    /* unreadable hosts file is fine here */
  }
  if (managed.length === 0) {
    log.step('(none installed yet)')
  } else {
    for (const line of managed) log.step(line)
  }
  log.info('')
  log.info(c.dim('Preview of the block that would be installed:'))
  console.log(hostsBlock(routes))
  return 0
}
