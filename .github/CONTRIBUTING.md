# Contributing

## Getting set up

```bash
npm install
npm run build      # compile to dist/
npm run test:run   # vitest, single pass
npm run dev        # mercelle itself, via tsx
```

Before opening a pull request:

```bash
npm run type-check && npm run test:run && npm run build
```

## Verifying changes in Linux

This project eats its own dog food: anything that changes the VM path should be
proven on a real VM, not just in unit tests. `mercelle up` in a scratch project
is the quickest way.

## What the tests are for

`__tests__/fixtures/` holds real executables that stand in for `orb` and
`limactl`, so the backends are exercised through actual child processes rather
than mocks. Prefer that to a mocked `spawn`.

Several of the tests here exist because a bug shipped once: the
`fake-orb` fixture, the `bash -n` check on the stack start script, and the
`--rows` parsing test all pin regressions that reached users.

## Adding a command

1. Implement it in `src/`, keeping parsing and side effects separate so it can
   be tested without a VM.
2. Export it from `src/index.ts` — that is the public API.
3. Add it to `src/help.ts`.
4. Add tests.
5. Update `docs/commands.md` and the README table.

## Commits and releases

`main` is protected. Releases are cut by pushing a `v*` tag, which is the only
thing that can publish to npm; CI refuses if the tag and `package.json` version
disagree.
