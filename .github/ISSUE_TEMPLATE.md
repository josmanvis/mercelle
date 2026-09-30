---
name: Bug report
about: Something works on your Mac but not in the VM
title: ''
labels: bug
assignees: ''
---

**What happened**

<!-- What you did, and what went wrong. -->

**What you expected**

**How to reproduce**

```bash
# the exact mercelle command
```

**Environment**

Paste the output of:

```bash
mercelle doctor
mercelle --version
node -v
```

> If mercelle refuses to start a VM, include `mercelle doctor` first — it
> names the missing piece (QEMU, OrbStack, a busy port) directly.
