# Releasing

## One-time setup: npm Trusted Publishing

This is the recommended path. GitHub Actions proves who it is with a short-lived
OIDC token and npm grants a publish permission scoped to *this repository only*.
**There is no long-lived secret stored anywhere.**

1. Sign in to [npmjs.com](https://www.npmjs.com) as `ivalavisca`.
2. Open the package page for `mercelle` — the first publish creates it — then
   go to **Settings → Trusted Publishers**.
3. **Add a new GitHub Actions publisher:**

   | Field | Value |
   | --- | --- |
   | Provider | GitHub Actions |
   | Organization / user | `josmanvis` |
   | Repository | `mercelle` |
   | Workflow filename | `release.yml` |
   | Environment | *(leave empty)* |

4. Enable 2FA Provenance under **Settings → Publishing** if it is not already on.

That is the whole setup. There is no token to create, rotate, or leak.

## Publishing a release

```bash
npm run type-check && npm run test:run && npm run build
npm version patch        # or minor / major
git push --follow-tags
```

The `v*` tag is the **only** thing that can publish, so pushing to `main` alone
cannot ship anything. The workflow refuses to run if the tag and the
`package.json` version disagree, and skips publishing if that version is already
on npm.

## Publishing from your machine instead

If you would rather not use Actions at all, publish locally:

```bash
npm publish --access public
```

npm will prompt for a one-time code from your authenticator. This is
one-off, and the tag still exists for provenance.

## If you prefer a token over Trusted Publishing

A granular access token is workable, but it is a permanent credential — anyone
who obtains it can publish as you. If you go this route:

- npm → **Access Tokens → Generate New Token → Granular**
- Package name: `mercelle`, access **Read and write**
- Expiry: set a date, and put a calendar reminder on it
- Store it as a GitHub secret named `NPM_TOKEN` (Settings → Secrets and
  variables → Actions → New repository secret)
- **Never** paste it into a chat, a commit, or a file in the repo

## Checking a release

```bash
npm view mercelle            # metadata
npm view mercelle versions   # published versions
npm view mercelle time       # when each went out
```
