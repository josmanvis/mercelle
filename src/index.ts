/**
 * mercelle — a Vercel-like dev environment inside an OrbStack Linux VM.
 *
 * Public API surface. The CLI in `cli.ts` is a thin wrapper over these pieces.
 */

export { main } from './cli.js'
export { createBackend } from './backend.js'
export {
  discoverCatalog,
  popularityScore,
  readStats,
  recordRun,
  suggestApps,
  mercelleHome,
  type CatalogEntry,
  type RunStats,
} from './catalog.js'
export { pickApp, type PickIo } from './pick.js'
export {
  DEFAULT_DOMAIN_SUFFIX,
  domainRoutes,
  hostsBlock,
  installHostsEntries,
  readManagedHosts,
  removeHostsBlock,
  startDomainProxy,
  upsertHostsBlock,
  type DomainRoute,
} from './domains.js'
export {
  generateSeedSql,
  mockRow,
  orderModels,
  parsePrismaModels,
  planSeed,
  rowRng,
  type SeedPlan,
} from './seed.js'
export {
  DASHBOARD_PORT,
  Dashboard,
  stripAnsi,
  teeLog,
  tailAppLog,
  type AppStatus,
  type BootLine,
  type DashboardApp,
  type DashboardIssue,
  type DashboardMeta,
  type DashboardOptions,
  type DashboardState,
  type DatabaseRow,
} from './dashboard.js'
export { uiCommand, type UiOptions } from './uiCommand.js'
export {
  classifyHost,
  discoverNetworkGraph,
  layoutNetwork,
  renderNetworkSvg,
  summariseNetwork,
  type NetworkEdge,
  type NetworkEdgeKind,
  type NetworkGraph,
  type NetworkNode,
  type NetworkNodeKind,
  type NetworkService,
} from './network.js'
export { Lima, type LimaOptions } from './lima.js'
export { dev, buildAppEnv, buildDevCommandLine, devPidFile, type DevOptions, type DevResult } from './dev.js'
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
  detectDatabaseProvider,
  stackCommand,
  type StackOptions,
} from './stackCommand.js'
export { domainsCommand } from './domainsCommand.js'
export { networkCommand, type NetworkCommandOptions } from './networkCommand.js'
export { dataCommand } from './dataCommand.js'
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
  Backend,
  Framework,
  PackageManager,
  MercelleConfig,
  ResolvedProject,
  OrbResult,
  VmBackend,
  Logger,
} from './types.js'
