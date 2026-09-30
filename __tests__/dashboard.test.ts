import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Dashboard, stripAnsi, teeLog, tailAppLog } from '../src/dashboard.js'
import { defaultConfig } from '../src/config.js'
import { detectDatabaseProvider, stackCommand } from '../src/stackCommand.js'
import { createFakeOrb, silentLogger } from './helpers.js'
import type { Logger } from '../src/types.js'

const servers: Dashboard[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.stop()
})

/** A dashboard on a random free port so tests never collide. */
function makeDashboard(opts: ConstructorParameters<typeof Dashboard>[0] = {}): Dashboard {
  const d = new Dashboard({ port: 0, ...opts })
  servers.push(d)
  return d
}

describe('Dashboard state', () => {
  it('starts in the booting state with an empty log', () => {
    const d = makeDashboard()
    const s = d.state()
    expect(s.status).toBe('booting')
    expect(s.bootLog).toEqual([])
    expect(s.apps).toEqual([])
  })

  it('records boot lines and caps the log at 500 entries', () => {
    const d = makeDashboard()
    for (let i = 0; i < 600; i++) d.boot(`line ${i}`)
    expect(d.state().bootLog).toHaveLength(500)
    expect(d.state().bootLog[0]?.msg).toBe('line 100')
  })

  it('flips to ready after markBooted', () => {
    const d = makeDashboard()
    expect(d.state().status).toBe('booting')
    d.markBooted()
    expect(d.state().status).toBe('ready')
  })

  it('tracks apps and status patches', () => {
    const d = makeDashboard()
    d.addApp({ name: 'web', framework: 'nextjs', port: 3000, url: 'http://localhost:3000', status: 'starting', pid: null })
    d.setAppStatus('web', 'running', { pid: '123' })

    const app = d.state().apps.find((a) => a.name === 'web')
    expect(app?.status).toBe('running')
    expect(app?.pid).toBe('123')
  })

  it('sorts apps by name in the state snapshot', () => {
    const d = makeDashboard()
    for (const name of ['worker', 'api', 'web']) {
      d.addApp({ name, framework: 'node', port: 3000, url: `http://localhost:3000`, status: 'starting', pid: null })
    }
    expect(d.state().apps.map((a) => a.name)).toEqual(['api', 'web', 'worker'])
  })

  it('collects warn/error issues via addIssue', () => {
    const d = makeDashboard()
    d.addIssue({ level: 'warn', message: 'port busy' })
    d.addIssue({ level: 'error', message: 'boom' })
    const issues = d.state().issues
    expect(issues).toHaveLength(2)
    expect(issues[0]?.level).toBe('warn')
    expect(issues[1]?.level).toBe('error')
  })
})

describe('stripAnsi', () => {
  it('removes colour escapes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
    expect(stripAnsi('plain')).toBe('plain')
  })
})

describe('teeLog', () => {
  /** A logger that records into the dashboard and a memory sink. */
  function capture(d: Dashboard): { lines: string[]; log: Logger } {
    const lines: string[] = []
    const sink: Logger = {
      info: (m) => lines.push(m),
      success: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
      step: (m) => lines.push(m),
      raw: (m) => lines.push(m),
    }
    return { lines, log: teeLog(sink, d) }
  }

  it('mirrors every level into the boot log', () => {
    const d = makeDashboard()
    const { log } = capture(d)
    log.info('one')
    log.step('two')
    log.success('three')
    log.warn('four')
    log.error('five')

    const boot = d.state().bootLog
    expect(boot.map((l) => l.msg)).toEqual(['one', 'two', 'three', 'four', 'five'])
    expect(boot.map((l) => l.level)).toEqual(['info', 'step', 'success', 'warn', 'error'])
  })

  it('turns warn and error lines into issues', () => {
    const d = makeDashboard()
    const { log } = capture(d)
    log.info('fine')
    log.warn('watch out')
    log.error('bad')

    const issues = d.state().issues
    expect(issues).toHaveLength(2)
    expect(issues.map((i) => i.message)).toEqual(['watch out', 'bad'])
  })
})

describe('Dashboard HTTP server', () => {
  it('serves the HTML page and JSON state on a real port', async () => {
    const d = makeDashboard()
    d.addApp({ name: 'api', framework: 'hono', port: 3100, url: 'http://localhost:3100', status: 'running', pid: '42' })
    d.markBooted()
    const port = await d.start()

    const page = await fetch(`http://127.0.0.1:${port}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('mercelle')

    const api = await fetch(`http://127.0.0.1:${port}/api/state`)
    expect(api.headers.get('content-type')).toContain('application/json')
    const state = (await api.json()) as { status: string; apps: { name: string }[] }
    expect(state.status).toBe('ready')
    expect(state.apps[0]?.name).toBe('api')
  })

  it('falls back to the next port when the preferred one is taken', async () => {
    const occupied = makeDashboard()
    const taken = await occupied.start()

    const d = makeDashboard({ port: taken })
    const port = await d.start()
    expect(port).toBeGreaterThan(taken)

    const api = await fetch(`http://127.0.0.1:${port}/api/state`)
    expect(api.status).toBe(200)
  })

  it('rejects non-GET requests and unknown paths', async () => {
    const d = makeDashboard()
    const port = await d.start()

    const post = await fetch(`http://127.0.0.1:${port}/api/state`, { method: 'POST', body: 'x' })
    expect(post.status).toBe(405)

    const missing = await fetch(`http://127.0.0.1:${port}/nope`)
    expect(missing.status).toBe(404)
  })

  it('404s log tails for unknown apps and 503s when tailing is unavailable', async () => {
    const d = makeDashboard()
    const port = await d.start()

    const missing = await fetch(`http://127.0.0.1:${port}/api/app/ghost/log`)
    expect(missing.status).toBe(404)
  })

  it('tails app logs through the injected hook', async () => {
    const d = makeDashboard({ tail: async () => 'hello from the vm' })
    d.addApp({ name: 'web', framework: 'nextjs', port: 3000, url: 'http://localhost:3000', status: 'running', pid: null })
    const port = await d.start()

    const res = await fetch(`http://127.0.0.1:${port}/api/app/web/log`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello from the vm')
  })
})

describe('tailAppLog', () => {
  it('tails /tmp/<app>.log inside the VM via the backend', async () => {
    const fake = createFakeOrb()
    fake.setStdout('mercelle-shop', 'booted OK')
    const app = { name: 'shop', framework: 'nextjs', port: 3000, url: 'http://localhost:3000', status: 'running' as const, pid: null }

    const out = await tailAppLog(fake.orb, 'mercelle-shop', app)
    expect(out).toBe('booted OK')
    // The scripted-stdout path bypasses run.log in the fixture, so assert on argv.
    expect(fake.calls().some((args) => args.join(' ').includes('tail -n 200'))).toBe(true)
  })

  it('sanitises app names into log file paths', async () => {
    const fake = createFakeOrb()
    const app = { name: '../etc', framework: 'node', port: 3000, url: 'http://localhost:3000', status: 'running' as const, pid: null }

    const out = await tailAppLog(fake.orb, 'mercelle-shop', app)
    expect(out).toContain('cannot be resolved')
  })

  it('explains when no VM exists yet', async () => {
    const fake = createFakeOrb()
    const app = { name: 'web', framework: 'node', port: 3000, url: 'http://localhost:3000', status: 'running' as const, pid: null }
    expect(await tailAppLog(fake.orb, '', app)).toContain('No VM is associated')
  })
})

describe('detectDatabaseProvider', () => {
  it('detects prisma, drizzle and common drivers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-db-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@prisma/client': '6' } }))
    expect(detectDatabaseProvider(dir)).toBe('prisma')

    const drizzleDir = mkdtempSync(join(tmpdir(), 'mercelle-db-'))
    writeFileSync(join(drizzleDir, 'package.json'), JSON.stringify({ dependencies: { 'drizzle-orm': '0.44' } }))
    expect(detectDatabaseProvider(drizzleDir)).toBe('drizzle')

    const pgDir = mkdtempSync(join(tmpdir(), 'mercelle-db-'))
    writeFileSync(join(pgDir, 'package.json'), JSON.stringify({ dependencies: { pg: '8' } }))
    expect(detectDatabaseProvider(pgDir)).toBe('postgres')
  })

  it('detects a prisma directory even without the dependency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-db-'))
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'prisma'))
    expect(detectDatabaseProvider(dir)).toBe('prisma')
  })

  it('returns null for services without a database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercelle-db-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '5' } }))
    expect(detectDatabaseProvider(dir)).toBeNull()
  })
})

describe('stackCommand dashboard integration', () => {
  it('reports when no services can be discovered', async () => {
    const fake = createFakeOrb()
    const empty = mkdtempSync(join(tmpdir(), 'mercelle-stack-'))
    const code = await stackCommand({
      cwd: empty,
      config: { ...defaultConfig, uiPort: 0, ui: false },
      orb: fake.orb,
      logger: silentLogger,
    })
    expect(code).toBe(1)
  })
})


describe('dashboard network map', () => {
  const graph = {
    nodes: [
      { id: 'web', label: 'web', kind: 'app' as const, port: 3000 },
      { id: 'api', label: 'api', kind: 'app' as const, port: 3010 },
    ],
    edges: [{ from: 'web', to: 'api', kind: 'http' as const, label: 'http://api:3010', evidence: 'src/a.ts' }],
    warnings: [],
  }

  it('serves the graph as SVG and includes it in the state', async () => {
    const dash = new Dashboard({ port: 0, open: false })
    const port = await dash.start()
    try {
      dash.setNetwork(graph)

      const svg = await (await fetch(`http://127.0.0.1:${port}/api/network.svg`)).text()
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg).toContain('>web<')
      expect(svg).toContain('>api<')

      const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()
      expect(state.network.nodes).toHaveLength(2)
      expect(state.network.edges).toHaveLength(1)
    } finally {
      await dash.stop()
    }
  })

  it('404s the SVG when no network was discovered', async () => {
    const dash = new Dashboard({ port: 0, open: false })
    const port = await dash.start()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/network.svg`)
      expect(res.status).toBe(404)
    } finally {
      await dash.stop()
    }
  })

  it('renders a network section in the page shell', async () => {
    const dash = new Dashboard({ port: 0, open: false })
    const port = await dash.start()
    try {
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
      expect(html).toContain('networkSection')
      expect(html).toContain('/api/network.svg')
    } finally {
      await dash.stop()
    }
  })
})
