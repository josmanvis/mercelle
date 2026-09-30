# How mercelle works

## The shape of it

```
  your Mac                         the VM (Linux)
  ─────────                        ──────────────
  mercelle CLI
    ├── backend            ──────▶  OrbStack / Lima VM
    ├── sync (tar → stdin) ──────▶  ~/mercelle/<project>
    ├── npm install        ──────▶  Linux node_modules
    └── dev server         ──────▶  your app, listening on a port
                                          │
    ◀────── port forward ─────────────────┘
```

Four things happen on every run, in this order:

1. **Ensure the VM.** Created if missing, started if stopped.
2. **Sync the source.** A gzipped tar over stdin, excluding `node_modules` and
   any `.env` files — secrets never enter the VM.
3. **Install dependencies inside the VM.** This is the point. A native module
   compiled for Darwin is useless in production, so mercelle never reuses the
   Mac's `node_modules`.
4. **Run with the Vercel environment injected.** `VERCEL`, `VERCEL_ENV`,
   `VERCEL_URL`, `VERCEL_GIT_*` and friends, so env-gated code paths execute.

## Port forwarding

Each service gets a stable port derived from its name, so URLs do not shuffle
between boots. The backend maps guest ports to host ports; with OrbStack that is
a VM setting, with Lima it is a `portForwards` rule in the instance YAML.

**Limitation:** Lima reads those rules at boot. Changing one while the VM runs
has no effect until it restarts. mercelle detects this and says so.

## Environment and secrets

`.env` files are excluded from the sync. Values that look like production
credentials — anything matching a known production host, including
`*.axxes.club` — are stripped from the injected environment and reported:

```
! Withheld DATABASE_URL: points at production (axxes.club production)
```

`mercelle` never copies a production row or a production DSN into the VM.
`mercelle data` generates synthetic rows from your prisma schema instead.

## The network map

`mercelle network` reads files; it does not run code, open sockets, or touch
the VM. It resolves a URL host three ways — bare service name, local domain, or
loopback plus a known service port — and records the file each edge came from.

**What this means for you:** it is a map of what is written down, not a packet
capture. A URL built at runtime from config mercelle cannot read will not
appear. Every edge carries its source file so you can check it.

## Honest limits

- **macOS only.** Linux and Windows hosts are not supported yet.
- **Not a Vercel VPC.** Apps reach each other by service name and
  `<app>.axxes.local`. There is no per-app DNS zone, no service-discovery
  registry and no shared secret store. If your apps depend on those, they
  still need configuration to work locally.
- **One VM per project** for `dev`/`up`; `stack` shares one VM per workspace.
- **First run is slow** — the toolchain is installed once and then cached.
