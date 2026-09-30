# Commands

Every command, with what it is actually for.

## Running an app

### `mercelle`

With no arguments, inside a project, runs that app in Linux with hot reload.

Outside a project, opens the **Run App** picker: every runnable project under
`~/Developer`, most-used first.

### `mercelle dev`

Run the dev server in the VM in the foreground, restarting on file changes.
This is the one you want while writing code.

### `mercelle up [<dir>]`

Bring an app up in the VM and **leave it running in the background**, the way a
deployment would. Prints the URL, a pid and where the log lives, then returns.

Accepts a directory, so it works from anywhere:

```bash
mercelle up ~/Developer/axxes/web
```

It waits for the process to actually be serving before reporting success, so a
port clash is reported as a failure with the real error, not as a URL.

### `mercelle down` / `mercelle destroy`

Stop the VM, or delete it. `down` keeps the VM and its installed dependencies.

## A whole workspace

### `mercelle stack`

Boot every service in a directory, in one shared VM, and open the dashboard
(`http://localhost:4242`) showing the boot log, running apps, local domains,
databases, the network map, live logs and any issues.

### `mercelle network`

Map how your services talk to each other, without booting anything. Reads URLs
out of source and env files and prints the connections it found, each with the
file it came from.

```bash
mercelle network            # summary
mercelle network --out m.svg  # write the picture
mercelle network --json       # raw graph, for scripting
```

## Watching

### `mercelle logs [<name>]`

Tail every running app's output in one stream, prefixed with its name. With a
name, only that one. Stopped VMs are skipped.

## Inspecting

| Command | Does |
| --- | --- |
| `mercelle doctor` | Check the whole environment. Read-only; safe anywhere. |
| `mercelle status` | What exists right now, and on which URL. |
| `mercelle shell` | A shell inside the VM — see what your app actually sees. |
| `mercelle env` | Print the Vercel system environment mercelle injects. |
| `mercelle build` | Run the production build inside the VM. |

## Data and domains

| Command | Does |
| --- | --- |
| `mercelle data` | Generate synthetic QA data from prisma schemas. Never production rows. |
| `mercelle domains` | Show or install `<app>.axxes.local` local domains. |

## Useful flags

| Flag | Effect |
| --- | --- |
| `--port <n>` | Port inside the VM (default 3000) |
| `--host-port <n>` | Port on macOS (default: same as `--port`) |
| `--backend orbstack\|lima\|auto` | Force a VM backend |
| `--cpus`, `--memory`, `--disk` | VM size, on first creation |
| `--sync copy\|mount` | Copy the source in, or mount it live |
| `--fresh` | Rebuild the VM from scratch |
| `--reinstall` | Force a fresh dependency install inside the VM |
| `--once` | Run once and exit (no watcher) |
| `--forward <list>` | Host env vars to forward, comma-separated |
