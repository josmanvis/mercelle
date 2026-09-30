#!/usr/bin/env node
/**
 * A fake `orb` binary used by the test suite.
 *
 * This is a real executable, so the Orb adapter is exercised through an actual
 * child process (argv parsing, exit codes, stdout/stderr, stdin) rather than a
 * mock. State is kept in a directory pointed to by $FAKE_ORB_STATE.
 *
 * Supported subcommands mirror the real CLI surface mercelle uses:
 *   version                          -> prints a version
 *   list --format json               -> prints {machines:[{name,state}]}
 *   create <distro> <name> [...]     -> creates a machine
 *   start <name> / stop / delete     -> mutates state
 *   run -m <name> bash -lc <script>  -> echoes a recorded line
 *   config set <key> <value>         -> records the setting
 *
 * Behaviour can be steered by files in the state dir:
 *   <machine>.fail        -> `run` for that machine exits 1
 *   <machine>.stdout      -> `run` prints that file's contents
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const stateDir = process.env.FAKE_ORB_STATE
if (!stateDir) {
  console.error('FAKE_ORB_STATE is not set')
  process.exit(64)
}
mkdirSync(stateDir, { recursive: true })

const argv = process.argv.slice(2)
const logFile = join(stateDir, 'calls.log')
const machinesFile = join(stateDir, 'machines.json')
const command = argv[0]

appendFileSync(logFile, JSON.stringify(argv) + '\n')

const readMachines = () => {
  if (!existsSync(machinesFile)) return []
  try {
    return JSON.parse(readFileSync(machinesFile, 'utf8'))
  } catch {
    return []
  }
}
const writeMachines = (m) => writeFileSync(machinesFile, JSON.stringify(m, null, 2))

switch (command) {
  case 'version':
    console.log('orb version 1.0.0-fake')
    process.exit(0)
    break

  case 'list': {
    // `orb list --format json` returns JSON; bare `orb list` returns a table.
    if (argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'json') {
      console.log(JSON.stringify({ machines: readMachines() }, null, 2))
    } else {
      console.log('NAME            DISTRO    STATE')
      for (const m of readMachines()) {
        console.log(`${m.name.padEnd(15)} ${String(m.distro).padEnd(8)} ${m.state}`)
      }
    }
    process.exit(0)
    break
  }

  case 'create': {
    const name = argv[2]
    const distro = argv[1]
    if (readMachines().some((m) => m.name === name)) {
      console.error(`machine ${name} already exists`)
      process.exit(1)
    }
    writeMachines([...readMachines(), { name, distro, state: 'running' }])
    console.log(`Created machine ${name} (${distro})`)
    process.exit(0)
    break
  }

  case 'start':
  case 'stop':
  case 'delete': {
    const name = argv[1]
    const machines = readMachines()
    const machine = machines.find((m) => m.name === name)
    if (!machine) {
      console.error(`no such machine: ${name}`)
      process.exit(1)
    }
    if (command === 'delete') {
      writeMachines(machines.filter((m) => m.name !== name))
    } else {
      machine.state = command === 'start' ? 'running' : 'stopped'
      writeMachines(machines)
    }
    process.exit(0)
    break
  }

  case 'config': {
    // config set <key> <value>
    if (argv[1] === 'set') {
      appendFileSync(join(stateDir, 'config.log'), `${argv[2]}=${argv[3]}\n`)
    }
    process.exit(0)
    break
  }

  case 'run': {
    // run -m <machine> bash -lc <script>
    const machineIdx = argv.indexOf('-m')
    const machine = machineIdx !== -1 ? argv[machineIdx + 1] : 'default'
    const script = argv[argv.length - 1] ?? ''

    // Record stdin so tests can assert an archive was streamed through.
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => {
      if (chunks.length) {
        const buf = Buffer.concat(chunks)
        writeFileSync(join(stateDir, 'stdin.bin'), buf)
        appendFileSync(join(stateDir, 'stdin.log'), `${buf.length}\n`)
      }

      if (existsSync(join(stateDir, `${machine}.fail`))) {
        console.error('fake orb: scripted failure')
        process.exit(1)
      }

      const scripted = join(stateDir, `${machine}.stdout`)
      if (existsSync(scripted)) {
        process.stdout.write(readFileSync(scripted, 'utf8'))
        process.exit(0)
      }

      // Answer the specific probe commands mercelle issues.
      //
      // A probe that produces a real answer must NOT also print the [fake-orb]
      // echo line below: callers like VmManager.getHome() read stdout verbatim,
      // so the extra line was parsed as part of the value and every path built
      // from it came out corrupted. The echo is only useful for commands that
      // have no answer of their own.
      let answered = false
      if (script.includes('echo $HOME')) {
        console.log('/home/tester')
        answered = true
      } else if (script.includes('node -v')) {
        console.log('v22.11.0')
        answered = true
      } else if (script.includes('command -v node')) {
        console.log('/usr/bin/node')
        answered = true
      } else if (script.includes('test -d')) {
        // Report node_modules as present unless told otherwise.
        process.exit(existsSync(join(stateDir, 'no_modules')) ? 1 : 0)
      }

      appendFileSync(join(stateDir, 'run.log'), `${machine}: ${script}\n`)
      if (!answered) console.log(`[fake-orb:${machine}] ${script.split('\n')[0]}`)
      process.exit(0)
    })
    break
  }

  case 'shell':
    process.exit(0)
    break

  default:
    console.error(`fake orb: unsupported command ${command}`)
    process.exit(1)
}
