import { c } from './logger.js'

export const VERSION = '0.1.0'

/** The `mercelle --help` output. */
export const HELP = `${c.bold('mercelle')} — a Vercel-like dev environment inside an OrbStack Linux VM

${c.bold('Usage')}
  mercelle <command> [options]

${c.bold('Commands')}
  run [path]       Run App: pick a project from ~/Developer and run it in the VM
  dev              Run the dev server inside the VM (default)
  stack            Boot every service in a workspace inside the VM
  ui               Open the web dashboard for a running stack
  domains          Show/install local <app>.axxes.local domains
  data             Generate synthetic mock data for QA from prisma schemas
  network          Show how the services in a workspace are wired together
  up [<dir>]       Bring an app up in the VM and leave it running (deploy-like)
  logs [<name>]    Tail every running app's output in one stream
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
  --ui-port <n>        Web dashboard port                 (default 4242)
  --no-ui              Disable the web dashboard
  --dev-root <dir>     Directory the Run App picker scans  (default ~/Developer)
  --domain-suffix <s>  Local domain suffix                (default axxes.local)
  --install            (domains) write /etc/hosts entries
  --remove             (domains) remove mercelle's /etc/hosts block
  --apply              (data) apply the seed inside the VM via prisma
  --rows <n>           (data) rows per model              (default 10)
  --json               (network) print the graph as JSON
  --out <file>         (network) write the SVG map to a file
  --dry-run            Print commands without running them
  -v, --verbose        Verbose output
  -h, --help           Show help
  --version            Print version

${c.bold('Examples')}
  mercelle                        Run App: pick an app and go
  mercelle run ~/Developer/axxes/web
  mercelle dev
  mercelle up
  mercelle logs
  mercelle network
  mercelle stack
  mercelle domains --install
  mercelle data --apply
  mercelle doctor
`
