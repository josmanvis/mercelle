import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectDetectionError } from '../src/errors.js'
import {
  defaultDevCommand,
  detectFramework,
  detectPackageManager,
  readPackageJson,
  resolveProject,
  toMachineName,
} from '../src/project.js'

/** Build a throwaway project directory. */
function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mercelle-proj-'))
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  return dir
}

describe('readPackageJson', () => {
  it('returns null when package.json is missing', () => {
    expect(readPackageJson(join(tmpdir(), 'definitely-not-here-xyz'))).toBeNull()
  })

  it('returns null for malformed JSON rather than throwing', () => {
    const dir = makeProject({ 'package.json': '{ not json' })
    expect(readPackageJson(dir)).toBeNull()
  })
})

describe('detectPackageManager', () => {
  it('prefers pnpm-lock.yaml', () => {
    const dir = makeProject({ 'package.json': '{}', 'pnpm-lock.yaml': '' })
    expect(detectPackageManager(dir)).toBe('pnpm')
  })

  it('detects bun, yarn and npm', () => {
    expect(detectPackageManager(makeProject({ 'package.json': '{}', 'bun.lockb': '' }))).toBe('bun')
    expect(detectPackageManager(makeProject({ 'package.json': '{}', 'yarn.lock': '' }))).toBe('yarn')
    expect(detectPackageManager(makeProject({ 'package.json': '{}', 'package-lock.json': '{}' }))).toBe('npm')
  })

  it('falls back to the packageManager field', () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }) })
    expect(detectPackageManager(dir, readPackageJson(dir))).toBe('pnpm')
  })

  it('defaults to npm with no signal', () => {
    const dir = makeProject({ 'package.json': '{}' })
    expect(detectPackageManager(dir)).toBe('npm')
  })
})

describe('detectFramework', () => {
  it('detects nextjs from dependencies', () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ dependencies: { next: '16.0.0', react: '19' } }) })
    expect(detectFramework(dir, readPackageJson(dir)!)).toBe('nextjs')
  })

  it('detects from devDependencies too', () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ devDependencies: { astro: '^5' } }) })
    expect(detectFramework(dir, readPackageJson(dir)!)).toBe('astro')
  })

  it('detects nuxt via config file', () => {
    const dir = makeProject({ 'package.json': '{}', 'nuxt.config.ts': 'export default {}' })
    expect(detectFramework(dir, readPackageJson(dir)!)).toBe('nuxt')
  })

  it('prefers nextjs over vite when both are present', () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ dependencies: { next: '16' }, devDependencies: { vite: '7' } }),
    })
    expect(detectFramework(dir, readPackageJson(dir)!)).toBe('nextjs')
  })

  it('falls back to node', () => {
    const dir = makeProject({ 'package.json': '{}' })
    expect(detectFramework(dir, readPackageJson(dir)!)).toBe('node')
  })
})

describe('defaultDevCommand', () => {
  it('uses each framework’s native command', () => {
    expect(defaultDevCommand('nextjs', 'npm')).toBe('next dev')
    expect(defaultDevCommand('astro', 'npm')).toBe('astro dev')
    expect(defaultDevCommand('nuxt', 'npm')).toBe('nuxt dev')
  })

  it('prefixes the package runner for generic projects', () => {
    expect(defaultDevCommand('node', 'npm')).toBe('npm run dev')
    expect(defaultDevCommand('node', 'pnpm')).toBe('pnpm run dev')
  })
})

describe('toMachineName', () => {
  it('slugifies the project name', () => {
    expect(toMachineName('My App')).toBe('mercelle-my-app')
    expect(toMachineName('@scope/pkg')).toBe('mercelle-scope-pkg')
  })

  it('handles empty and symbol-only names', () => {
    expect(toMachineName('')).toBe('mercelle-app')
    expect(toMachineName('!!!')).toBe('mercelle-app')
  })

  it('caps the length so machine names stay manageable', () => {
    expect(toMachineName('a'.repeat(100))).toHaveLength('mercelle-'.length + 24)
  })
})

describe('resolveProject', () => {
  it('prefers the project dev script when present', () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ name: 'web', scripts: { dev: 'next dev --turbopack' }, dependencies: { next: '16' } }),
    })
    const project = resolveProject(dir)
    expect(project.devCommand).toBe('next dev --turbopack')
    expect(project.machine).toBe('mercelle-web')
    expect(project.framework).toBe('nextjs')
  })

  it('falls back to the framework default without a dev script', () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ name: 'web', dependencies: { next: '16' } }) })
    expect(resolveProject(dir).devCommand).toBe('next dev')
  })

  it('names the machine after the directory when package.json has no name', () => {
    const dir = makeProject({ 'package.json': '{}' })
    const resolved = resolveProject(dir)
    expect(resolved.machine).toBe(`mercelle-${dir.split('/').pop()!.toLowerCase()}`)
  })

  it('honours overrides', () => {
    const dir = makeProject({ 'package.json': '{}' })
    const project = resolveProject(dir, { machine: 'custom-vm', devCommand: 'node server.js' })
    expect(project.machine).toBe('custom-vm')
    expect(project.devCommand).toBe('node server.js')
  })

  it('throws when there is no package.json', () => {
    const dir = makeProject({ 'readme.md': 'hi' })
    expect(() => resolveProject(dir)).toThrow(ProjectDetectionError)
  })

  it('throws when the directory does not exist', () => {
    expect(() => resolveProject(join(tmpdir(), 'nope-xyz-123'))).toThrow(/not found/)
  })
})
