#!/usr/bin/env node
// jojapi — the Worker code of your APIs from the command line.
//
//   jojapi login --token jm_…            store a management token (code:read / code:write)
//   jojapi pull <slug> [dir]             download the API's files (or its generated Worker)
//   jojapi deploy [dir] [--prod]         upload the files (bundling npm dependencies) and deploy
//   jojapi dev [dir]                     run the Worker locally under wrangler with the gateway headers
//   jojapi logs <slug> [--follow]        console output captured while logs are on
//   jojapi errors <slug>                 runtime issues
//   jojapi resources [add|remove]        storage and queues bound to the Worker
//
// Configuration: ~/.config/jojapi/config.json (token, base URL); JOJAPI_TOKEN and
// JOJAPI_BASE override it. The token is never printed.

import { run } from "../src/cli.mjs";

run(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`jojapi: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
