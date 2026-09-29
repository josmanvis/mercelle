import { DEFAULT_IGNORES } from './vm.js'
import type { Logger } from './types.js'

/** Default debounce so a save-triggered save loop cannot spin. */
const DEBOUNCE_MS = 150

/** Matches a path segment anywhere in the path, e.g. `/a/node_modules/b`. */
function hasIgnoredSegment(path: string, segments: string[]): boolean {
  const parts = path.split(/[/\\]/)
  return segments.some((seg) => parts.includes(seg))
}

export interface WatcherHandle {
  close: () => Promise<void>
  /** True once chokidar has finished its initial scan and events are reliable. */
  isReady: () => boolean
  /** Resolves once the initial scan completes. */
  ready: () => Promise<void>
}

export interface WatchOptions {
  root: string
  /** Called after changes settle. */
  onChange: (files: string[]) => void | Promise<void>
  logger: Logger
  debounceMs?: number
  /** Override the ignored segment list (defaults to the sync excludes). */
  ignore?: string[]
}

/**
 * Watch the project for source changes.
 *
 * mercelle's default sync mode copies files into the VM, so a plain inotify
 * watch on the host is enough to decide when to re-sync and restart. Build
 * output and dependencies are ignored so the loop only reacts to real edits.
 */
export async function watchProject(opts: WatchOptions): Promise<WatcherHandle> {
  const { default: chokidar } = await import('chokidar')
  // Ignore by path *segment* so nested `node_modules` and `.next` are skipped
  // at any depth, not just at the project root.
  const ignores = opts.ignore ?? DEFAULT_IGNORES

  const pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  let running = false
  let queued = false

  const flush = async () => {
    timer = null
    if (running) {
      // A change arrived mid-sync: remember it and run again afterwards.
      queued = true
      return
    }
    running = true
    const files = [...pending]
    pending.clear()
    try {
      await opts.onChange(files)
    } catch (err) {
      opts.logger.error(`watch: ${(err as Error).message}`)
    } finally {
      running = false
      if (queued) {
        queued = false
        void flush()
      }
    }
  }

  const watcher = chokidar.watch(opts.root, {
    ignored: (path: string) => hasIgnoredSegment(path, ignores),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
  })

  const onEvent = (path: string) => {
    pending.add(path)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void flush(), opts.debounceMs ?? DEBOUNCE_MS)
  }

  watcher.on('add', onEvent)
  watcher.on('change', onEvent)
  watcher.on('unlink', onEvent)
  watcher.on('error', (err) => opts.logger.error(`watch error: ${(err as Error).message}`))

  // `ready` is a runtime property on FSWatcher that its types don't declare,
  // so track readiness with a flag driven by the 'ready' event.
  let isReady = false

  // Resolves once the initial scan finishes, so callers know when file events
  // will start arriving reliably.
  const readyPromise = new Promise<void>((resolve) => {
    watcher.once('ready', () => {
      isReady = true
      resolve()
    })
  })

  return {
    close: async () => {
      if (timer) clearTimeout(timer)
      await watcher.close()
    },
    // Exposed so callers (and tests) can wait until events are dependable.
    isReady: () => isReady,
    ready: () => readyPromise,
  }
}
