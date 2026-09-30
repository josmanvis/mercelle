# mercelle documentation

Start here:

| Page | What it covers |
| --- | --- |
| [getting-started.md](getting-started.md) | Install, first run, the VM lifecycle |
| [commands.md](commands.md) | Every command and flag |
| [troubleshooting.md](troubleshooting.md) | The errors you will actually hit |
| [architecture.md](architecture.md) | How it works, and its honest limits |

## The 60-second version

```bash
npm install -g mercelle
mercelle doctor        # checks backend, QEMU, ports, the VM
cd ~/Developer/your-app
mercelle up            # runs in real Linux, stays up in the background
mercelle logs          # watch every app at once
```

`mercelle doctor` is the first thing to run if anything misbehaves. It is
read-only and safe anywhere.
