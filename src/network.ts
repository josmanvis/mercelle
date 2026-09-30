import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Service-to-service networking, inferred from the workspace.
 *
 * Mercelle already knows which services exist and which port each one gets, but
 * not how they talk to *each other*. That wiring lives in the source: an env var
 * pointing at `http://api:4000`, a fetch to another app's domain, a
 * `DATABASE_URL` for the datastore behind a service. This module reads those
 * signals and turns them into a graph, so the dashboard can draw the shape of
 * the system instead of a flat list of services.
 *
 * Everything here is static analysis of files on disk. It never runs app code,
 * never opens a socket, and never leaves the workspace, so it is safe to run
 * against any checkout in any environment.
 */

/** What a node represents in the network. */
export type NetworkNodeKind = 'app' | 'database' | 'external'

/** How two nodes are connected. */
export type NetworkEdgeKind = 'http' | 'database' | 'config'

/** One participant in the network. */
export interface NetworkNode {
  /** Stable identifier, unique within the graph. */
  id: string
  label: string
  kind: NetworkNodeKind
  /** Framework, for app nodes. */
  framework?: string
  /** Port inside the VM, for app nodes. */
  port?: number
  /** Local domain, for app nodes. */
  domain?: string
  /** How this node was identified, shown in the UI so nothing looks magic. */
  detail?: string
}

/** One connection between two nodes. */
export interface NetworkEdge {
  from: string
  to: string
  kind: NetworkEdgeKind
  /** What the connection is, e.g. the URL that created it. */
  label?: string
  /** Where in the code this was seen, so a surprising edge can be explained. */
  evidence?: string
}

/** The whole picture. */
export interface NetworkGraph {
  nodes: NetworkNode[]
  edges: NetworkEdge[]
  /** Non-fatal problems encountered while scanning. */
  warnings: string[]
}

/** A service to analyse, as returned by `discoverStack`. */
export interface NetworkService {
  name: string
  path: string
  port: number
  framework: string
  /** Database provider detected for this service, when known. */
  database?: string | null
}

/** Directories never scanned: huge, generated, or vendored. */
const SCAN_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.cache', 'coverage', '.vercel', '.mercelle', 'vendor', '__pycache__',
  '.venv', 'venv', 'target',
])

/** File extensions worth reading for URLs. */
const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.env', '.yml', '.yaml',
  '.toml', '.graphql', '.prisma', '.md', '.sh', '.txt', '',
])

/** Never read more than this from one file, so a minified bundle cannot stall us. */
const MAX_FILE_BYTES = 512 * 1024

/** Never read more than this many files per service. */
const MAX_FILES_PER_SERVICE = 400

/** `http://host:port` / `https://host` anywhere in the text. */
const HTTP_URL = /\bhttps?:\/\/([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?::(\d{2,5}))?/gi

/**
 * `postgres://`, `redis://`, `mongodb://` and friends.
 *
 * The host is whatever comes after the optional `user:password@`, so the
 * credential pair in a real DSN is skipped rather than mistaken for the host.
 */
const DB_URL = /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/(?:[^@/?#\s]*@)?([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?::(\d{2,5}))?/gi

/** Hosts that mean "this machine" rather than a peer service. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])

/** Well-known hostnames that are never one of our services. */
const KNOWN_EXTERNAL = new Set([
  'api.github.com', 'github.com', 'registry.npmjs.org', 'stripe.com',
  'api.stripe.com', 'sendgrid.net', 'twilio.com', 'api.openai.com', 'vercel.com',
])

/** List the files worth scanning under a service directory. */
function listFiles(root: string, budget: { left: number }): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (budget.left <= 0) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (budget.left <= 0) return
      const name = entry.name
      if (name.startsWith('.') && name !== '.env') continue
      const full = join(dir, name)
      if (entry.isDirectory()) {
        if (SCAN_IGNORE_DIRS.has(name)) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const dot = name.lastIndexOf('.')
      const ext = dot === -1 ? '' : name.slice(dot).toLowerCase()
      if (!SCAN_EXTENSIONS.has(ext)) continue
      out.push(full)
      budget.left--
    }
  }
  walk(root)
  return out
}

/** Read a file, tolerating a binary blob or a file that vanished mid-scan. */
function readText(path: string): string | null {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Short, stable, human-readable path for the evidence column. */
function evidencePath(root: string, file: string): string {
  return relative(root, file) || file
}

/**
 * Work out what a URL host refers to.
 *
 * A host can name a sibling service directly (`http://api:4000`), name its
 * local domain (`http://web.axxes.local`), or be the loopback address paired
 * with that service's port. All three mean "another app in this stack".
 */
export function classifyHost(
  host: string,
  port: number | undefined,
  services: NetworkService[],
  domainSuffix: string,
): { id: string; kind: 'app' | 'external'; port?: number } {
  const h = host.toLowerCase().replace(/\.$/, '')

  for (const svc of services) {
    const name = svc.name.toLowerCase()
    if (h === name || h === `${name}.${domainSuffix.toLowerCase()}`) {
      return { id: svc.name, kind: 'app', port: port ?? svc.port }
    }
  }

  // Loopback plus a port that belongs to a service is still that service: this
  // is how a locally-routed app is reached in most codebases.
  if (LOCAL_HOSTS.has(h) && port !== undefined) {
    const match = services.find((s) => s.port === port)
    if (match) return { id: match.name, kind: 'app', port }
  }

  return { id: h, kind: 'external' }
}

/** A database node id for a connection string. */
function databaseNodeId(provider: string, host: string): string {
  return `${provider}://${host}`
}

/**
 * Build the network graph for a workspace.
 *
 * Scans each service for URLs pointing at its siblings and at datastores, then
 * turns those into nodes and edges. Pure file reading, so it is safe to call at
 * any time and from any environment.
 */
export function discoverNetworkGraph(
  services: NetworkService[],
  opts: { domainSuffix?: string } = {},
): NetworkGraph {
  const domainSuffix = opts.domainSuffix ?? 'axxes.local'
  const warnings: string[] = []
  const nodes = new Map<string, NetworkNode>()
  const edges = new Map<string, NetworkEdge>()

  // Every service is a node, even with no connections: an isolated app is still
  // part of the picture, and the user needs to see that it stands alone.
  for (const svc of services) {
    nodes.set(svc.name, {
      id: svc.name,
      label: svc.name,
      kind: 'app',
      framework: svc.framework,
      port: svc.port,
      domain: `${svc.name}.${domainSuffix}`,
      detail: 'service in this workspace',
    })
  }

  const addEdge = (edge: NetworkEdge): void => {
    if (edge.from === edge.to) return
    // One edge per (from, to, kind); keep the first evidence found.
    const key = `${edge.from} ${edge.to} ${edge.kind}`
    if (edges.has(key)) return
    edges.set(key, edge)
  }

  for (const svc of services) {
    if (!existsSync(svc.path)) {
      warnings.push(`${svc.name}: ${svc.path} is not readable`)
      continue
    }
    const budget = { left: MAX_FILES_PER_SERVICE }
    for (const file of listFiles(svc.path, budget)) {
      const text = readText(file)
      if (!text) continue
      const where = evidencePath(svc.path, file)

      // Database connection strings.
      for (const m of text.matchAll(DB_URL)) {
        const provider = (m[1] ?? '').toLowerCase()
        const host = (m[2] ?? '').toLowerCase()
        if (!host) continue
        const id = databaseNodeId(provider, host)
        if (!nodes.has(id)) {
          nodes.set(id, {
            id,
            label: `${provider} · ${host}`,
            kind: 'database',
            detail: `${provider} connection string`,
          })
        }
        addEdge({ from: svc.name, to: id, kind: 'database', label: `${provider}://${host}`, evidence: where })
      }

      // HTTP calls to other hosts.
      for (const m of text.matchAll(HTTP_URL)) {
        const host = (m[1] ?? '').toLowerCase()
        const port = m[2] ? Number(m[2]) : undefined
        if (!host) continue
        if (KNOWN_EXTERNAL.has(host)) continue
        // The app's own name or domain is not an edge to anything.
        if (host === svc.name.toLowerCase()) continue
        if (host === `${svc.name.toLowerCase()}.${domainSuffix.toLowerCase()}`) continue

        const target = classifyHost(host, port, services, domainSuffix)
        if (target.kind === 'app') {
          if (target.id === svc.name) continue
          addEdge({
            from: svc.name,
            to: target.id,
            kind: 'http',
            label: `http://${host}${port ? `:${port}` : ''}`,
            evidence: where,
          })
        } else {
          if (!nodes.has(target.id)) {
            nodes.set(target.id, {
              id: target.id,
              label: host,
              kind: 'external',
              detail: 'third-party host referenced in code',
            })
          }
          addEdge({
            from: svc.name,
            to: target.id,
            kind: 'http',
            label: `http://${host}${port ? `:${port}` : ''}`,
            evidence: where,
          })
        }
      }
    }
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => nodeOrder(a, b)),
    edges: [...edges.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
    ),
    warnings,
  }
}



/**
 * Layer the graph for drawing: apps flow left to right by how deep they sit in
 * the dependency chain, datastores and third-party hosts go on the far right.
 */
export function layoutNetwork(
  graph: NetworkGraph,
  opts: { width?: number } = {},
): { width: number; height: number; positions: Map<string, { x: number; y: number; node: NetworkNode }> } {
  const width = opts.width ?? 900
  const colW = 190
  const rowH = 64
  const padX = 110
  const padY = 48

  const appIds = graph.nodes.filter((n) => n.kind === 'app').map((n) => n.id)
  const rightIds = graph.nodes.filter((n) => n.kind !== 'app').map((n) => n.id)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))

  // Longest-path depth over app-to-app edges, bounded so a cycle cannot run away.
  const depth = new Map<string, number>(appIds.map((id) => [id, 0]))
  const appEdges = graph.edges.filter(
    (e) => depth.has(e.from) && depth.has(e.to) && e.kind === 'http',
  )
  for (let pass = 0; pass < appIds.length; pass++) {
    let changed = false
    for (const e of appEdges) {
      const next = (depth.get(e.from) ?? 0) + 1
      if (next > (depth.get(e.to) ?? 0) && next < appIds.length) {
        depth.set(e.to, next)
        changed = true
      }
    }
    if (!changed) break
  }

  const byDepth = new Map<number, string[]>()
  for (const id of appIds) {
    const d = depth.get(id) ?? 0
    byDepth.set(d, [...(byDepth.get(d) ?? []), id])
  }

  const positions = new Map<string, { x: number; y: number; node: NetworkNode }>()
  const maxDepth = Math.max(0, ...byDepth.keys())
  const rightCol = maxDepth + 1

  for (const [d, ids] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, i) => {
      const node = byId.get(id)
      if (node) positions.set(id, { x: padX + d * colW, y: padY + i * rowH, node })
    })
  }

  rightIds.forEach((id, i) => {
    const node = byId.get(id)
    if (node) positions.set(id, { x: padX + rightCol * colW, y: padY + i * rowH, node })
  })

  const tallest = Math.max(1, ...[...byDepth.values()].map((v) => v.length), rightIds.length)
  const height = padY * 2 + tallest * rowH

  return { width, height, positions }
}

const KIND_FILL: Record<NetworkNodeKind, string> = {
  app: '#12331f',
  database: '#2a2340',
  external: '#33291a',
}
const KIND_STROKE: Record<NetworkNodeKind, string> = {
  app: '#4ade80',
  database: '#c4b5fd',
  external: '#fbbf24',
}
const EDGE_STROKE: Record<NetworkEdgeKind, string> = {
  http: '#7fdbca',
  database: '#c4b5fd',
  config: '#8a94a8',
}

function escXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render the graph as a standalone SVG string.
 *
 * Dependency-free on purpose: the dashboard serves a single HTML page with no
 * build step and no CDN, so the picture has to be plain markup.
 */
export function renderNetworkSvg(graph: NetworkGraph, opts: { width?: number } = {}): string {
  if (graph.nodes.length === 0) return ''
  const { width, height, positions } = layoutNetwork(graph, opts)
  const parts: string[] = [
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" ` +
      `xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Service network map" ` +
      `style="max-width:${width}px">`,
  ]

  // Edges first so the node boxes sit on top of the lines.
  for (const edge of graph.edges) {
    const a = positions.get(edge.from)
    const b = positions.get(edge.to)
    if (!a || !b) continue
    const x1 = a.x + 70
    const y1 = a.y + 16
    const x2 = b.x - 70
    const y2 = b.y + 16
    const mid = (x1 + x2) / 2
    const d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
    const what = `${edge.from} → ${edge.to} (${edge.label ?? edge.kind})`
    parts.push(
      `<path d="${d}" fill="none" stroke="${EDGE_STROKE[edge.kind]}" stroke-width="1.5" ` +
        `stroke-dasharray="${edge.kind === 'database' ? '4 3' : '0'}" opacity="0.85">` +
        `<title>${escXml(edge.evidence ? `${what} — ${edge.evidence}` : what)}</title></path>`,
    )
  }

  for (const [, pos] of positions) {
    const n = pos.node
    const label = escXml(n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label)
    const sub = n.kind === 'app' && n.port !== undefined ? `:${n.port}` : n.kind
    parts.push(
      `<g><title>${escXml(n.detail ? `${n.label} — ${n.detail}` : n.label)}</title>` +
        `<rect x="${pos.x - 70}" y="${pos.y}" width="140" height="32" rx="7" ` +
        `fill="${KIND_FILL[n.kind]}" stroke="${KIND_STROKE[n.kind]}" stroke-width="1"/>` +
        `<text x="${pos.x}" y="${pos.y + 14}" fill="#d6deeb" font-size="11" ` +
        `font-family="ui-monospace,Menlo,monospace" text-anchor="middle">${label}</text>` +
        `<text x="${pos.x}" y="${pos.y + 26}" fill="${KIND_STROKE[n.kind]}" font-size="9" ` +
        `font-family="ui-monospace,Menlo,monospace" text-anchor="middle">${escXml(sub)}</text></g>`,
    )
  }

  parts.push('</svg>')
  return parts.join('')
}

/** One-line summary for the CLI, e.g. "3 apps · 4 connections · 1 database". */
export function summariseNetwork(graph: NetworkGraph): string {
  const apps = graph.nodes.filter((n) => n.kind === 'app').length
  const dbs = graph.nodes.filter((n) => n.kind === 'database').length
  const ext = graph.nodes.filter((n) => n.kind === 'external').length
  const parts = [
    `${apps} app${apps === 1 ? '' : 's'}`,
    `${graph.edges.length} connection${graph.edges.length === 1 ? '' : 's'}`,
  ]
  if (dbs) parts.push(`${dbs} database${dbs === 1 ? '' : 's'}`)
  if (ext) parts.push(`${ext} external`)
  return parts.join(' · ')
}

/** Apps first, then databases, then external hosts; alphabetical within a kind. */
function nodeOrder(a: NetworkNode, b: NetworkNode): number {
  const rank = (n: NetworkNode): number => (n.kind === 'app' ? 0 : n.kind === 'database' ? 1 : 2)
  return rank(a) - rank(b) || a.label.localeCompare(b.label)
}
