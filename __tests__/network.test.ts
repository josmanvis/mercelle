import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyHost,
  discoverNetworkGraph,
  layoutNetwork,
  renderNetworkSvg,
  summariseNetwork,
  type NetworkService,
} from '../src/network.js'

/** Build a workspace of services, each given a map of relative file → content. */
function workspace(files: Record<string, Record<string, string>>): { root: string; services: NetworkService[] } {
  const root = mkdtempSync(join(tmpdir(), 'mercelle-net-'))
  const services: NetworkService[] = []
  let port = 3000
  for (const [name, tree] of Object.entries(files)) {
    const dir = join(root, name)
    for (const [rel, content] of Object.entries(tree)) {
      const full = join(dir, rel)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }
    services.push({ name, path: dir, port, framework: 'node' })
    port += 10
  }
  return { root, services }
}

describe('classifyHost', () => {
  const services: NetworkService[] = [
    { name: 'web', path: '/x/web', port: 3000, framework: 'nextjs' },
    { name: 'api', path: '/x/api', port: 3010, framework: 'hono' },
  ]

  it('recognises a sibling service by bare name', () => {
    expect(classifyHost('api', 3010, services, 'axxes.local')).toEqual({ id: 'api', kind: 'app', port: 3010 })
  })

  it('recognises a sibling by its local domain', () => {
    expect(classifyHost('web.axxes.local', undefined, services, 'axxes.local')).toEqual({
      id: 'web',
      kind: 'app',
      port: 3000,
    })
  })

  it('treats loopback plus a known service port as that service', () => {
    // This is how a locally-routed app is actually reached in most codebases.
    expect(classifyHost('localhost', 3010, services, 'axxes.local').id).toBe('api')
    expect(classifyHost('127.0.0.1', 3000, services, 'axxes.local').id).toBe('web')
  })

  it('treats an unknown host as external', () => {
    // `port` is only meaningful for an app node, so it is not echoed back here.
    expect(classifyHost('stripe.com', 443, services, 'axxes.local')).toEqual({
      id: 'stripe.com',
      kind: 'external',
    })
  })

  it('does not guess a service from loopback on an unrelated port', () => {
    expect(classifyHost('localhost', 9999, services, 'axxes.local').kind).toBe('external')
  })
})

describe('discoverNetworkGraph', () => {
  it('finds app-to-app calls and records the file as evidence', () => {
    const { services } = workspace({
      web: { 'src/api.ts': 'export const API = "http://api:3010/health"' },
      api: { 'src/server.ts': 'export const ok = true' },
    })
    const graph = discoverNetworkGraph(services)

    const edge = graph.edges.find((e) => e.from === 'web' && e.to === 'api')
    expect(edge).toBeDefined()
    expect(edge?.kind).toBe('http')
    expect(edge?.label).toBe('http://api:3010')
    expect(edge?.evidence).toBe(join('src', 'api.ts'))
  })

  it('picks up calls made through a local domain', () => {
    const { services } = workspace({
      web: { 'a.ts': 'fetch("http://api.axxes.local/v1")' },
      api: { 'b.ts': '' },
    })
    expect(discoverNetworkGraph(services).edges.some((e) => e.from === 'web' && e.to === 'api')).toBe(true)
  })

  it('turns a database URL into a database node and a dashed edge', () => {
    const { services } = workspace({
      api: { '.env': 'DATABASE_URL=postgres://postgres:pw@db.internal:5432/app' },
    })
    const graph = discoverNetworkGraph(services)

    expect(graph.nodes.find((n) => n.kind === 'database')?.id).toBe('postgres://db.internal')
    const edge = graph.edges.find((e) => e.kind === 'database')
    expect(edge?.from).toBe('api')
    expect(edge?.to).toBe('postgres://db.internal')
  })

  it('keeps an isolated service as a node with no edges', () => {
    // The user needs to see that an app stands alone, not have it vanish.
    const { services } = workspace({ lonely: { 'index.js': 'console.log(1)' } })
    const graph = discoverNetworkGraph(services)
    expect(graph.nodes.map((n) => n.id)).toEqual(['lonely'])
    expect(graph.edges).toEqual([])
  })

  it('ignores an app referencing its own name and domain', () => {
    const { services } = workspace({
      web: { 'a.ts': 'const self = "http://web.axxes.local"; const me = "http://web:3000"' },
    })
    expect(discoverNetworkGraph(services).edges).toEqual([])
  })

  it('does not create a node for a well-known third party', () => {
    const { services } = workspace({ web: { 'a.ts': 'fetch("https://api.github.com/repos/x")' } })
    expect(discoverNetworkGraph(services).nodes.filter((n) => n.kind === 'external')).toEqual([])
  })

  it('records an unknown host as an external node', () => {
    const { services } = workspace({ web: { 'a.ts': 'fetch("http://images.internal/1.png")' } })
    expect(discoverNetworkGraph(services).nodes.some((n) => n.id === 'images.internal')).toBe(true)
  })

  it('skips vendored and generated directories', () => {
    const { services } = workspace({
      web: {
        'src/app.ts': 'fetch("http://api:3010")',
        'node_modules/some-pkg/index.js': 'fetch("http://should-not-appear:1")',
        'dist/bundle.js': 'fetch("http://also-not:2")',
      },
      api: { 'b.ts': '' },
    })
    expect(discoverNetworkGraph(services).nodes.map((n) => n.id).sort()).toEqual(['api', 'web'])
  })

  it('is deterministic across repeated runs', () => {
    const { services } = workspace({
      web: { 'a.ts': 'fetch("http://api:3010"); fetch("http://cdn.example/x")' },
      api: { 'b.ts': 'const u = "postgres://db:5432/x"' },
    })
    expect(JSON.stringify(discoverNetworkGraph(services))).toBe(
      JSON.stringify(discoverNetworkGraph(services)),
    )
  })


describe('layoutNetwork', () => {
  it('places a dependency to the right of the app that calls it', () => {
    const { services } = workspace({
      web: { 'a.ts': 'fetch("http://api:3010")' },
      api: { 'b.ts': '' },
    })
    const { positions } = layoutNetwork(discoverNetworkGraph(services))
    expect(positions.get('api')!.x).toBeGreaterThan(positions.get('web')!.x)
  })

  it('does not loop forever on a circular dependency', () => {
    const { services } = workspace({
      a: { 'x.ts': 'fetch("http://b:3010")' },
      b: { 'y.ts': 'fetch("http://a:3000")' },
    })
    const graph = discoverNetworkGraph(services)
    expect(() => layoutNetwork(graph)).not.toThrow()
    expect(graph.edges.length).toBe(2)
  })

  it('gives every node a position', () => {
    const { services } = workspace({
      web: { 'a.ts': 'fetch("http://api:3010"); const d="postgres://db/x"' },
      api: { 'b.ts': '' },
    })
    const graph = discoverNetworkGraph(services)
    const { positions } = layoutNetwork(graph)
    for (const node of graph.nodes) expect(positions.has(node.id)).toBe(true)
  })
})

describe('renderNetworkSvg', () => {
  it('renders nodes and labelled edges as plain SVG', () => {
    const { services } = workspace({
      web: { 'a.ts': 'fetch("http://api:3010")' },
      api: { 'b.ts': '' },
    })
    const svg = renderNetworkSvg(discoverNetworkGraph(services))

    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('>web<')
    expect(svg).toContain('>api<')
    // Edges carry a tooltip explaining why they exist.
    expect(svg).toContain('<title>web → api')
    // No external scripts or assets: the dashboard is a single offline page.
    expect(svg).not.toMatch(/<script/i)
  })

  it('escapes XML so a hostile label cannot break the page', () => {
    const graph = {
      nodes: [
        { id: 'a', label: '<script>alert(1)</script>', kind: 'app' as const, port: 3000 },
        { id: 'b', label: 'b', kind: 'app' as const, port: 3010 },
      ],
      edges: [{ from: 'a', to: 'b', kind: 'http' as const, label: 'x<&>' }],
      warnings: [],
    }
    const svg = renderNetworkSvg(graph)
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('&lt;&amp;&gt;')
  })

  it('returns an empty string when there is nothing to draw', () => {
    expect(renderNetworkSvg({ nodes: [], edges: [], warnings: [] })).toBe('')
  })
})

describe('summariseNetwork', () => {
  it('counts apps, connections and datastores', () => {
    const { services } = workspace({
      web: { 'a.ts': 'fetch("http://api:3010"); const d = "postgres://db/x"' },
      api: { 'b.ts': '' },
    })
    expect(summariseNetwork(discoverNetworkGraph(services))).toBe('2 apps · 2 connections · 1 database')
  })

  it('omits absent categories rather than saying zero', () => {
    const { services } = workspace({ solo: { 'a.ts': 'console.log(1)' } })
    expect(summariseNetwork(discoverNetworkGraph(services))).toBe('1 app · 0 connections')
  })
})

  it('warns instead of throwing when a service directory is missing', () => {
    const graph = discoverNetworkGraph([
      { name: 'ghost', path: '/definitely/not/here', port: 3000, framework: 'node' },
    ])
    expect(graph.warnings[0]).toMatch(/ghost/)
    expect(graph.nodes.map((n) => n.id)).toEqual(['ghost'])
  })

  it('deduplicates repeated references to the same target', () => {
    const { services } = workspace({
      web: { 'a.ts': 'fetch("http://api:3010/a"); fetch("http://api:3010/b")' },
      api: { 'b.ts': '' },
    })
    expect(discoverNetworkGraph(services).edges).toHaveLength(1)
  })
})
