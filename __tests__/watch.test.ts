import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { watchProject } from '../src/watch.js'
import { silentLogger } from './helpers.js'

/** Wait for a condition, polling until the timeout. */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

describe('watchProject', () => {
  it('coalesces a burst of writes into a single change callback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-watch-'))
    const batches: string[][] = []

    const watcher = await watchProject({
      root: dir,
      logger: silentLogger,
      debounceMs: 120,
      onChange: (files) => void batches.push(files),
    })

    // chokidar scans asynchronously: wait for `ready` before writing, or the
    // first writes land before the watcher is listening and are never seen.
    await waitFor(() => watcher.isReady())

    // Rapid-fire writes should be debounced into one batch.
    writeFileSync(join(dir, 'a.ts'), '1')
    writeFileSync(join(dir, 'b.ts'), '2')
    writeFileSync(join(dir, 'c.ts'), '3')

    expect(await waitFor(() => batches.length > 0)).toBe(true)
    // Give any stray extra events a chance to land, then confirm no second batch.
    await new Promise((r) => setTimeout(r, 900))
    expect(batches).toHaveLength(1)
    expect(batches[0]?.length).toBe(3)

    await watcher.close()
    rmSync(dir, { recursive: true, force: true })
  }, 20_000)

  it('ignores changes inside node_modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-watch-'))
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })

    let calls = 0
    const watcher = await watchProject({
      root: dir,
      logger: silentLogger,
      debounceMs: 100,
      onChange: () => void calls++,
    })
    await watcher.ready()

    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'changed')

    // Wait long enough for a same-directory file to have produced an event
    // (several debounce + awaitWriteFinish cycles), then assert none fired.
    await new Promise((r) => setTimeout(r, 1500))
    expect(calls).toBe(0)

    await watcher.close()
    rmSync(dir, { recursive: true, force: true })
  }, 20_000)

  it('reports a real source change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-watch-'))
    const seen: string[] = []

    const watcher = await watchProject({
      root: dir,
      logger: silentLogger,
      debounceMs: 80,
      onChange: (files) => void seen.push(...files),
    })
    await watcher.ready()

    writeFileSync(join(dir, 'app.ts'), 'export const x = 1')
    expect(await waitFor(() => seen.some((f) => f.includes('app.ts')))).toBe(true)

    await watcher.close()
    rmSync(dir, { recursive: true, force: true })
  }, 20_000)

  it('surfaces errors thrown by the callback without crashing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-watch-'))
    let attempts = 0

    const watcher = await watchProject({
      root: dir,
      logger: silentLogger,
      debounceMs: 80,
      onChange: () => {
        attempts++
        throw new Error('sync failed')
      },
    })
    await watcher.ready()

    writeFileSync(join(dir, 'boom.ts'), 'x')
    expect(await waitFor(() => attempts > 0)).toBe(true)
    // The watcher must still be alive after the throw.
    writeFileSync(join(dir, 'boom2.ts'), 'y')
    expect(await waitFor(() => attempts > 1)).toBe(true)

    await watcher.close()
    rmSync(dir, { recursive: true, force: true })
  }, 20_000)
})
