# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

First public release.

### Added

- **Run App picker** — bare `mercelle` outside a project opens every runnable
  app under `~/Developer`, most-used first. The catalog walks nested
  workspaces, treats projects as leaves, and survives symlink loops.
- **`mercelle up [<dir>]`** — bring an app up in Linux and leave it running in
  the background, the way a deployment would. Reports a dead start honestly
  instead of printing a URL that never serves.
- **`mercelle logs`** — tail every running app's output in one prefixed stream.
- **`mercelle network`** — map how services are wired, inferred from the
  source, with the file each connection came from. SVG and JSON output.
- **`mercelle stack`** — boot a whole workspace in one VM with a web dashboard:
  boot log, running apps, local domains, databases, a live network map, live
  logs and issues.
- **`mercelle domains`** — `<app>.axxes.local` local routing, with a managed,
  reversible `/etc/hosts` block.
- **`mercelle data`** — synthetic QA data generated from prisma schemas.
  Production DSNs and rows are never copied.
- **Agent skill** for Claude, Cursor, Cline, Gemini, Agy and Freebuff, shipped
  inside the package and installable with `skill/install.sh`.
- CI on macOS and Linux, including a check that the published tarball actually
  contains a working binary, types, and the skill.

### Fixed

Bugs found by using it rather than by writing it:

- `PATH='…:${PATH}'` was single-quoted, freezing the literal text and wiping
  the VM's real `PATH` — the cause of `exec: tsx: not found`.
- Prisma relation fields were emitted as SQL columns, and foreign keys were
  random, so generated seed data could not apply.
- `mercelle stack` gave each service its own machine name, targeting VMs that
  were never created.
- The stack start script joined `nohup … &` with `&&`, which bash rejects
  outright — no service could ever start.
- `stack` required a `package.json` at the workspace root, failing on the
  directory-of-apps layout it exists for.
- Hot reload killed the local client but not the app inside the VM, so every
  restart failed with `EADDRINUSE`.
- `Lima.list()` parsed newline-delimited JSON as an array, so with two or more
  VMs it reported that none existed.
- `Lima.start()` swallowed failures, surfacing a missing QEMU much later as
  `instance is stopped`. QEMU is now a fatal `doctor` check.
- `--rows` parsed as a boolean, so every seed silently got one row.
- The picker advertised never-run apps as suggestions, and numbered its two
  lists independently.
