import { join } from 'node:path'
import { toEnvPrefix } from './env.js'
import { NODE_PATH_PRELUDE, shellQuote } from './vm.js'

/** Resolve Node and local tools exactly as npm scripts do, with the build environment. */
export function buildCommandLine(remoteRoot: string, env: Record<string, string>, command: string): string {
  return [
    `cd ${shellQuote(remoteRoot)}`,
    NODE_PATH_PRELUDE,
    toEnvPrefix(env),
    `export PATH=${shellQuote(join(remoteRoot, 'node_modules/.bin'))}:$PATH`,
    command,
  ].join(' && ')
}
