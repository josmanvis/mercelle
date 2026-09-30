import { createServer, request as httpRequest, type Server } from 'node:http'
import { isPortOpen } from './orb.js'
import { c, consoleLogger } from './logger.js'
import type { Logger } from './types.js'

/**
 * axxes-style local domains: `<service>.axxes.local`.
 *
 * The suffix is a TLD-shaped name so it can never collide with a real zone we
 * do not control, and apps that build absolute URLs from VERCEL_URL keep
 * working when the Host header carries the domain.
 */
export const DEFAULT_DOMAIN_SUFFIX = 'axxes.local'

/** Everything needed to route one local domain to one app. */
export interface DomainRoute {
  service: string
  /** Full local domain, e.g. `web.axxes.local`. */
  domain: string
  port: number
  url: string
}

/** Build `<service>.<suffix>` routes for a set of services. */
export function domainRoutes(
  services: { name: string; port: number }[],
  suffix: string = DEFAULT_DOMAIN_SUFFIX,
): DomainRoute[] {
  return services.map((s) => ({
    service: s.name,
    domain: `${s.name}.${suffix}`,
    port: s.port,
    url: `http://${s.name}.${suffix}`,
  }))
}

/** The exact hosts block mercelle manages, so uninstall is surgical. */
export const HOSTS_BEGIN = '# mercelle:begin'
export const HOSTS_END = '# mercelle:end'

/** Render the managed hosts block for these routes. */
export function hostsBlock(routes: DomainRoute[]): string {
  if (routes.length === 0) return ''
  const lines = routes.map((r) => `127.0.0.1\t${r.domain}`)
  return `${HOSTS_BEGIN}\n${lines.join('\n')}\n${HOSTS_END}`
}

/** Insert or replace the mercelle block in an /etc/hosts-style document. */
export function upsertHostsBlock(existing: string, routes: DomainRoute[]): string {
  const block = hostsBlock(routes)
  const begin = existing.indexOf(HOSTS_BEGIN)
  const end = existing.indexOf(HOSTS_END)

  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin)
    const after = existing.slice(end + HOSTS_END.length)
    const tail = after.startsWith('\n') ? after : `\n${after}`
    return `${before}${block}${tail}`.replace(/\n{3,}/g, '\n\n')
  }

  const base = existing.endsWith('\n') || existing.length === 0 ? existing : `${existing}\n`
  return `${base}\n${block}\n`
}

/** Remove the mercelle block entirely (used by `mercelle domains --remove`). */
export function removeHostsBlock(existing: string): string {
  const begin = existing.indexOf(HOSTS_BEGIN)
  const end = existing.indexOf(HOSTS_END)
  if (begin === -1 || end === -1 || end < begin) return existing
  const before = existing.slice(0, begin)
  const after = existing.slice(end + HOSTS_END.length)
  return `${before}${after.replace(/^\n/, '')}`.replace(/\n{3,}/g, '\n\n')
}

/** Hosts entries mercelle currently manages, parsed back out of the file. */
export function readManagedHosts(existing: string): string[] {
  const begin = existing.indexOf(HOSTS_BEGIN)
  const end = existing.indexOf(HOSTS_END)
  if (begin === -1 || end === -1 || end < begin) return []
  return existing
    .slice(begin + HOSTS_BEGIN.length, end)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[1] ?? '')
    .filter(Boolean)
}

/** Flush the macOS DNS cache after an /etc/hosts edit. */
async function flushDns(log: Logger): Promise<void> {
  const { execFile } = await import('node:child_process')
  await new Promise<void>((resolve) => {
    execFile('dscacheutil', ['-flushcache'], () => resolve())
  })
  await new Promise<void>((resolve) => {
    execFile('killall', ['-HUP', 'mDNSResponder'], () => resolve())
  })
  log.step('Flushed the macOS DNS cache.')
}

/**
 * Write the hosts block (needs sudo; the caller surfaces the command).
 * Returns the command for the user to run when we cannot write directly.
 */
export async function installHostsEntries(
  routes: DomainRoute[],
  hostsPath = '/etc/hosts',
  log: Logger = consoleLogger,
): Promise<{ written: boolean; manualCommand?: string }> {
  const { readFileSync, writeFileSync } = await import('node:fs')
  let existing = ''
  try {
    existing = readFileSync(hostsPath, 'utf8')
  } catch {
    existing = ''
  }

  const next = upsertHostsBlock(existing, routes)
  try {
    writeFileSync(hostsPath, next, { mode: 0o644 })
    await flushDns(log)
    return { written: true }
  } catch {
    const script = `cat <<'EOF' | sudo tee /etc/hosts > /dev/null\n${next}EOF`
    return { written: false, manualCommand: script }
  }
}

/**
 * Host-side reverse proxy: one port routes `Host: <service>.<suffix>` to the
 * matching app port inside the VM. Without it, browsers would hit 127.0.0.1
 * regardless of which domain was requested.
 */
export function startDomainProxy(
  routes: DomainRoute[],
  opts: { port?: number; logger?: Logger; host?: string } = {},
): { server: Server; port: number; close: () => Promise<void> } | null {
  if (routes.length === 0) return null
  const log = opts.logger ?? consoleLogger
  const host = opts.host ?? '127.0.0.1'
  const byDomain = new Map(routes.map((r) => [r.domain.toLowerCase(), r]))

  const server = createServer((req, res) => {
    const hostHeader = ((req.headers.host as string | undefined) ?? '').split(':')[0]!.toLowerCase()
    const route = byDomain.get(hostHeader)
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end(`mercelle: no app is bound to "${hostHeader}". Known domains:\n${[...byDomain.keys()].map((d) => `  http://${d}`).join('\n')}\n`)
      return
    }
    const proxyReq = httpRequest(
      { host: '127.0.0.1', port: route.port, path: req.url ?? '/', method: req.method, headers: { ...req.headers, host: hostHeader } },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
        proxyRes.pipe(res)
      },
    )
    proxyReq.on('error', (err: Error) => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`mercelle: ${route.domain} (port ${route.port}) is not accepting connections: ${err.message}\n`)
    })
    req.pipe(proxyReq)
  })

  let port = opts.port ?? 80
  try {
    server.listen(port, host)
  } catch {
    port = 8080
    server.listen(port, host)
  }
  server.on('error', (err: Error) => log.error(`domain proxy: ${err.message}`))
  log.success(`Domain proxy: *.${DEFAULT_DOMAIN_SUFFIX.replace('.local', '')} → apps ${c.dim(`(port ${port})`)}`)

  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Probe whether an app's port is accepting connections. */
export async function probePort(port: number): Promise<boolean> {
  return isPortOpen(port, '127.0.0.1', 400)
}
