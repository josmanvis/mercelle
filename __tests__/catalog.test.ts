import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverCatalog,
  popularityScore,
  readStats,
  recordRun,
  suggestApps,
  mercelleHome,
} from '../src/catalog.js'
import { pickApp } from '../src/pick.js'
import { stripAnsi } from '../src/dashboard.js'
import type { CatalogEntry } from '../src/catalog.js'
import type { Writable } from 'node:stream'

const savedEnv = { ...process.env }
afterEach(() => {
  process.env = { ...savedEnv }
  delete process.env.MERCELLE_HOME
})

/** A fake project with a dev script. */
function makeProject(dir: string, name: string, scripts: Record<string, string> = { dev: 'next dev' }): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, scripts, dependencies: { next: '16' } }))
}

describe('catalog discovery', () => {
  it('finds projects one and two levels deep, skipping junk dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'mercelle-cat-'))
    process.env.MERCELLE_HOME = join(root, '.mercelle-home')
    makeProject(join(root, 'web'))
    makeProject(join(root, 'axxes', 'api'))
    makeProject(join(root, 'node_modules', 'trap'))
    mkdirSync(join(root, 'not-a-project'), { recursive: true })
    writeFileSync(join(root, 'not-a-project', 'readme.md'), 'x')
    mkdirSync(join(root, 'empty-group'))

    const entries = discoverCatalog(root)
    const names = entries.map((e) => e.name)
    expect(names).toContain('web')
    expect(names).toContain('api')
    expect(names).not.toContain('trap')
    expect(names).not.toContain('empty-group')
  })

  it('marks projects without a dev script as not runnable', () => {
    const root = mkdtempSync(join(tmpdir(), 'mercelle-cat-'))
    process.env.MERCELLE_HOME = join(root, 'home')
    makeProject(join(root, 'lib'), 'lib', { build: 'tsc' })
    const entries = discoverCatalog(root)
    expect(entries.map((e) => e.runnable)).toEqual([false])
  })

  it('returns an empty catalog for a missing root instead of throwing', () => {
    process.env.MERCELLE_HOME = mkdtempSync(join(tmpdir(), 'mercelle-cat-'))
    expect(discoverCatalog(join(tmpdir(), 'definitely-missing-xyz'))).toEqual([])
  })

  it('records runs and ranks recent apps higher', () => {
    const root = mkdtempSync(join(tmpdir(), 'mercelle-cat-'))
    process.env.MERCELLE_HOME = join(root, 'home')
    makeProject(join(root, 'web'))
    makeProject(join(root, 'api'))

    recordRun(join(root, 'api'))
    recordRun(join(root, 'api'))
    recordRun(join(root, 'web'))

    const entries = discoverCatalog(root)
    expect(entries[0]?.name).toBe('api')
    expect(entries[0]?.runs).toBe(2)

    // Suggestions: runnable apps with at least one run, ranked.
    const suggestions = suggestApps(entries)
    expect(suggestions.map((s) => s.name)).toEqual(['api', 'web'])
  })

  it('recency beats raw run count', () => {
    const now = Date.now()
    const hot = popularityScore(2, new Date(now - 86_400_000).toISOString(), now) // yesterday, 2 runs
    const cold = popularityScore(5, new Date(now - 60 * 86_400_000).toISOString(), now) // 60 days ago, 5 runs
    expect(hot).toBeGreaterThan(cold)
  })

  it('keeps stats isolated per MERCELLE_HOME', () => {
    const homeA = mkdtempSync(join(tmpdir(), 'mercelle-ha-'))
    const homeB = mkdtempSync(join(tmpdir(), 'mercelle-hb-'))
    process.env.MERCELLE_HOME = homeA
    recordRun('/x')
    expect(readStats().apps['/x']?.runs).toBe(1)
    process.env.MERCELLE_HOME = homeB
    expect(readStats().apps['/x']).toBeUndefined()
    expect(mercelleHome()).toBe(homeB)
  })
})

describe('pickApp', () => {
  const entries: CatalogEntry[] = [
    { name: 'web', path: '/d/web', framework: 'nextjs', packageManager: 'npm', runnable: true, runs: 3, score: 9 },
    { name: 'api', path: '/d/axxes/api', framework: 'hono', packageManager: 'pnpm', runnable: true, runs: 1, score: 5 },
  ]

  it('returns null when the catalog is empty', async () => {
    expect(await pickApp([], { stdin: process.stdin, stdout: process.stdout, interactive: false })).toBeNull()
  })

  it('does not hang and returns null on non-interactive stdin', async () => {
    const chunks: string[] = []
    const sink = { write: (s: string) => void chunks.push(s) } as unknown as Writable
    const picked = await pickApp(entries, { stdin: process.stdin, stdout: sink, interactive: false })
    expect(picked).toBeNull()
    expect(chunks.join('')).toContain('Suggested for local testing')
    expect(chunks.join('')).toContain('web')
  })

  it('never suggests an app that has never been run', async () => {
    // Regression: the picker used to slice the first 3 entries, so a 0-run app
    // was advertised as "Suggested for local testing".
    const mixed: CatalogEntry[] = [
      { name: 'api', path: '/d/api', framework: 'nextjs', packageManager: 'npm', runnable: true, runs: 7, score: 7 },
      { name: 'admin', path: '/d/admin', framework: 'nextjs', packageManager: 'npm', runnable: true, runs: 0, score: 0 },
      { name: 'lib', path: '/d/lib', framework: 'node', packageManager: 'npm', runnable: false, runs: 4, score: 4 },
    ]
    const chunks: string[] = []
    const sink = { write: (s: string) => void chunks.push(s) } as unknown as Writable
    await pickApp(mixed, { stdin: process.stdin, stdout: sink, interactive: false })

    const suggested = stripAnsi(chunks.join('')).split('All apps')[0] ?? ''
    expect(suggested).toContain('api')
    expect(suggested).not.toContain('admin')
    // A non-runnable project cannot be run, so it is never suggested either.
    expect(suggested).not.toContain('lib')
  })

  it('omits the suggested section when nothing has been run yet', async () => {
    const fresh: CatalogEntry[] = [
      { name: 'web', path: '/d/web', framework: 'nextjs', packageManager: 'npm', runnable: true, runs: 0, score: 0 },
    ]
    const chunks: string[] = []
    const sink = { write: (s: string) => void chunks.push(s) } as unknown as Writable
    await pickApp(fresh, { stdin: process.stdin, stdout: sink, interactive: false })
    expect(stripAnsi(chunks.join(''))).not.toContain('Suggested for local testing')
  })

  it('numbers suggestions consistently with the full list', async () => {
    // Regression: both sections used to number from 1 independently, so "1"
    // was ambiguous between the suggested and the full list.
    const mixed: CatalogEntry[] = [
      { name: 'zeta', path: '/d/zeta', framework: 'nextjs', packageManager: 'npm', runnable: true, runs: 0, score: 0 },
      { name: 'api', path: '/d/api', framework: 'nextjs', packageManager: 'npm', runnable: true, runs: 5, score: 5 },
    ]
    const chunks: string[] = []
    const sink = { write: (s: string) => void chunks.push(s) } as unknown as Writable
    await pickApp(mixed, { stdin: process.stdin, stdout: sink, interactive: false })

    const out = stripAnsi(chunks.join(''))
    const [suggestedBlock = '', allBlock = ''] = out.split('All apps')
    // `api` is entry 2 in the full list, so it must be numbered 2 when suggested.
    expect(suggestedBlock).toMatch(/2\.\s*api/)
    expect(allBlock).toMatch(/2\.\s*api/)
  })
})

describe('deep catalog discovery', () => {
  it('finds apps nested more than two levels below the root', () => {
    // Regression: the scan stopped at two levels, so real workspaces like
    // ~/Developer/axxes/platform/web were invisible and unrunnable from the
    // picker even though `cd`-ing into them worked.
    const root = mkdtempSync(join(tmpdir(), 'mercelle-deep-'))
    process.env.MERCELLE_HOME = join(root, 'home')
    makeProject(join(root, 'axxes', 'web'))
    makeProject(join(root, 'axxes', 'platform', 'deep-app'))
    makeProject(join(root, 'axxes', 'apps', 'collections', 'site'))

    const paths = discoverCatalog(root).map((e) => e.path)
    expect(paths.some((p) => p.endsWith(join('axxes', 'web')))).toBe(true)
    expect(paths.some((p) => p.endsWith(join('platform', 'deep-app')))).toBe(true)
    expect(paths.some((p) => p.endsWith(join('collections', 'site')))).toBe(true)
  })

  it('does not descend into a project and pick up its fixtures', () => {
    // A project is a leaf: its own examples/apps must not flood the picker.
    const root = mkdtempSync(join(tmpdir(), 'mercelle-leaf-'))
    process.env.MERCELLE_HOME = join(root, 'home')
    makeProject(join(root, 'monorepo'))
    makeProject(join(root, 'monorepo', 'examples', 'demo'))

    const names = discoverCatalog(root).map((e) => e.name)
    expect(names).toContain('monorepo')
    expect(names).not.toContain('demo')
  })

  it('survives a symlink loop without hanging', () => {
    const root = mkdtempSync(join(tmpdir(), 'mercelle-loop-'))
    process.env.MERCELLE_HOME = join(root, 'home')
    makeProject(join(root, 'app'))
    // A directory that points back at its own ancestor.
    symlinkSync(root, join(root, 'app', 'loop'), 'dir')
    expect(() => discoverCatalog(root)).not.toThrow()
    expect(discoverCatalog(root).map((e) => e.name)).toContain('app')
  })
})
