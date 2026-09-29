---
name: mercelle
description: "Deploy and test apps inside a real Linux VM using mercelle + OrbStack, instead of running `npm run dev` on macOS. Use whenever a change must be verified as it will behave in production Linux: native modules (sharp, bcrypt, better-sqlite3), glibc/musl issues, case-sensitivity bugs, Linux-only paths or permissions, arm64-vs-x64 architecture mismatches, container/CI-only failures, `VERCEL_ENV` or other Vercel env branches, database and cron behaviour, or 'works on my Mac but breaks in prod'. Triggers on: deploy to mercelle, test in the VM, run in Linux, OrbStack, mercelle dev, verify before deploy, prod-like test, 'does this work on Linux', 'native module fails in prod', 'why is this only broken in production'."
user-invocable: true
argument-hint: "[what to verify — e.g. 'the new auth flow' or a path to a project]"
license: MIT
---

# mercelle — verify code in real Linux before it ships

`mercelle` runs the app inside a lightweight **Linux VM**, installs dependencies
*inside* that VM, and injects the Vercel system environment variables. macOS dev
hides whole classes of production bugs; this skill exists to catch them.

**The rule this skill enforces: never declare a change verified on macOS alone.**

## Backends

| Backend | When to use |
| --- | --- |
| **OrbStack** (preferred) | Any Mac that can run macOS 13+ |
| **Lima** | Older Intel Macs where OrbStack cannot be installed |

`mercelle` auto-detects. If a command fails because no backend is installed,
check with `mercelle doctor`, then install one:

```bash
brew install --cask orbstack   # modern Macs
brew install lima              # older Intel Macs
```

Use `--backend orbstack` or `--backend lima` to force a specific one.
`mercelle status` reports the active backend.


## When this fires

Use it when the task involves Linux-sensitive behaviour. It is also the correct
answer to "does this work on Linux?", "why does this only break in prod?", and
"verify this before deploy".

Skip it for pure UI/logic changes with no native, filesystem, or platform
dependency — but say explicitly that you skipped it and why.

## Workflow

Follow in order. Do not skip step 1.

### 1. Confirm the environment

```bash
mercelle doctor
```

`doctor` is read-only and safe to run anywhere. It checks the VM backend,
project detection, VM state, Node inside the VM, and port availability. Fix
anything blocking **before** continuing. If no backend is installed, stop and
tell the user which one to install — do not silently fall back to local macOS
dev.

### 2. Run the app in the VM

```bash
mercelle dev
```

The first run is slow (VM creation + Linux dependency install) and is cached
afterwards. It serves on `http://localhost:3000` and streams the app's output.

Common flags — use them rather than editing config ad hoc:

| Need | Command |
| --- | --- |
| Different port | `mercelle dev --port 4000` |
| Port busy on the Mac | `mercelle dev --port 3000 --host-port 3100` |
| Heavier app | `mercelle dev --memory 16 --cpus 8` |
| Stale VM | `mercelle dev --fresh` |
| Wrong-platform binaries | `mercelle dev --reinstall` |
| Fast iteration on a big repo | `mercelle dev --sync mount` |
| One-shot, then exit (CI) | `mercelle dev --once` |
| Rehearse without side effects | `mercelle dev --dry-run` |

### 3. Verify the actual behaviour

Do not stop at "it started". The whole point is exercising the Linux path.

- **Production build** — `mercelle build`. Catches build-time native and
  platform issues that dev mode hides.
- **Confirm the platform** — `mercelle shell`, then `node -p process.platform`
  (expect `linux`) and `node -p process.arch`.
- **Exercise the changed code path** — read the streamed output for real errors.
  A server that boots is not a server that works.

### 4. Report honestly

State what you verified in the VM and what you did not. If OrbStack was
unavailable, say the change is **unverified on Linux** — never imply a clean
run you did not observe.


## Diagnosing a production-only failure

When a bug appears in prod but not locally, reproduce it first:

```bash
mercelle dev
```

The usual causes, in order of likelihood:

1. **macOS `node_modules` leaked in** — native modules built for Darwin.
   Fix: `mercelle dev --reinstall`.
2. **Case-sensitivity** — `import { Button } from './button'` works on a
   case-insensitive Mac filesystem, 500s on Linux. mercelle catches this.
3. **libc mismatch** (glibc vs musl) — check the deploy target's base image.
4. **Architecture** — Apple Silicon `arm64` vs an `x64` runner. Verify with
   `node -p process.arch`.
5. **Env branch** — code gated on `VERCEL_ENV` or similar behaving differently.
   `mercelle env` prints the exact variables injected.
6. **Path or permission assumptions** — `/Users/...` hardcoded, or a write to a
   read-only path.

## Rules

- **Never substitute local `npm run dev` for mercelle verification.** If you
  cannot use mercelle, say so explicitly rather than implying coverage.
- **Never pass secrets on the command line.** Use `--forward KEY` or the config
  file. mercelle deliberately does not forward the whole host environment.
- **Do not run `destroy` on a VM you did not create** without asking. It deletes
  the VM and its Linux `node_modules`.
- **Do not commit `.mercelle/`** or secrets pulled into the project.
- If mercelle is not installed, `npm install -g mercelle`, then `mercelle doctor`.
  Do not fork or reimplement it.

## Project configuration

Per-project settings live in `mercelle.config.json` (or a `mercelle` key in
`package.json`). Create it when the defaults are wrong for a repo, and commit it
so every agent and teammate gets the same VM:

```json
{
  "memory": 16,
  "port": 3000,
  "sync": "copy",
  "env": { "FEATURE_FLAG_X": "on" },
  "forwardEnv": ["DATABASE_URL"]
}
```

## Command reference

| Command | Purpose |
| --- | --- |
| `mercelle dev` | Run the dev server in the VM (default) |
| `mercelle build` | Run the production build in the VM |
| `mercelle up` | Create the VM and install the toolchain only |
| `mercelle shell` | Shell inside the VM |
| `mercelle env` | Print the injected Vercel env vars |
| `mercelle doctor` | Diagnose the environment |
| `mercelle status` | VM state and URLs |
| `mercelle down` / `destroy` | Stop / delete the VM |

## Output checklist

Before declaring a change done:

- [ ] `mercelle doctor` passes
- [ ] Change exercised in the VM, not just locally
- [ ] `mercelle build` succeeds for anything touching native code or config
- [ ] `node -p process.platform` confirmed `linux` in the VM
- [ ] Environment-dependent code paths exercised
- [ ] Report states what was verified in Linux and what was not
