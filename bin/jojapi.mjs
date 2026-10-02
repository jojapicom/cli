#!/usr/bin/env node
// jojapi — your APIs on JoJ API from the command line: the Worker code and its
// deployments, bindings and variables; the listing, its OpenAPI document and
// pricing; traffic, request logs and subscribers. `jojapi help` lists the
// commands, `jojapi <command> --help` their arguments.
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
