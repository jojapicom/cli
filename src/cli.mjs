// Command dispatch. Every module under commands/ exports its group's title
// and its commands, each with usage lines, a one-line summary, optional help
// text and the function that runs it.

import { readFileSync } from "node:fs";
import { parseArgs } from "./args.mjs";
import code from "./commands/code.mjs";
import deployments from "./commands/deployments.mjs";
import worker from "./commands/worker.mjs";
import analytics from "./commands/analytics.mjs";
import listing from "./commands/listing.mjs";
import pricing from "./commands/pricing.mjs";
import openapi from "./commands/openapi.mjs";

const GROUPS = [code, deployments, worker, listing, openapi, pricing, analytics];
const COMMANDS = new Map(GROUPS.flatMap((group) => Object.entries(group.commands)));

export async function run(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    const topic = command === "help" ? rest[0] : undefined;
    console.log(topic && COMMANDS.has(topic) ? commandHelp(topic) : overview());
    return 0;
  }
  if (command === "--version" || command === "-v") {
    console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    return 0;
  }
  const entry = COMMANDS.get(command);
  if (!entry) {
    console.error(`unknown command "${command}"\n\n${overview()}`);
    return 2;
  }
  const { positional, flags } = parseArgs(rest);
  if (flags.help) {
    console.log(commandHelp(command));
    return 0;
  }
  return entry.run(positional, flags);
}

function overview() {
  const width = Math.max(...[...COMMANDS.keys()].map((name) => name.length)) + 2;
  const sections = GROUPS.map((group) => `${group.title}\n${Object.entries(group.commands).map(([name, c]) => `  ${name.padEnd(width)}${c.summary}`).join("\n")}`);
  return [
    "jojapi <command> [arguments] [--help]",
    ...sections,
    "A [slug] defaults to the API named in jojapi.json of the current directory.\nEnvironment: JOJAPI_TOKEN and JOJAPI_BASE override ~/.config/jojapi/config.json.\n`jojapi <command> --help` shows a command's arguments.",
  ].join("\n\n");
}

function commandHelp(name) {
  const c = COMMANDS.get(name);
  const usage = c.usage.map((line) => `  jojapi ${line}`).join("\n");
  return [`usage:\n${usage}`, `${c.summary}.`, ...(c.help ? [wrap(c.help)] : [])].join("\n\n");
}

function wrap(text, width = 100) {
  return text.split("\n").map((paragraph) => {
    const lines = [];
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line && line.length + word.length + 1 > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    return [...lines, line].join("\n");
  }).join("\n");
}
