# Contributing to mercelle

Thanks for helping make local development match production.

## Setup

```bash
git clone https://github.com/<you>/mercelle
cd mercelle
npm install
```

OrbStack is only needed to run `mercelle` against a real VM. The test suite does
not need it.

## Checks

```bash
npm run type-check   # tsc --noEmit
npm run test         # vitest
npm run build        # tsc -p tsconfig.build.json
```

Please make sure all three pass before opening a pull request.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/orb.ts` | The only module that knows the `orb` CLI exists |
| `src/config.ts` | Config schema and defaults (zod) |
| `src/loadConfig.ts` | Reading config from disk and env |
| `src/args.ts` | argv parsing and flag coercion |
| `src/project.ts` | Framework and package-manager detection |
| `src/env.ts` | dotenv parsing and Vercel system env |
| `src/vm.ts` | VM lifecycle: create, provision, sync, install |
| `src/dev.ts` | The `dev` command orchestration |
| `src/watch.ts` | File watching and debounce |
| `src/doctor.ts` | Environment diagnostics |
| `src/cli.ts` | Command dispatch (thin) |

Two rules keep this maintainable:

1. **Never shell out to `orb` from anywhere but `src/orb.ts`.** Everything goes
   through the `Orb` class so the binary path, dry-run, and logging stay
   consistent and testable.
2. **Keep the CLI thin.** Command logic belongs in a module that exports a
   function taking a config, so it can be tested without spawning a process.

## Testing

Tests run the real code against a **fake `orb` binary**
(`__tests__/fixtures/fake-orb.mjs`) — a real executable, so argv parsing, exit
codes, and stdio are exercised through an actual subprocess.

```ts
const fake = createFakeOrb()
const orb = new Orb({ bin: process.execPath })
// ... assert on fake.calls(), fake.machines(), fake.runScripts()
```

Add a test alongside any behaviour change. For a new `orb` subcommand, extend
the fake and add a case in `__tests__/orb.test.ts`.

## Adding a framework

1. Add the name to the `Framework` union in `src/types.ts`.
2. Add detection in `detectFramework` (`src/project.ts`).
3. Add the dev command in `defaultDevCommand`.
4. Add a test.

## Style

- TypeScript strict mode; no `any`.
- Comments explain *why*, not *what*.
- Keep the dependency list small — mercelle is a dev tool people install globally.
