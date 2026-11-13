# @jojapi/cli

Instructions for coding agents and people working in this repository. This repository is public: everything written
here is published.

## What this is

`jojapi`, the command-line client for providers on jojapi.com: code, deployments, resources, listing, endpoints as
OpenAPI, pricing and analytics, over the Management API v2 with a management token. Plain ES modules on Node 20 or
later, no build step; `src/commands/` holds one module per command group, `src/openapi/` the OpenAPI and Postman
reader, diff and export. User-facing documentation is [README.md](README.md) and the docs site.

## Commands

```bash
npm install
npm test                        # node --test test/*.test.mjs
node bin/jojapi.mjs --help      # run from the checkout
node bin/jojapi.mjs deploy --dry-run   # lists the files a deploy would upload
```

## Releasing

Bump `version` in `package.json`, commit, push a tag `v<version>`. The publish workflow checks the tag against the
version, runs the tests and stages the release on npm with provenance; it goes live only when a maintainer approves it
with two-factor authentication (`npm stage approve`, which needs npm 11 or later). Approving is the owner's step. A new
deploy-action release that pins a CLI version is made only after that version is live on npm.

## Rules

- **No raw API command.** Every command is a purpose-built workflow; there is no `jojapi api <method> <path>`. Raw calls
  use the HTTP Management API directly.
- **Writes are previewed.** Bulk or destructive writes print the exact field-level change first; applying needs an
  explicit flag plus the preview's digest (`--expect`), so what is applied is what was shown.
- **RapidAPI imports stay in the Studio.** Their parser would publish scraping internals in a public package.
- **The answer contract is HTTP 200 with a `status` field**; read `status`, not the HTTP code, and keep the fields a
  command relies on in step with the platform (routes callable by tokens keep their answer fields unchanged).
- **Never print the token.** It lives in `~/.config/jojapi/config.json` (mode 0600) or `JOJAPI_TOKEN`.
- Example-vs-type validation of parameters (`src/openapi/parse-openapi.mjs`) has twins in the platform and the web
  frontend; a change to the rule changes all three.
- Commit messages in English; work on a branch; nothing about customers, prices or people in code, docs or commits.

## Behaviour that is easy to get wrong

- **Upload set.** Besides the bundled `index.mjs`, every file outside `src/` whose path is lowercase, at most four
  levels deep and ends in `.mjs`, `.js`, `.json` or `.txt` is uploaded as it is (`src/files.mjs`), not only `lib/**`:
  stray tools, test helpers and lowercase fixtures go too. Keep them in other extensions (`.mts`, fixture-specific
  ones) and check with `deploy --dry-run`.
- **`endpoints add`** adds an endpoint that is visible on the API page and unbilled until billed; hiding it
  (`endpoints hide`) and billing it (`billing … --endpoint`) are separate commands.
- **`resources add` without `--prod`** lands on a new preview; the production Worker gets the binding only with
  `--prod`. A Durable Object or variable added before the code that uses it makes the preview deploy fail until the
  code arrives.
- `jojapi import` without a source re-imports from the URL the last import came from.
