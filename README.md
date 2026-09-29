# mercelle

**Your Vercel dev server, but in a real Linux VM — running on OrbStack.**

`mercelle` runs your app inside a lightweight Linux virtual machine on your Mac.
Node, native modules, the filesystem, the CPU architecture — all Linux, exactly
like production. But it boots in seconds, forwards ports to `localhost`, and
feeds you the Vercel environment variables your code expects.

It exists to catch the class of bugs that only show up *after* you deploy:

| Bug | Why macOS dev misses it |
| --- | --- |
| Linux-only native module | `node_modules` compiled for Darwin; `sharp`, `bcrypt` fail in prod |
| glibc vs musl issues | macOS uses a different libc than Linux |
| Case-sensitivity | `import { Button } from './button'` works on macOS, 500s on Linux |
| Wrong architecture | Apple Silicon `arm64` binary vs an x64 CI runner |
| `VERCEL_ENV` branches | Code paths only taken once deployed |

---

## Why a VM, not a container?

A container gives you a Linux userland but shares the host kernel, and often the
filesystem. mercelle uses **OrbStack Linux machines** — genuine lightweight VMs.
You get a real init system, a real filesystem, real permissions, and a real
userland, so `apt install` and native builds behave the way they will in prod.

[OrbStack](https://orbstack.dev) is the fastest way to run Linux VMs on macOS and
forwards ports to `localhost` automatically, so your app is just
`http://localhost:3000` on the Mac — no port-forwarding setup.

## Install

```bash
npm install -g mercelle
```

Requires [OrbStack](https://orbstack.dev/download) installed and running.

## Quick start

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

Your app is live at `http://localhost:3000` and
`http://mercelle-my-app.orb.local:3000`.

## Commands

| Command | What it does |
| --- | --- |
| `mercelle dev` | Run the dev server in the VM (default) |
| `mercelle up` | Create the VM and install the toolchain, without running the app |
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
   macOS                     OrbStack Linux machine
┌──────────────┐           ┌────────────────────────────┐
│  your code   │  tar/stdin│  ~/mercelle/mercelle-app   │
│  (editor)    │ ─────────►│  node_modules (Linux)      │
│              │           │  node 22 · git · build-ess.│
│  mercelle    │  orb run  │                            │
│  CLI         │ ─────────►│  next dev  :3000           │
└──────────────┘           └─────────────┬──────────────┘
      ▲                                  │ automatic
      │        localhost:3000  ◄──────────┘  port forwarding
      └───────────────────────────────────────────────
```

mercelle drives OrbStack entirely through its `orb` CLI (`create`, `run`,
`start`, `stop`, `delete`, `config set`), so it works with any OrbStack version
that ships `orb`, and the integration is fully testable.

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

The test suite drives the real code against a **fake `orb` binary** — an actual
executable, so argv parsing, exit codes and stdio are exercised through a real
subprocess rather than a mock.

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
