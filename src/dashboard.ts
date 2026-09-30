import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MercelleError } from './errors.js'
import { consoleLogger } from './logger.js'
import { renderNetworkSvg, type NetworkGraph } from './network.js'
import type { Logger, VmBackend } from './types.js'

/** Default port the dashboard listens on. */
export const DASHBOARD_PORT = 4242

/** Lifecycle state of an app shown in the dashboard. */
export type AppStatus = 'starting' | 'running' | 'error' | 'stopped' | 'unknown'

/** One app (service) running in the VM. */
export interface DashboardApp {
  name: string
  framework: string
  port: number
  url: string
  status: AppStatus
  pid?: string | null
  /** Database provider detected for this app, or null. */
  database?: string | null
}

/** A row of the databases section. */
export interface DatabaseRow {
  service: string
  provider: string | null
  /** Where the DSN stands relative to the VM. */
  env: 'local' | 'production' | 'none'
  detail?: string
}

/** A local domain bound to an app. */
export interface DomainRow {
  service: string
  domain: string
  url: string
}

/** Something worth fixing, surfaced in the issues section. */
export interface DashboardIssue {
  t: number
  level: 'warn' | 'error'
  message: string
  hint?: string
}

/** One line of the boot log. */
export interface BootLine {
  t: number
  level: 'info' | 'step' | 'success' | 'warn' | 'error'
  msg: string
}

export interface DashboardMeta {
  backend?: string | null
  machine?: string | null
}

/** Everything the dashboard UI needs, also served as JSON at /api/state. */
export interface DashboardState {
  status: 'booting' | 'ready'
  backend: string | null
  machine: string | null
  startedAt: number
  bootLog: BootLine[]
  apps: DashboardApp[]
  databases: DatabaseRow[]
  domains: DomainRow[]
  /** How the apps are wired to each other, as far as mercelle can infer. */
  network: NetworkGraph | null
  /** App names mercelle recommends for local testing. */
  suggestions: string[]
  issues: DashboardIssue[]
}

export interface DashboardOptions {
  /** Preferred port; falls forward to the next free port when taken. */
  port?: number
  logger?: Logger
  /** Interface to bind. Loopback by default: the dashboard is a local tool. */
  host?: string
  /** Tails an app's log inside the VM. Wired up by the CLI. */
  tail?: (app: DashboardApp) => Promise<string>
  /** Tails every app's log at once. Wired up by the CLI. */
  tailAll?: () => Promise<string>
  /** Open a browser tab when the server comes up (TTY sessions only). */
  open?: boolean
}

const BOOT_LOG_CAP = 500
const ISSUES_CAP = 100

/** Remove ANSI colour escapes so the web UI shows clean text. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/**
 * The mercelle web dashboard.
 *
 * A tiny dependency-free HTTP server that shows, live, what mercelle is doing:
 * the boot log as the VM spins up, every app that is running with its URL,
 * what databases the apps use (and which DSNs were withheld), and any issues
 * encountered along the way.
 */
export class Dashboard {
  private readonly requestedPort: number
  private readonly host: string
  private readonly log: Logger
  private readonly tailFn?: (app: DashboardApp) => Promise<string>
  private readonly tailAllFn?: () => Promise<string>
  private readonly openBrowser: boolean

  private server: Server | null = null
  private portValue = 0

  private readonly bootLog: BootLine[] = []
  private readonly apps = new Map<string, DashboardApp>()
  private readonly databases: DatabaseRow[] = []
  private readonly domains: DomainRow[] = []
  private network: NetworkGraph | null = null
  private suggestions: string[] = []
  private readonly issues: DashboardIssue[] = []
  private meta: DashboardMeta = {}
  private readonly startedAt = Date.now()
  private booted = false

  constructor(opts: DashboardOptions = {}) {
    this.requestedPort = opts.port ?? DASHBOARD_PORT
    this.host = opts.host ?? '127.0.0.1'
    this.log = opts.logger ?? consoleLogger
    this.tailFn = opts.tail
    this.tailAllFn = opts.tailAll
    this.openBrowser = opts.open ?? false
  }

  /** Append a line to the boot log (oldest first, capped). */
  boot(msg: string, level: BootLine['level'] = 'info'): void {
    this.bootLog.push({ t: Date.now(), level, msg: stripAnsi(msg) })
    if (this.bootLog.length > BOOT_LOG_CAP) this.bootLog.splice(0, this.bootLog.length - BOOT_LOG_CAP)
  }

  setMeta(meta: DashboardMeta): void {
    this.meta = { ...this.meta, ...meta }
  }

  addApp(app: DashboardApp): void {
    this.apps.set(app.name, app)
  }

  setAppStatus(name: string, status: AppStatus, patch: Partial<Omit<DashboardApp, 'name' | 'status'>> = {}): void {
    const app = this.apps.get(name)
    if (!app) return
    Object.assign(app, patch, { status })
  }

  setDatabases(rows: DatabaseRow[]): void {
    this.databases.splice(0, this.databases.length, ...rows)
  }

  setDomains(rows: DomainRow[]): void {
    this.domains.splice(0, this.domains.length, ...rows)
  }

  /** Attach the discovered service-to-service network. */
  setNetwork(graph: NetworkGraph | null): void {
    this.network = graph
  }

  setSuggestions(names: string[]): void {
    this.suggestions = [...names]
  }

  addIssue(issue: Omit<DashboardIssue, 't'>): void {
    this.issues.push({ ...issue, t: Date.now() })
    if (this.issues.length > ISSUES_CAP) this.issues.splice(0, this.issues.length - ISSUES_CAP)
  }

  /** Flip the header pill from "spinning up" to "running". */
  markBooted(): void {
    this.booted = true
  }

  /** The full dashboard state, also served as JSON for the UI to poll. */
  state(): DashboardState {
    return {
      status: this.booted ? 'ready' : 'booting',
      backend: this.meta.backend ?? null,
      machine: this.meta.machine ?? null,
      startedAt: this.startedAt,
      bootLog: [...this.bootLog],
      apps: [...this.apps.values()].sort((a, b) => a.name.localeCompare(b.name)),
      databases: [...this.databases],
      domains: [...this.domains],
      network: this.network,
      suggestions: [...this.suggestions],
      issues: [...this.issues],
    }
  }

  /** The port actually bound after start(). */
  get port(): number {
    return this.portValue
  }

  get url(): string {
    return `http://localhost:${this.portValue}`
  }

  /**
   * Start serving. Tries the preferred port, then the next nine, then an
   * ephemeral one, so a stray dashboard never blocks a boot.
   */
  async start(): Promise<number> {
    if (this.server) return this.portValue

    const candidates = this.requestedPort === 0 ? [0] : [this.requestedPort, 0]
    for (let i = 0; i < 10; i++) candidates.splice(1 + i, 0, this.requestedPort + 1 + i)

    for (const port of candidates) {
      try {
        const bound = await this.listenOn(port)
        if (this.openBrowser && process.stdout.isTTY) openBrowserTab(this.url)
        return bound
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err
      }
    }
    throw new MercelleError('Could not find a free port for the dashboard.')
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Bind once; resolves with the actual port (useful when port is 0). */
  private listenOn(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res))
      let settled = false

      const fail = (err: NodeJS.ErrnoException): void => {
        if (settled) return
        settled = true
        server.close()
        reject(err)
      }

      server.once('error', fail)
      server.listen(port, this.host, () => {
        if (settled) return
        settled = true
        this.server = server
        // Runtime errors after bind must not crash mercelle.
        server.on('error', (err: Error) => this.log.error(`dashboard: ${err.message}`))
        const addr = server.address() as AddressInfo
        this.portValue = addr.port
        resolve(addr.port)
      })
    })
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' }).end('method not allowed')
      return
    }

    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
      return
    }

    if (url === '/api/logs') {
      // Live output from every app in the stack, one prefixed block each, so a
      // failure in one service can be read next to the caller that hit it.
      if (!this.tailAllFn) {
        res.writeHead(503, { 'content-type': 'text/plain' }).end('log tailing is not available in this session.')
        return
      }
      this.tailAllFn()
        .then((text) => {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end(text)
        })
        .catch((err: Error) => {
          res.writeHead(500, { 'content-type': 'text/plain' }).end(err.message)
        })
      return
    }

    if (url === '/api/network.svg') {
      if (!this.network) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('no network discovered')
        return
      }
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
      res.end(renderNetworkSvg(this.network))
      return
    }

    if (url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(this.state()))
      return
    }

    if (url.startsWith('/api/app/') && url.endsWith('/log')) {
      const name = decodeURIComponent(url.slice('/api/app/'.length, -'/log'.length))
      const app = this.apps.get(name)
      if (!app) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end(`unknown app: ${name}`)
        return
      }
      if (!this.tailFn) {
        res.writeHead(503, { 'content-type': 'text/plain' }).end('log tailing is not available in this session.')
        return
      }
      this.tailFn(app)
        .then((text) => {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(text)
        })
        .catch((err: Error) => {
          res.writeHead(500, { 'content-type': 'text/plain' }).end(err.message)
        })
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  }
}

/**
 * Mirror a logger into the dashboard: every line lands in the boot log, and
 * warn/error lines also become issues so nothing gets lost in the scroll.
 */
export function teeLog(log: Logger, dashboard: Dashboard): Logger {
  return {
    info: (msg) => {
      log.info(msg)
      dashboard.boot(msg, 'info')
    },
    success: (msg) => {
      log.success(msg)
      dashboard.boot(msg, 'success')
    },
    warn: (msg) => {
      log.warn(msg)
      dashboard.boot(msg, 'warn')
      dashboard.addIssue({ level: 'warn', message: stripAnsi(msg) })
    },
    error: (msg) => {
      log.error(msg)
      dashboard.boot(msg, 'error')
      dashboard.addIssue({ level: 'error', message: stripAnsi(msg) })
    },
    step: (msg) => {
      log.step(msg)
      dashboard.boot(msg, 'step')
    },
    // Raw streaming output is shown in the terminal only; the boot log is for
    // mercelle's own narration.
    raw: (msg) => log.raw(msg),
  }
}

/**
 * Tail an app's log file inside the VM (`/tmp/<app>.log`, where `stack`
 * nohup'd it). Shared by the `stack` and `ui` commands.
 */
export async function tailAppLog(orb: VmBackend, machine: string, app: DashboardApp): Promise<string> {
  if (!machine) return 'No VM is associated with this project yet — run `mercelle stack` first.'
  if (!/^[A-Za-z0-9._-]+$/.test(app.name)) return 'This app name cannot be resolved to a log file.'
  const res = await orb.run(machine, `tail -n 200 '/tmp/${app.name}.log' 2>&1`, { allowFailure: true })
  return res.stdout.trim() || res.stderr.trim() || `(no output yet from ${app.name})`
}

/** Best-effort browser open; silently ignored when nothing works. */
function openBrowserTab(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.unref?.()
  } catch {
    /* the dashboard URL is logged anyway */
  }
}

/**
 * The dashboard page: one static HTML file, no build step, no CDN.
 * The page polls /api/state and re-renders; sections appear as data arrives.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mercelle</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0b0e14; color:#d6deeb; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  header { display:flex; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid #1c2333; position:sticky; top:0; background:#0b0e14ee; }
  .logo { font-weight:700; letter-spacing:.5px; color:#7fdbca; font-size:15px; }
  .pill { padding:2px 10px; border-radius:999px; font-size:12px; }
  .pill.booting { background:#3a2f12; color:#ffd580; animation:pulse 1.2s infinite; }
  .pill.ready { background:#12331f; color:#7ee2a8; }
  @keyframes pulse { 50% { opacity:.55 } }
  .meta { margin-left:auto; color:#5b677e; font-size:12px; }
  main { max-width: 980px; margin: 0 auto; padding: 20px; display:grid; gap:16px; }
  section { border:1px solid #1c2333; border-radius:10px; overflow:hidden; }
  h2 { margin:0; padding:9px 14px; font-size:11px; text-transform:uppercase; letter-spacing:1.2px; color:#8a94a8; background:#10151f; border-bottom:1px solid #1c2333; font-weight:600; }
  .log { max-height:280px; overflow-y:auto; padding:10px 14px; white-space:pre-wrap; word-break:break-word; }
  .log .t { color:#4c5a75; margin-right:8px; }
  .log .warn { color:#ffd580 } .log .error { color:#ff8080 } .log .success { color:#7ee2a8 } .log .step { color:#6b7a94 }
  table { width:100%; border-collapse:collapse; }
  td,th { padding:7px 14px; border-bottom:1px solid #151b29; text-align:left; font-size:13px; }
  th { color:#8a94a8; font-size:11px; text-transform:uppercase; letter-spacing:.8px; background:#0e131d; }
  tr:last-child td { border-bottom:none }
  a { color:#66c7ff; text-decoration:none } a:hover { text-decoration:underline }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; }
  .dot.running { background:#38d97d; box-shadow:0 0 6px #38d97d88 }
  .dot.starting { background:#ffc24b; animation:pulse 1.2s infinite }
  .dot.error { background:#ff5d5d }
  .dot.stopped, .dot.unknown { background:#4c5a75 }
  .badge { font-size:11px; padding:1px 8px; border-radius:6px; border:1px solid #26314a; color:#9aa7c1; }
  .logs-btn { background:none; border:1px solid #26314a; color:#9aa7c1; border-radius:6px; font:inherit; font-size:11px; padding:1px 8px; cursor:pointer }
  .logs-btn:hover { color:#d6deeb; border-color:#3b4a6b }
  .muted { color:#5b677e }
  .issue { padding:8px 14px; border-bottom:1px solid #151b29; font-size:13px; }
  .issue:last-child { border-bottom:none }
  .w { color:#ffd580 } .e { color:#ff8080 }
  #overlay { position:fixed; inset:0; background:#000a; display:none; align-items:center; justify-content:center; }
  #overlay.open { display:flex }
  #overlay pre { background:#0b0e14; border:1px solid #26314a; border-radius:10px; width:min(860px, 92vw); max-height:80vh; overflow:auto; padding:16px; font-size:12px; white-space:pre-wrap; word-break:break-word; }
  footer { text-align:center; color:#4c5a75; font-size:12px; padding:4px 0 24px }
</style>
</head>
<body>
<header>
  <span class="logo">mercelle</span>
  <span id="pill" class="pill booting">spinning up</span>
  <span class="meta" id="meta"></span>
</header>
<main>
  <section>
    <h2>Boot log</h2>
    <div class="log" id="bootlog"></div>
  </section>
  <section>
    <h2>Apps</h2>
    <table><thead><tr><th></th><th>app</th><th>framework</th><th>database</th><th>url</th><th>pid</th><th></th></tr></thead>
    <tbody id="apps"></tbody></table>
  </section>
  <section id="domainsSection" style="display:none">
    <h2>Local domains</h2>
    <div id="domains" class="issue" style="border-bottom:none"></div>
  </section>
  <section id="networkSection" style="display:none">
    <h2>Network</h2>
    <div id="netSummary" style="padding:8px 14px 0;color:#8a94a8;font-size:12px"></div>
    <div id="netGraph" style="padding:10px 14px 14px;overflow-x:auto"></div>
    <table><thead><tr><th>from</th><th>to</th><th>kind</th><th>seen in</th></tr></thead><tbody id="netEdges"></tbody></table>
  </section>
  <section>
    <h2>Databases</h2>
    <table><thead><tr><th>service</th><th>provider</th><th>dsn</th><th>detail</th></tr></thead><tbody id="dbs"></tbody></table>
  </section>
  <section id="suggestSection" style="display:none">
    <h2>Suggested for local testing</h2>
    <div id="suggestions" class="issue" style="border-bottom:none"></div>
  </section>
  <section id="logsSection" style="display:none">
    <h2>Live logs — all apps</h2>
    <div class="log" id="liveLogs"></div>
  </section>
  <section>
    <h2>Issues</h2>
    <div id="issues"></div>
  </section>
</main>
<footer id="foot"></footer>
<div id="overlay" onclick="this.classList.remove('open')"><pre id="overlayPre"></pre></div>
<script>
  function esc(s){ var d=document.createElement('div'); d.textContent=s==null?'':String(s); return d.innerHTML }
  function pad(n){ return (n<10?'0':'')+n }
  function ts(t){ var d=new Date(t); return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds()) }
  function render(s){
    var pill=document.getElementById('pill');
    pill.className='pill '+(s.status==='ready'?'ready':'booting');
    pill.textContent=s.status==='ready'?'running':'spinning up';
    document.title='mercelle — '+(s.status==='ready'?'running':'spinning up');
    var bits=[];
    if(s.machine) bits.push(s.machine);
    if(s.backend) bits.push(s.backend);
    bits.push('since '+ts(s.startedAt));
    document.getElementById('meta').textContent=bits.join(' · ');
    var log=document.getElementById('bootlog');
    var stick=log.scrollHeight-log.scrollTop-log.clientHeight<40;
    var html='';
    for(var i=0;i<s.bootLog.length;i++){var L=s.bootLog[i];
      html+='<div class="'+L.level+'"><span class="t">'+ts(L.t)+'</span>'+esc(L.msg)+'</div>';}
    log.innerHTML=html;
    if(stick) log.scrollTop=log.scrollHeight;
    var rows='';
    for(var i=0;i<s.apps.length;i++){var a=s.apps[i];
      rows+='<tr><td><span class="dot '+a.status+'" title="'+esc(a.status)+'"></span></td>'+
        '<td>'+esc(a.name)+'</td><td class="muted">'+esc(a.framework)+'</td>'+
        '<td>'+(a.database?'<span class="badge">'+esc(a.database)+'</span>':'<span class="muted">—</span>')+'</td>'+
        '<td><a href="'+esc(a.url)+'" target="_blank" rel="noreferrer">'+esc(a.url)+'</a></td>'+
        '<td class="muted">'+esc(a.pid||'')+'</td>'+
        '<td><button class="logs-btn" onclick="showLogs(\\''+esc(a.name)+'\\')">logs</button></td></tr>';}
    document.getElementById('apps').innerHTML=rows||'<tr><td class="muted">no apps yet</td></tr>';
    var drows='';
    for(var i=0;i<s.databases.length;i++){var db=s.databases[i];
      var dsn=db.env==='local'?'<span class="badge" style="color:#7ee2a8;border-color:#1f4630">local</span>'
        :db.env==='production'?'<span class="badge" style="color:#ffd580;border-color:#4a3b12">withheld</span>'
        :'<span class="muted">none</span>';
      drows+='<tr><td>'+esc(db.service)+'</td><td>'+(db.provider?esc(db.provider):'<span class="muted">—</span>')+'</td>'+
        '<td>'+dsn+'</td><td class="muted">'+esc(db.detail||'')+'</td></tr>';}
    document.getElementById('dbs').innerHTML=drows||'<tr><td class="muted">no databases detected</td></tr>';
    var doms='';
    if(s.domains&&s.domains.length){
      document.getElementById('domainsSection').style.display='';
      for(var i=0;i<s.domains.length;i++){var dm=s.domains[i];
        doms+='<a href="'+esc(dm.url)+'" target="_blank" rel="noreferrer">'+esc(dm.domain)+'</a> <span class="muted">→ '+esc(dm.service)+' :'+dm.port+'</span><br>';}
    }
    document.getElementById('domains').innerHTML=doms;
    var net=s.network;
    if(net&&net.nodes&&net.nodes.length){
      document.getElementById('networkSection').style.display='';
      var apps=0,dbs=0,ext=0;
      for(var i=0;i<net.nodes.length;i++){var nd=net.nodes[i];
        if(nd.kind==='app')apps++;else if(nd.kind==='database')dbs++;else ext++;}
      var bits=[apps+' app'+(apps===1?'':'s'),(net.edges?net.edges.length:0)+' connection'+((net.edges&&net.edges.length===1)?'':'s')];
      if(dbs)bits.push(dbs+' database'+(dbs===1?'':'s'));
      if(ext)bits.push(ext+' external');
      document.getElementById('netSummary').textContent=bits.join(' · ')+' — inferred by reading URLs out of the source.';
      // The graph is server-rendered SVG, so the page stays dependency-free.
      // data-live makes poll() refresh it as new apps are wired up.
      document.getElementById('netGraph').innerHTML=
        '<img id="netImg" src="/api/network.svg" alt="Service network map" data-live="1" style="max-width:100%">';
      var erows='';
      for(var i=0;i<(net.edges||[]).length;i++){var e=net.edges[i];
        erows+='<tr><td>'+esc(e.from)+'</td><td>'+esc(e.to)+'</td><td class="muted">'+esc(e.label||e.kind)+
          '</td><td class="muted">'+esc(e.evidence||'')+'</td></tr>';}
      document.getElementById('netEdges').innerHTML=erows||
        '<tr><td class="muted" colspan="4">no connections found between these services</td></tr>';
    }
    var sugs='';
    if(s.suggestions&&s.suggestions.length){
      document.getElementById('suggestSection').style.display='';
      for(var i=0;i<s.suggestions.length;i++){sugs+='<span class="badge" style="margin-right:8px">'+esc(s.suggestions[i])+'</span>';}
    }
    document.getElementById('suggestions').innerHTML=sugs;
    // Live logs across every app, refreshed with the rest of the state.
    fetch('/api/logs',{cache:'no-store'}).then(function(r){
      if(!r.ok)return null; return r.text();
    }).then(function(t){
      var el=document.getElementById('liveLogs');
      if(t===null||!el)return;
      if(t.trim()){document.getElementById('logsSection').style.display=''; el.textContent=t;}
    }).catch(function(){});

    var irows='';
    for(var i=0;i<s.issues.length;i++){var x=s.issues[i];
      irows+='<div class="issue"><span class="'+(x.level==='error'?'e':'w')+'">'+(x.level==='error'?'✗':'!')+'</span> '+esc(x.message)+'</div>';}
    document.getElementById('issues').innerHTML=irows||'<div class="issue muted">no issues — everything checks out</div>';
    document.getElementById('foot').textContent='auto-refreshing · last update '+ts(Date.now());
  }
  function showLogs(name){
    var pre=document.getElementById('overlayPre');
    pre.textContent='loading '+name+' logs…';
    document.getElementById('overlay').classList.add('open');
    fetch('/api/app/'+encodeURIComponent(name)+'/log').then(function(r){
      return r.text().then(function(t){ return r.ok ? t : ('failed to load logs: '+t) });
    }).then(function(t){ if(pre.textContent.indexOf('loading ')===0||true){ pre.textContent=t||'(empty)' } })
    .catch(function(e){ pre.textContent='failed: '+e });
  }
  function poll(){
    fetch('/api/state',{cache:'no-store'}).then(function(r){return r.json()}).then(render).catch(function(){});
    // The map is a separate endpoint so a growing graph can be re-rendered
    // without re-fetching the whole state. Cache-busting matters: the SVG is
    // otherwise served from the browser cache and the picture goes stale the
    // moment a new app is wired up.
    var img=document.getElementById('netImg');
    if(img&&img.getAttribute('data-live')==='1'){
      img.src='/api/network.svg?t='+Date.now();
    }
  }
  poll(); setInterval(poll, 1200);
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') document.getElementById('overlay').classList.remove('open') });
</script>
</body>
</html>
`
