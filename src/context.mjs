// What the commands share: which API a command is about (a slug argument or
// jojapi.json), the Management API client, confirmations and terminal output.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { client } from "./api.mjs";
import { PROJECT_FILE, readConfig, readProject } from "./config.mjs";

export function api() {
  return client(readConfig());
}

// `[slug] [dir]`: the slug defaults to the one in jojapi.json of the directory
export function resolveSlugAndDir(positional, flags, needSlug = true) {
  let slug = positional[0];
  let dir = positional[1];
  if (slug && !dir && existsSync(resolve(slug)) && readProject(resolve(slug))) {
    // `jojapi deploy ./dir`
    dir = slug;
    slug = undefined;
  }
  dir = resolve(dir ?? ".");
  const project = readProject(dir);
  slug = slug ?? (typeof flags.slug === "string" ? flags.slug : project?.slug);
  if (needSlug && !slug) throw new Error(`no API slug: pass it or run inside a directory with ${PROJECT_FILE} (jojapi pull <slug>)`);
  return { slug, dir, project };
}

// `[slug] <arg…>` with exactly `count` arguments of the command's own: one
// more in front is the slug, otherwise it comes from jojapi.json
export function slugAndArgs(positional, flags, count, usage) {
  if (positional.length < count || positional.length > count + 1) throw new Error(`usage: jojapi ${usage}`);
  const own = positional.length > count;
  const { slug } = resolveSlugAndDir(own ? positional.slice(0, 1) : [], flags);
  return { slug, args: positional.slice(own ? 1 : 0) };
}

// The answer of a read, or an error carrying the platform's message
export function ok(res) {
  if (res.status !== "success") throw new Error(res.message || res.code || res.status);
  return res;
}

// A refused write: the platform's message (and field errors) on stderr
export function refused(res, flags = {}) {
  if (flags.json) printJson({ status: res.status ?? res.code, message: res.message ?? null, errors: res.errors ?? [] });
  console.error(`${res.message || res.code || res.status}${Array.isArray(res.errors) && res.errors.length ? "\n  " + res.errors.join("\n  ") : ""}`);
  // Listing prechecks: what keeps the API off the marketplace
  for (const check of Array.isArray(res.checks) ? res.checks : []) if (check.status !== "pass") console.error(`  ✗ ${check.check}: ${check.detail ?? check.status}`);
  return 1;
}

export async function loadEdge(client, slug) {
  const res = ok(await client.get("v2/provider-api-edge", { slug }));
  if (!res.edge) throw new Error(`${slug} is not served by the edge gateway yet`);
  return { ...res.edge, files: res.edge.files ?? [], variables: res.edge.variables ?? [], resources: res.edge.resources ?? [], endpoints: res.edge.endpoints ?? [], settings: res.edge.settings ?? {} };
}

// Asks before a write that cannot be taken back. `--yes` answers for scripts,
// which have no terminal to ask on.
export async function confirmed(flags, { action, details, question }) {
  if (flags.yes === true) return true;
  // Without a terminal the refusal still says what would change
  if (details) console.error(details);
  if (!process.stdin.isTTY) throw new Error(`${action} needs confirmation: pass --yes`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const yes = /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    if (!yes) console.error("nothing changed");
    return yes;
  } finally {
    rl.close();
  }
}

// A secret typed at a prompt that does not echo it, or piped on stdin; never
// an argument (it would stay in the shell history)
export async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    return input.replace(/\r?\n$/, "");
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          done();
          resolvePromise(value);
          return;
        }
        if (char === "\u0003") {
          done();
          reject(new Error("cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    const done = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    process.stdin.on("data", onData);
  });
}

// One line of JSON for scripts; returns the exit code 0
export function printJson(value) {
  console.log(JSON.stringify(value));
  return 0;
}

// Rows as aligned columns; the last column is not padded
export function columns(rows, gap = "  ") {
  const cells = rows.map((row) => row.map((cell) => (cell === null || cell === undefined || cell === false ? "" : String(cell))));
  const widths = [];
  for (const row of cells) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return cells.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join(gap).trimEnd()).join("\n");
}

// "2026-10-02 14:05": a timestamp in ms as UTC, a date string as the platform wrote it
export function when(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return new Date(value).toISOString().slice(0, 16).replace("T", " ");
  return String(value).slice(0, 16).replace("T", " ");
}
