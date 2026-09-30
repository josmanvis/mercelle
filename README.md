<p align="center">
  <img src="docs/assets/mercelle.svg" alt="mercelle" width="120">
</p>

<p align="center">
  <b>Test on Linux before you ship to Vercel.</b>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#the-workflow">Workflow</a> ·
  <a href="#commands">Commands</a> ·
  <a href="docs/">Docs</a> ·
  <a href="https://github.com/josmanvis/mercelle/issues">Issues</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mercelle"><img alt="npm version" src="https://img.shields.io/npm/v/mercelle.svg"></a>
  <a href="https://www.npmjs.com/package/mercelle"><img alt="npm downloads" src="https://img.shields.io/npm/dm/mercelle.svg"></a>
  <a href="https://github.com/josmanvis/mercelle/actions"><img alt="CI" src="https://github.com/josmanvis/mercelle/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://www.npmjs.com/package/mercelle"><img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-5FA04E.svg"></a>
</p>

---

# mercelle

**Run your app in a real Linux VM before you ship it to Vercel.**

Vercel runs Linux. Your Mac does not. Everything in between — libc, filesystem
case-sensitivity, CPU architecture, native modules, `VERCEL_ENV` branches — is
where production bugs live, and none of them reproduce on macOS.

mercelle closes that gap. Your app runs inside a real Linux virtual machine,
dependencies are installed *inside* it so native modules are built for Linux, and
your code gets the Vercel environment variables it branches on. The first run
provisions a VM and installs a toolchain — a few minutes, cached from then on.

It catches the class of bugs that only show up *after* you deploy:

| Bug | Why macOS dev misses it |
| --- | --- |
| Linux-only native module | `node_modules` compiled for Darwin; `sharp`, `bcrypt` fail in prod |
| glibc vs musl issues | macOS uses a different libc than Linux |
| Case-sensitivity | `import { Button } from './button'` works on macOS, 500s on Linux |
| Wrong architecture | Apple Silicon `arm64` binary vs an x64 CI runner |
| `VERCEL_ENV` branches | Code paths only taken once deployed |

---

## Backends

mercelle runs the VM with whichever backend is available:

| Backend | Best for | Install |
| --- | --- | --- |
| **OrbStack** (default, preferred) | Any Mac that can run macOS 13+ | `brew install --cask orbstack` |
| **Lima** | Older Intel Macs that cannot run OrbStack | `brew install lima` |

`--backend auto` (the default) uses OrbStack when present and falls back to Lima.
Force one with `--backend orbstack` or `--backend lima`. `mercelle status` shows
which is active.

**If you have an Intel Mac from before ~2018**, OrbStack will not install (it
requires macOS 13+). Use Lima — it runs a real Linux VM via QEMU:

```bash
brew install lima
mercelle dev --backend lima
```

## Why a VM, not a container?

|                      | Container on macOS      | mercelle VM                    |
| -------------------- | ----------------------- | ------------------------------ |
| Kernel               | Shared with the host    | Real Linux kernel              |
| Architecture         | Often emulated          | Whatever the target is         |
| `apt install`, native builds | Sandboxed        | Behaves like production        |
| Cold start           | Fast                    | A few minutes, once            |
| Port forwarding      | Manual                  | Automatic                      |

A container gives you a Linux userland but shares the host kernel, and usually
the filesystem. mercelle boots a **real virtual machine** — OrbStack by default,
Lima on Macs that cannot run it.

You get a real init system, a real filesystem, real permissions and a real
userland, so `apt install` and native builds behave the way they will in
production rather than the way they behave in a container sandbox.

Ports are forwarded to `localhost`, so your app is just `http://localhost:3000`.

## Install

```bash
npm install -g mercelle
```

Requires [OrbStack](https://orbstack.dev/download) installed and running
(the recommended backend), or [Lima](https://lima-vm.io) on older Intel Macs.
`mercelle doctor` tells you exactly what is missing.

## The workflow

**Anything that will run on a real Vercel account should be proven on mercelle
first.** That is the whole idea, and the rest of the tool exists to make it fast.

```bash
# 1. Bring an app up in Linux, the way a deployment would.
cd ~/Developer/axxes/web
mercelle up                     # or: mercelle up ~/Developer/axxes/web

# 2. Watch everything it does, across every app.
mercelle logs

# 3. See how your services are wired before a request ever flies.
mercelle network

# 4. Tear down when you're done.
mercelle down
```

`mercelle up` is not a watcher. It boots the VM, syncs the source, installs
Linux dependencies, starts the app **in the background**, prints the URL, and
returns — so it behaves like a deploy, and a CI step or script can call it.

## Quick start

```bash
mercelle
```

That's it. From anywhere, mercelle opens the **Run App** picker: every runnable
project under `~/Developer`, with the apps you run most often suggested first.
Pick one and it boots inside a Linux VM. Or go direct:

```bash
cd your-next-app
mercelle dev
```

mercelle will:

1. Detect your framework and package manager
2. Create a Linux VM named after your project (e.g. `mercelle-my-app`)
3. Install Node 22, git, and build tools inside it — once
4. Sync your source into the VM
5. Install dependencies **inside the VM**, so native modules are Linux builds
6. Inject the Vercel system environment variables
7. Start your dev server and stream its output

Your app is live at `http://localhost:3000`. On OrbStack it is also reachable at
`http://mercelle-my-app.orb.local:3000`.

### The web dashboard

When you boot a workspace with `mercelle stack`, mercelle opens a small web
dashboard (default `http://localhost:4242`) that shows, live:

- **Boot log** — every step of the spin-up as it happens ("spinning up" →
  "running"),
- **Apps** — every service running in the VM, its framework, URL, PID and
  live status,
- **Local domains** — each app's `app.axxes.local` URL,
- **Databases** — which database each service uses, and which production DSNs
  mercelle deliberately withheld,
- **Suggested apps** — the ones you run most, from your own run history,
- **Network** — how your services are wired, redrawn as apps connect,
- **Live logs** — every app's output in one stream, refreshing live,
- **Issues** — anything that went wrong along the way, with hints.

A "logs" button tails each app's `/tmp/<service>.log` inside the VM. Attach to
a running stack from another terminal with `mercelle ui`.

### Network map

Mercelle reads the URLs out of your source and env files to work out which app
calls which, and which datastore each one talks to. The result is a graph you
can see in the dashboard under **Network**, or on its own:

```bash
mercelle network                    # summary + the connections it found
mercelle network --out map.svg      # write the picture to a file
mercelle network --json             # the raw graph, for scripting
```

Apps are laid out left to right by how deep they sit in the dependency chain,
with databases and third-party hosts on the right. Hover an edge to see the URL
and the file it came from, so a surprising connection can be traced back.

Everything is inferred by reading files — nothing is booted, no VM is touched,
and no network calls are made. Every edge carries the file it was found in, so
you can check it against reality. In particular a connection built at runtime
from a config value mercelle cannot see will not appear; treat the map as a map
of what is written down, not a packet capture.

### Local domains

Each service gets `web.axxes.local`-style domains that resolve to the VM.
To install the mappings system-wide (one sudo prompt):

```bash
mercelle domains            # print the map and current status
mercelle domains --install  # write /etc/hosts + flush DNS
mercelle domains --remove   # clean up later
```

While `mercelle stack` runs, a small host-side proxy also routes
`*.axxes.local` → app ports, so the domains work even before `--install`.

### Mock data for QA

mercelle never clones production data — prod DSNs are refused at the door.
Instead it generates **synthetic data with production shape** from your prisma
schema: same models, believable names/emails/dates, deterministic across runs.

```bash
mercelle data          # writes .mercelle/seed/<service>.sql per service
mercelle data --apply  # also applies inside the VM via prisma db execute
mercelle data --rows 50
```

## Commands

| Command | What it does |
| --- | --- |
| `mercelle` | Run App: pick a project from ~/Developer and run it |
| `mercelle run <path>` | Run a specific project in the VM |
| `mercelle dev` | Run the dev server in the VM (default) |
| `mercelle stack` | Boot every service in a workspace and open the web dashboard |
| `mercelle domains` | Show/install `app.axxes.local` local domains |
| `mercelle data` | Generate synthetic mock data from prisma schemas |
| `mercelle network` | Map how your services are wired, inferred from source |
| `mercelle logs [<name>]` | Tail every running app's output in one stream |
| `mercelle ui` | Open the web dashboard for a stack that is already running |
| `mercelle up [<dir>]` | Bring an app up in the VM and leave it running, deploy-like |
| `mercelle build` | Run your production build inside the VM |
| `mercelle shell` | Open a shell inside the VM — see what your app actually sees |
| `mercelle env` | Print the exact Vercel env vars mercelle injects |
| `mercelle doctor` | Check the setup and explain any problems |
| `mercelle status` | Show VM state and URLs |
| `mercelle down` | Stop the VM (keeps it) |
| `mercelle destroy` | Delete the VM entirely |

## Options

```
--port <n>           Port inside the VM           (default 3000)
--host-port <n>      Port on macOS                (default: same as --port)
--distro <name>      ubuntu, debian, fedora, arch… (default ubuntu)
--cpus <n>           VM CPUs                      (default 4)
--memory <n>         VM memory in GB              (default 8)
--disk <size>        VM disk size                 (default 64GB)
--sync <mode>        copy | mount                 (default copy)
--package-manager    pnpm | yarn | bun | npm
--region <id>        Vercel region                (default iad1)
--forward <list>     Host env vars to forward, comma-separated
--ui-port <n>        Web dashboard port           (default 4242)
--no-ui              Disable the web dashboard
--fresh              Recreate the VM from scratch
--reinstall          Force a fresh dependency install in the VM
--no-watch           Don't restart on file changes
--once               Run the dev server once and exit
--dry-run            Print the commands without running them
```


## Configuration

Create a `mercelle.config.json` in your project root:

```json
{
  "memory": 16,
  "cpus": 8,
  "port": 3000,
  "region": "iad1",
  "sync": "copy",
  "env": {
    "FEATURE_FLAG_X": "on"
  },
  "forwardEnv": ["STRIPE_SECRET_KEY", "DATABASE_URL"]
}
```

You can also nest it under a `mercelle` key in `package.json`. Precedence is
**defaults → config file → CLI flags → environment variables**.

`forwardEnv` is explicit on purpose: mercelle never dumps your entire shell
environment into the VM.

### Sync modes

- **`copy` (default)** — source is tarred into the VM and dependencies are
  installed there. Fully isolated and Linux-correct. Slightly slower on very
  large projects.
- **`mount`** — the VM works directly off `/mnt/mac`. Fastest, no copy, but you
  must not share `node_modules` with macOS.

Either way, `node_modules` in the VM is a **Linux** install. That is the point.

## The Vercel environment

`mercelle env` shows exactly what gets injected. mercelle sets `VERCEL=1`,
`VERCEL_ENV=development`, `VERCEL_REGION`, `VERCEL_URL`, `VERCEL_GIT_*`,
`NEXT_PUBLIC_VERCEL_*`, and your `.env` files, loaded in the same precedence order
Vercel uses (`.env` → `.env.local` → `.env.development` → `.env.development.local`).

Code that branches on `process.env.VERCEL` behaves locally the way it will in
production.

## How it works

```
   macOS                          Linux VM
┌──────────────┐          ┌────────────────────────────┐
│  your code   │  tar/stdin│  ~/mercelle/mercelle-app   │
│  (editor)    │ ────────►│  node_modules (Linux)      │
│              │           │  node 22 · git · build-ess.│
│  mercelle    │ orb/limactl│                            │
│  CLI         │ ─────────►│  next dev  :3000           │
└──────────────┘          └─────────────┬──────────────┘
      ▲                                  │ automatic
      │        localhost:3000  ◄──────────┘  port forwarding
      └───────────────────────────────────────────────
```

mercelle drives the backend through its CLI — `orb` for OrbStack, `limactl` for
Lima — so it works with whatever version you already have, and the whole
integration is testable without a real VM.

## Programmatic use

```ts
import { dev, parseConfig } from 'mercelle'

const result = await dev({ config: parseConfig({ port: 4000 }) })
console.log(result.url) // http://localhost:4000
```

## Development

```bash
npm install
npm run test        # vitest
npm run type-check  # tsc --noEmit
npm run build
```

The test suite drives the real code against **fake `orb` and `limactl`
executables** — actual programs, so argv parsing, exit codes and stdio are
exercised through a real subprocess rather than a mock. CI runs the full suite on
macOS and Linux, and also asserts the published tarball contains a working
binary, type declarations and the agent skill.

## Using mercelle from AI agents

A skill ships inside the package so coding agents verify changes in Linux instead
of guessing from macOS behaviour. One script installs it everywhere:

```bash
./skill/install.sh
```

It writes a `SKILL.md` for agents that read skills (Claude Code, and the shared
`.agents` tree) and a flat `AGENTS.md` for the ones that do not (Cline, Gemini,
Cursor, Agy, Freebuff), appending rather than overwriting so existing rules are
preserved. Agents that are not installed are skipped.

The skill teaches an agent to run `mercelle doctor` → `mercelle up` →
`mercelle build`, to confirm `node -p process.platform` is `linux`, and to
**report honestly** when something was not actually verified. It explicitly
forbids substituting a local `npm run dev` run for real VM verification.

If you add a flag or change a default, re-run `./skill/install.sh` so the skill
does not drift from the CLI.

## Troubleshooting

**`OrbStack was not found`** — install and launch OrbStack once.

**Port already in use** — `mercelle dev --port 4000`, or `--host-port` to map a
different port on the Mac.

**Native module errors** — macOS `node_modules` is probably leaking in. Run
`mercelle dev --reinstall`, or `mercelle destroy` and rebuild.

**Stale VM** — `mercelle dev --fresh` recreates it from scratch.

**Check what your app sees** — `mercelle shell`, then `node -p process.platform`.

## License

MIT
