import { consoleLogger } from './logger.js'
import { Lima } from './lima.js'
import { Orb } from './orb.js'
import { MercelleError } from './errors.js'
import type { Backend, Logger, MercelleConfig, VmBackend } from './types.js'

/**
 * Build the VM backend selected in config.
 *
 * OrbStack is the default and is strongly preferred. Lima is a fallback for
 * Intel Macs that cannot run macOS 13+, where OrbStack cannot be installed.
 * With `backend: 'auto'` (or when unset) the first available backend wins.
 */
export async function createBackend(
  config: MercelleConfig,
  logger: Logger = consoleLogger,
): Promise<VmBackend> {
  const requested: Backend = config.backend ?? 'orbstack'

  const make = (name: Backend): VmBackend =>
    name === 'lima'
      ? new Lima({ bin: config.limaBin, logger, dryRun: config.dryRun })
      : new Orb({ bin: config.orbBin, logger, dryRun: config.dryRun })
  if (requested !== 'auto') return make(requested)
  const orb = make('orbstack')
  if (await orb.isInstalled()) return orb

  const lima = make('lima')
  if (await lima.isInstalled()) {
    logger.warn('OrbStack not found; falling back to the Lima backend.')
    return lima
  }

  throw new MercelleError('No supported VM backend was found on this machine.', [
    ...orb.installHint(),
    'Or use Lima:  brew install lima',
  ])
}
