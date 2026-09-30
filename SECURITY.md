# Security

## Reporting a vulnerability

Please report security issues privately to the maintainers rather than opening
a public issue. Include a description, steps to reproduce, and the impact you
believe it has. You will get an acknowledgement.

## What mercelle does with your secrets

By design, mercelle keeps production secrets away from the VM:

- `.env` files are excluded from the sync into the VM.
- Values that look like production credentials (known production hosts,
  including `*.axxes.club`) are stripped from the injected environment and
  reported on the console.
- `mercelle data` generates synthetic rows from your prisma schema. It never
  copies production rows or a production DSN.

The web dashboard binds to loopback by default. It is a local developer tool
and is not built to be exposed to a network.
