import { createInterface } from 'node:readline'
import { c } from './logger.js'
import { suggestApps } from './catalog.js'
import type { CatalogEntry } from './catalog.js'

export interface PickIo {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  /** True when the caller can actually answer a prompt. */
  interactive: boolean
}

/**
 * The "Run App" experience: pick an app from the catalog, with the most
 * relevant axxes apps surfaced first.
 *
 * Non-interactive (piped/CI) stdin resolves with null, so callers can print a
 * hint instead of hanging forever.
 */
export async function pickApp(entries: CatalogEntry[], io: PickIo): Promise<CatalogEntry | null> {
  if (entries.length === 0) return null

  // Only genuinely-used apps earn a suggestion: suggestApps() filters to
  // runnable projects you have actually started before.
  const suggestedPaths = new Set(suggestApps(entries).map((e) => e.path))
  const suggested = entries.filter((e) => suggestedPaths.has(e.path))
  const out = (s: string): void => {
    io.stdout.write(s)
  }

  out(`\n${c.bold('Run App')}\n`)
  if (suggested.length > 0) {
    out(`${c.dim('Suggested for local testing')}\n`)
    // Numbered exactly as in the full list below, so the number the user types
    // means the same thing in either section.
    suggested.forEach((e) => {
      out(`  ${c.cyan(String(entries.indexOf(e) + 1))}. ${c.bold(e.name)} ${c.dim(`(${e.framework})`)}\n`)
    })
    out('\n')
  }

  out(`${c.dim('All apps')}\n`)
  entries.forEach((e, i) => {
    const badge = e.runnable ? '' : c.dim(' (no dev script)')
    const hint = suggestedPaths.has(e.path) ? c.dim(' ★') : ''
    out(`  ${c.cyan(String(i + 1))}. ${e.name.padEnd(24)} ${c.dim(e.framework.padEnd(8))} ${c.dim(e.path.replace(process.env.HOME ?? '', '~'))}${badge}${hint}\n`)
  })
  out(`\n${c.dim('Enter a number (or an absolute path):')} `)

  if (!io.interactive) return null

  const answer = await new Promise<string>((resolvePromise) => {
    const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: false })
    rl.once('line', (line) => {
      rl.close()
      resolvePromise(line.trim())
    })
  })

  const asNumber = Number.parseInt(answer, 10)
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= entries.length) {
    return entries[asNumber - 1] ?? null
  }
  if (answer.length > 0 && answer.startsWith('/')) {
    const match = entries.find((e) => e.path === answer)
    if (match) return match
  }
  return null
}
