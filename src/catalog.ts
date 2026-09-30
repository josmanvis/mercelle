import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { detectFramework, detectPackageManager, readPackageJson } from './project.js'
import type { Framework, PackageManager } from './types.js'

/** One runnable project found on disk. */
export interface CatalogEntry {
  /** Project directory name. */
  name: string
  /** Absolute path on the Mac. */
  path: string
  framework: Framework
  packageManager: PackageManager
  /** True when the project has a dev script (i.e. mercelle can run it). */
  runnable: boolean
  /** How many times `mercelle run` has started this project. */
  runs: number
  /** ISO timestamp of the most recent run, if any. */
  lastRun?: string
  /** Popularity score (higher = more recently and more frequently used). */
  score: number
}

/** Statistics recorded by mercelle every time an app is started. */
export interface RunStats {
  apps: Record<string, { runs: number; last: string }>
}

/** Where per-user mercelle state lives. */
export function mercelleHome(): string {
  return process.env.MERCELLE_HOME ?? join(homedir(), '.mercelle')
}

function statsPath(): string {
  return join(mercelleHome(), 'stats.json')
}

/** Read the run stats, tolerating a missing or corrupted file. */
export function readStats(): RunStats {
  try {
    return JSON.parse(readFileSync(statsPath(), 'utf8')) as RunStats
  } catch {
    return { apps: {} }
  }
}

/** Persist the run stats (best effort: losing them must never fail a run). */
export function writeStats(stats: RunStats): void {
  try {
    mkdirSync(mercelleHome(), { recursive: true })
    writeFileSync(statsPath(), JSON.stringify(stats, null, 2))
  } catch {
    /* stats are advisory */
  }
}

/** Record one run of an app, keyed by absolute project path. */
export function recordRun(path: string, now = new Date().toISOString()): void {
  const stats = readStats()
  const entry = stats.apps[path] ?? { runs: 0, last: '' }
  entry.runs += 1
  entry.last = now
  stats.apps[path] = entry
  writeStats(stats)
}

/**
 * Score an app by how useful it has been lately.
 *
 * Frequency counts, recency gives a boost: something run this week outranks
 * something run two months ago even with the same number of runs.
 */
export function popularityScore(runs: number, last?: string, now = Date.now()): number {
  let score = runs
  if (last) {
    const ageDays = (now - Date.parse(last)) / 86_400_000
    if (Number.isFinite(ageDays)) score += Math.max(0, 10 - Math.floor(ageDays))
  }
  return score
}

/**
 * Directories that are never app projects: tooling, configs, backups.
 * Shared with the stack scanner's spirit, but scoped to the Developer root.
 */
/** How deep the catalog walks below the Developer root. */
const MAX_SCAN_DEPTH = 4

/** Upper bounds so a huge or symlinked tree cannot stall the picker. */
const MAX_SCAN_DIRS = 4000
const MAX_SCAN_PROJECTS = 200

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache',
  'coverage', 'venv', '.venv', '__pycache__', '.turbo', '.svelte-kit',
])

/**
 * Discover every runnable Node project under `root` (default ~/Developer).
 *
 * Walks the whole tree rather than a fixed two levels, because real workspaces
 * nest: `~/Developer/axxes/platform/web` is an app just as much as
 * `~/Developer/axxes/web` is, and it must still be runnable from the picker.
 * The walk is bounded by depth, a directory budget and a file budget so a huge
 * or symlinked tree cannot turn "open the picker" into a long stall.
 *
 * Never throws: a missing or unreadable root yields an empty catalog, because
 * the picker must still open.
 */
export function discoverCatalog(rootInput?: string): CatalogEntry[] {
  const root = resolve(rootInput ?? join(homedir(), 'Developer'))
  const stats = readStats()
  const entries: CatalogEntry[] = []
  const seen = new Set<string>()

  const pushCandidate = (dir: string): void => {
    const pkg = readPackageJson(dir)
    if (!pkg) return
    const stat = stats.apps[dir]
    const runs = stat?.runs ?? 0
    const last = stat?.last
    entries.push({
      name: pkg.name ?? dir.split(sep).pop() ?? dir,
      path: dir,
      framework: detectFramework(dir, pkg),
      packageManager: detectPackageManager(dir, pkg),
      runnable: Boolean(pkg.scripts?.dev),
      runs,
      lastRun: last,
      score: popularityScore(runs, last),
    })
  }

  const budget = { dirs: MAX_SCAN_DIRS, projects: MAX_SCAN_PROJECTS }

  const walk = (dir: string, depth: number): void => {
    if (budget.dirs <= 0 || budget.projects <= 0) return
    budget.dirs--

    // A symlink loop, or the same directory reached twice, must not recurse.
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      return
    }
    if (seen.has(real)) return
    seen.add(real)

    let children: Dirent[]
    try {
      children = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of children) {
      if (budget.projects <= 0) return
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue

      const full = join(dir, name)
      if (existsSync(join(full, 'package.json'))) {
        pushCandidate(full)
        budget.projects--
        // A project is a leaf: do not descend into its own dependencies or
        // nested fixtures, or one repo would swallow the picker.
        continue
      }
      if (depth < MAX_SCAN_DEPTH) walk(full, depth + 1)
    }
  }

  if (!existsSync(root)) return []
  walk(root, 0)

  // Most useful first; ties broken by name for a stable list.
  return entries.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

/**
 * The apps mercelle recommends for local QA right now:
 * recently-run runnable projects, capped so the picker stays scannable.
 */
export function suggestApps(entries: CatalogEntry[], limit = 3): CatalogEntry[] {
  return entries.filter((e) => e.runnable && e.runs > 0).slice(0, limit)
}
