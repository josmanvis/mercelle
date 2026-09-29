/**
 * mercelle — a Vercel-like dev environment inside an OrbStack Linux VM.
 *
 * Public API surface. The CLI in `cli.ts` is a thin wrapper over these pieces.
 */

export { main } from './cli.js'
export { dev, buildAppEnv, type DevOptions, type DevResult } from './dev.js'
export { doctor, type DoctorOptions } from './doctor.js'
export { configSchema, defaultConfig, mergeFlags, parseConfig, type ConfigInput } from './config.js'
export { resolveConfig, loadProjectConfig } from './loadConfig.js'
export { parseArgs, coerceFlags, VALUE_FLAGS } from './args.js'
export {
  Orb,
  parseMachineList,
  type OrbOptions,
  type RunOptions,
} from './orb.js'
export {
  resolveProject,
  detectFramework,
  detectPackageManager,
  defaultDevCommand,
  readPackageJson,
  toMachineName,
  type PackageJson,
} from './project.js'
export {
  parseDotenv,
  readEnvFile,
  loadEnvFiles,
  vercelSystemEnv,
  shellQuote,
  toEnvPrefix,
  type VercelEnvOptions,
} from './env.js'
export {
  VmManager,
  createTarArchive,
  macPathInVm,
  shellQuote as vmShellQuote,
  DEFAULT_IGNORES,
  NODE_VERSION,
  type VmInfo,
} from './vm.js'
export { consoleLogger, createMemoryLogger, c, term } from './logger.js'
export {
  MercelleError,
  OrbStackMissingError,
  ProjectDetectionError,
  OrbCommandError,
} from './errors.js'
export { watchProject, type WatcherHandle, type WatchOptions } from './watch.js'
export { HELP, VERSION } from './help.js'
export type {
  Distro,
  Framework,
  PackageManager,
  MercelleConfig,
  ResolvedProject,
  OrbResult,
  Logger,
} from './types.js'
