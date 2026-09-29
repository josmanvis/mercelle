import { c } from './logger.js'

export const VERSION = '0.1.0'

/** The `mercelle --help` output. */
export const HELP = `${c.bold('mercelle')} — a Vercel-like dev environment inside an OrbStack Linux VM

${c.bold('Usage')}
  mercelle <command> [options]

${c.bold('Commands')}
  dev              Run the dev server inside the VM (default)
  up               Create the VM and install the toolchain
  build            Run the production build inside the VM
  shell            Open a shell in the VM
  env              Print the Vercel system env mercelle injects
  doctor           Check the setup and report problems
  status           Show VM state and URLs
  down             Stop the VM
  destroy          Delete the VM
  help             Show this help

${c.bold('Options')}
  --port <n>           Port inside the VM           (default 3000)
  --host-port <n>      Port on macOS                (default: same as --port)
  --distro <name>      VM distro                    (default ubuntu)
  --cpus <n>           VM CPUs                      (default 4)
  --memory <n>         VM memory in GB              (default 8)
  --disk <size>        VM disk size                 (default 64GB)
  --sync <mode>        copy | mount                 (default copy)
  --package-manager    pnpm | yarn | bun | npm
  --region <id>        Vercel region                (default iad1)
  --forward <list>     Comma-separated host env vars to forward
  --orb-bin <path>     Path to the orb binary
  --backend <name>      orbstack | lima | auto            (default auto)
  --lima-bin <path>     Path to the limactl binary
  --fresh              Recreate the VM
  --reinstall          Reinstall deps in the VM
  --no-watch           Disable watching
  --once               Run the dev server once and exit
  --dry-run            Print commands without running them
  -v, --verbose        Verbose output
  -h, --help           Show help
  --version            Print version

${c.bold('Examples')}
  mercelle dev
  mercelle dev --port 4000 --memory 16
  mercelle doctor
  mercelle shell
`
