# @jojapi/cli

Your APIs on JoJ API from the command line or CI: the Worker code and its deployments, bindings
and variables; the listing, its OpenAPI document and pricing; traffic, request logs and
subscribers. Everything goes through the [Management API](https://docs.jojapi.com/studio/management-api)
with a scoped token, and every write that cannot be taken back shows what changes and asks first.

```bash
npm install -g @jojapi/cli          # or: npx @jojapi/cli …
jojapi login --token jm_…           # Studio → Management API
jojapi help                         # every command; jojapi <command> --help for its arguments
```

A `[slug]` argument defaults to the API named in `jojapi.json` of the current directory, so inside
a pulled project most commands need no slug.

## Commands

```bash
# Code
jojapi pull my-api                  # ./my-api: index.mjs, other files, .dev.vars.example, wrangler.jsonc
cd my-api && jojapi dev             # http://127.0.0.1:8788 → wrangler dev with x-jojapi-* headers
jojapi deploy                       # a preview deployment on its own URL (--prod: production)
jojapi logs --follow                # console output (jojapi settings --logs on)
jojapi errors                       # runtime issues

# Deployments
jojapi deployments                  # newest first: production, previous, latest, commit
jojapi changes                      # saved changes production does not run yet
jojapi changes deploy --note "…"    # promote the preview that holds them (public release note)
jojapi promote k3j9x2ab             # serve one deployment in production
jojapi rollback                     # back to what production served before
jojapi deployments keep k3j9x2ab    # also: unkeep, public, private, archive, activate

# Worker
jojapi resources add kv CACHE       # storage and queues bound as env.CACHE (also d1, r2, queue, do)
jojapi resources share CACHE other-api --as CACHE
jojapi vars set REGION=eu           # plain variable; jojapi vars set TOKEN --secret reads the value
jojapi settings --logs on           # console logging
jojapi usage                        # compute used, with the included allowance
jojapi mode template                # back to the template (asks first)

# Listing
jojapi info                         # details, marketplace status, endpoint counts
jojapi endpoints                    # by group, with visibility, billing and agent price
jojapi endpoints show GET /users/{id}
jojapi endpoints hide GET /users/{id}
jojapi update --marketplace public  # submit for review; the checks name what is missing
jojapi faqs add --question "…" --answer "…"
jojapi objects add requests --name Requests --formula 1

# Documentation
jojapi page                         # the marketplace page as consumers see it
jojapi export --output openapi.yaml
jojapi import openapi.yaml          # a full preview and a digest; nothing changes yet

# Pricing
jojapi plans                        # price, what each plan includes, visibility, subscribers
jojapi plans create --price 9.99 --quota requests=10000
jojapi billing requests --cost 1 --all
jojapi agents price 0.05 --all      # what AI agents pay per request
jojapi grant alice requests 5000    # free quota for one subscriber's current period

# Analytics
jojapi apis                         # your APIs with 7-day traffic
jojapi traffic --period day         # requests, status classes, latency, billable units
jojapi requests --status 502        # the request log (credentials and cookies redacted)
jojapi subscribers
```

## Token scopes

Create the token under **Studio → Management API** with the scopes of the commands you use. A
command whose scope is missing stops with the scope it needs.

| Scope | Commands |
| --- | --- |
| `code:read`, `code:write` | code, deployments, changes, resources, vars, settings, usage, mode |
| `listings:read`, `listings:write` | info, create, update, endpoints, groups, faqs, objects, features, page, export, import |
| `plans:write` | plans, billing, agents, grant |
| `analytics:read` | dashboard, traffic, requests, transactions, the traffic columns of apis |
| `subscriptions:read` | subscribers, grant |

## Every save is a preview first

Code, variables, bindings and the mode all become a preview deployment that you can test on its
own URL before consumers see it. `--prod` on `deploy`, `resources`, `vars` or `mode` puts only that
change into production at once (for example to rotate a leaked key); `jojapi changes deploy`
promotes everything saved. See [Deployments](https://docs.jojapi.com/studio/deployments).

Removing storage (`resources remove`) asks first: the resource and its data are deleted once no
active deployment binds it, so a rollback still finds it. `changes discard` returns the working copy
to production and deletes storage added since. Secrets are typed at a prompt that does not echo
them, or piped in (`printf %s "$TOKEN" | jojapi vars set TOKEN --secret`); never pass one as an
argument.

## Deployments and git

Every `jojapi deploy` records where the code came from: the commit, branch and repository of the
local git checkout (and whether it had uncommitted changes), or — in GitHub Actions — the commit,
branch and pull request of the run. The commit subject (or pull request title) becomes the
deployment's description unless `--message` is given. `--prod` without file changes deploys the
stored files again as production, unless production already runs them.

In GitHub Actions, [`jojapicom/deploy-action`](https://github.com/jojapicom/deploy-action) runs
this for you: a preview per pull request (its URL commented on the pull request), production per
merge. See [Deploy from GitHub](https://docs.jojapi.com/studio/github-actions).

## Resources

`jojapi resources add <kind> <BINDING>` creates [storage or a queue](https://docs.jojapi.com/studio/custom-code#storage-and-queues)
for the API alone and binds it to its Worker as `env.BINDING`:

| Kind | Creates |
| --- | --- |
| `kv` | a key-value store |
| `d1` | a SQL database |
| `r2` | an object storage bucket |
| `queue` | a queue |
| `do` | a Durable Object class; `--class Counter` names the class your code exports |

A resource can be [shared](https://docs.jojapi.com/studio/shared-resources) with other APIs:
`jojapi resources share CACHE other-api` grants it (one of your own APIs gets it at once, `--as`
binds it there; another account's API gets an invitation it answers with `jojapi resources accept`
or `decline`). `jojapi resources` lists the grants with their ids; `resources add shared <BINDING>
--share <id>` binds one, `resources revoke <id>` takes it back.

`jojapi pull` and `jojapi dev` write the bindings into `wrangler.jsonc` as local resources; a shared
Durable Object class is left out, since it runs in the owner's Worker.

## Endpoints as code: export and import

`jojapi export` writes the API as an OpenAPI 3.2 document (hidden endpoints included) that imports
back without a single change, so it can live in a repository next to the code:

```bash
jojapi export --output openapi.yaml
# edit openapi.yaml
jojapi import openapi.yaml
```

`jojapi import` never changes anything on its own. It prints every change field by field — new
endpoints with their parameters, body and responses; for changed endpoints each value before and
after, with JSON paths inside schemas and examples; endpoints missing from the document; the API's
details — and a digest of exactly that preview:

```
  ~ GET /users/{id} — Get user
      parameters
        ~ query fields
            description: "Fields" → "Fields to return"
        + query expand (enum, required, one of team|org)
      responses
        ~ 200
            schema
              + properties.email: {"type":"string"}
        + 404 "Not found"

digest 4005bae33aac
apply exactly this: jojapi import my-api openapi.yaml --apply --expect 4005bae33aac
```

`--apply --expect <digest>` applies that preview and refuses when anything differs since — the
document, the options or the API. Without a terminal (CI, agents) `--apply` needs `--expect`; in a
terminal it shows the preview and asks. Changed endpoints are overwritten unless `--keep-changed`;
endpoints missing from the document are kept unless `--hide-missing` (hidden from the docs, never
deleted); the API's name, description and about text change only with `--metadata
name,description,about`. Billing, requests on/off and the groups and order of existing endpoints
never change. OpenAPI (JSON or YAML) and Postman Collections are read from a file or a URL;
`jojapi import` without a source re-imports from the URL the last import came from. RapidAPI and
Apify imports run in the Studio.

## Pricing

Plans are private when created (`--public` or `jojapi plans public` opens them). A plan's price,
currency, period and what it includes never change: a new price is a new plan, and subscribers move
to it with a transfer in the Studio. `plans add-object` is permanent and emails every subscriber;
`billing` changes what endpoints charge from the next request; `grant` adds one-off free quota and
is never retried, since running it again adds again. Each of these shows what changes, including
the plans that would refuse an endpoint (402), and asks first.

## Scripts and agents

- `--json` prints one line of JSON on read commands, `deploy`, `import` and the Worker writes
  (`resources`, `vars`, `mode`); progress goes to stderr.
- A write that asks first refuses without a terminal and prints what it would change; `--yes`
  answers the question. `jojapi import --apply` asks for `--expect <digest>` instead.
- Exit code 0 means done (or nothing to do); anything else a refusal, a failure or a usage error,
  with the reason on stderr.
- Request logs never show credentials or cookies (a `jk_` key is shortened to its last four
  characters), also in `--json`; subscriber listings never show internal ids.

`deploy --json`, for example:

```json
{"status":"deployed","promoted":false,"deployment":{"id":"k3j9x2ab","number":14,"url":"https://my-api--k3j9x2ab.jojapi.dev"},"preview_url":"https://my-api--preview.jojapi.dev","uploaded":2,"deleted":0}
```

## Bundling

A project with `src/index.ts` (or `src/index.mjs`) or with `dependencies` in `package.json` is
bundled with esbuild into the single `index.mjs` the platform accepts: npm packages are inlined,
`node:*` and `cloudflare:*` stay external (`nodejs_compat`). Files outside `src/` that match the
platform's rules (`lib/**/*.mjs`, `*.json`, `*.txt`) are uploaded as they are.

## Template mode

An API still generated from its Studio template is pulled as the generated Worker. The first
`jojapi deploy` switches it to code mode: the files become a preview deployment (production keeps
the template's deployment until `--prod` or a promote) and the template no longer applies.
`jojapi mode template` (or **Back to template** in the Studio) restores it.

## Configuration

`~/.config/jojapi/config.json` holds the token and base URL (mode 0600). `JOJAPI_TOKEN` and
`JOJAPI_BASE` override it (CI needs only `JOJAPI_TOKEN`). The token is never printed.
`jojapi.json` next to the code names the API; commit it with the code.

## Development

No build step: plain ES modules on Node 20 or later. `npm install` fetches esbuild (used only when
bundling) and js-yaml (used only for YAML), `npm test` runs the tests.

Releases are published by GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements):
bump `version` in `package.json`, commit, and push a tag `v<version>`. The publish workflow checks
that the tag matches the version, runs the tests and stages the release on npm; it goes live once a
maintainer approves it there with two-factor authentication.

## License

MIT © Apryco, LLC
