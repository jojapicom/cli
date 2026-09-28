# @jojapi/cli

Pull, develop and deploy the Worker code of your APIs on JoJ API from the command line or CI.
Your API is a plain Worker; this tool moves its files between your machine and the platform
over the [Management API](https://docs.jojapi.com/studio/management-api), runs it locally under
`wrangler dev` with the gateway's headers added, and manages its
[deployments](https://docs.jojapi.com/studio/deployments).

```bash
npm install -g @jojapi/cli          # or: npx @jojapi/cli …
jojapi login --token jm_…           # Studio → Management API, scopes code:read + code:write
jojapi pull my-api                  # ./my-api: index.mjs, other files, .dev.vars.example, wrangler.jsonc
cd my-api && jojapi dev             # http://127.0.0.1:8788 → wrangler dev with x-jojapi-* headers
jojapi deploy                       # a preview deployment on its own URL
jojapi deploy --prod                # a deployment that goes to production
jojapi deployments                  # newest first: production, previous, latest, commit
jojapi promote k3j9x2ab --note "…"  # serve a deployment in production (public release note)
jojapi rollback                     # back to what production served before
jojapi logs my-api --follow         # console output (logs switched on in Studio)
jojapi errors my-api                # runtime issues
```

## Deployments and git

Every `jojapi deploy` records where the code came from: the commit, branch and repository of the
local git checkout (and whether it had uncommitted changes), or — in GitHub Actions — the commit,
branch and pull request of the run. The commit subject (or pull request title) becomes the
deployment's description unless `--message` is given. `--prod` without file changes deploys the
stored files again as production, unless production already runs them.

`--json` prints the result as one line of JSON for scripts:

```json
{"status":"deployed","promoted":false,"deployment":{"id":"k3j9x2ab","number":14,"url":"https://my-api--k3j9x2ab.jojapi.dev"},"preview_url":"https://my-api--preview.jojapi.dev","uploaded":2,"deleted":0}
```

In GitHub Actions, [`jojapicom/deploy-action`](https://github.com/jojapicom/deploy-action) runs
this for you: a preview per pull request (its URL commented on the pull request), production per
merge. See [Deploy from GitHub](https://docs.jojapi.com/studio/github-actions).

## Bundling

A project with `src/index.ts` (or `src/index.mjs`) or with `dependencies` in `package.json` is
bundled with esbuild into the single `index.mjs` the platform accepts: npm packages are inlined,
`node:*` and `cloudflare:*` stay external (`nodejs_compat`). Files outside `src/` that match the
platform's rules (`lib/**/*.mjs`, `*.json`, `*.txt`) are uploaded as they are.

## Template mode

An API still generated from its Studio template is pulled as the generated Worker. The first
`jojapi deploy` switches it to code mode: the files become a preview deployment (production keeps
the template's deployment until `--prod` or a promote) and the template no longer applies.
**Back to template** in the Studio restores it.

## Configuration

`~/.config/jojapi/config.json` holds the token and base URL (mode 0600). `JOJAPI_TOKEN` and
`JOJAPI_BASE` override it (CI needs only `JOJAPI_TOKEN`). The token is never printed.
`jojapi.json` next to the code names the API; commit it with the code.

## Development

No build step: plain ES modules on Node 20 or later. `npm install` fetches esbuild (used only when
bundling), `npm test` runs the tests.

Releases are published by GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements):
bump `version` in `package.json`, commit, and push a tag `v<version>`. The publish workflow checks
that the tag matches the version, runs the tests and stages the release on npm; it goes live once a
maintainer approves it there with two-factor authentication.

## License

MIT © Apryco, LLC
