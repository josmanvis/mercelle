# Getting started

## Requirements

- macOS (Linux and Windows hosts are not supported yet)
- Node 20 or newer on the host
- A VM backend:
  - **OrbStack** — recommended, and what mercelle prefers.
    `brew install --cask orbstack`, then launch it once.
  - **Lima** — the fallback for older Intel Macs.
    `brew install lima`, plus QEMU: `brew install qemu`.

`mercelle doctor` checks all of this and tells you precisely what is missing.

## The VM lifecycle

Each project gets its own VM, named after the package
(`mercelle-my-app`). The first run creates it and installs a Linux toolchain
(Node 22, git, build tools). That takes a few minutes and is cached; every run
after that reuses the VM.

```bash
mercelle status     # does the VM exist, and is it running?
mercelle up         # create it if needed, then run the app
mercelle down       # stop it (the VM and its Linux node_modules survive)
mercelle destroy    # delete it entirely
```

`down` is cheap and reversible. `destroy` deletes the VM and everything
installed inside it, so the next `up` is a full first run again.

## Two ways to run

| Command | Behaves like | Use for |
| --- | --- | --- |
| `mercelle dev` | a foreground watcher with hot reload | writing code |
| `mercelle up` | a deployment | proving it works, scripting, CI |

## Monorepos and workspaces

Point mercelle at a directory that contains several services:

```bash
cd ~/Developer/axxes
mercelle stack
```

Every service with a `dev` script is started in one shared VM, each on a stable
port, each with its own `<service>.axxes.local` domain, and the dashboard at
`:4242` shows them all live.
