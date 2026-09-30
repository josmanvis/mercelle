# Troubleshooting

Run `mercelle doctor` first. It is read-only and names the actual problem.

## `the QEMU binary is not on your PATH`

You are on the Lima backend (OrbStack not installed) and QEMU is missing.

```bash
brew install qemu
```

`doctor` reports this as fatal, because without QEMU no VM can start at all.

## `Port 3000 is already taken`

Something else on macOS is using the port — mercelle does not kill it for you.
Move mercelle's port:

```bash
mercelle up --port 3010 --host-port 3010
```

Inside the VM, the same clash is reported with the app's real error, not a
dead URL.

## `This is mercelle's own source tree`

`mercelle dev` inside the mercelle repo would start mercelle inside a VM,
which cannot work. Run mercelle itself directly:

```bash
npm run dev
```

## `This is mercelle's own source tree` / already inside a VM

Nesting is refused on purpose. From the Mac: `mercelle down`, then re-run.

## A `--host-port` change seems to do nothing

Lima applies port-forward rules when the VM boots. If it is already running,
restart it:

```bash
mercelle down && mercelle up
```

mercelle warns when this applies rather than leaving you with a dead port.

## `node: command not found` inside the VM

The toolchain is not installed, or nvm is not loaded. mercelle sources nvm
explicitly for every command it runs. If you hit this by hand, use
`mercelle shell` and check `$HOME/.nvm/nvm.sh` exists.

## `npm ci` fails with a native module error inside the VM

That is mercelle working: the module was compiled for Darwin. Run
`mercelle dev --reinstall` so dependencies are rebuilt for Linux. If it fails
again, the package has no Linux build for your architecture.

## The VM is slow to start

The first run installs a whole toolchain. It is cached. If several mercelle
VMs are running at once they compete for CPU and memory — stop the ones you are
not using with `mercelle down`.

## The network map is missing a connection

It is built from what is written down in the code. A URL assembled at runtime
from a config value mercelle cannot read will not appear. It is not a packet
capture.
