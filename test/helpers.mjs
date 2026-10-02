// Test helpers: a stand-in for the Studio's Management API and a runner for
// the CLI binary against it.

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/jojapi.mjs", import.meta.url));

// answers: route ("v2/…") → an answer, or (body, query) => answer. Every call
// is recorded with its method, route, query and JSON body.
export function fakeStudio(answers) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      const route = url.pathname.replace("/rest/", "");
      const query = Object.fromEntries(url.searchParams);
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, route, query, body });
      const answer = answers[route];
      const json = typeof answer === "function" ? answer(body, query) : answer ?? { status: "not_found", message: `TEST: no answer for ${route}` };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  const posts = (route) => calls.filter((c) => c.method === "POST" && (!route || c.route === route));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, posts, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

// A project directory with jojapi.json naming the TEST API
export function project(slug = "test-api") {
  const dir = mkdtempSync(join(tmpdir(), "jojapi-test-"));
  writeFileSync(join(dir, "jojapi.json"), JSON.stringify({ slug }));
  return dir;
}

// Runs the CLI without a terminal (stdin is a pipe, closed after `input`)
export function jojapi(studio, args, { dir = project(), input = "" } = {}) {
  const env = { PATH: process.env.PATH, HOME: dir, JOJAPI_TOKEN: "jm_TEST000000000000000000000", JOJAPI_BASE: studio.base };
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { cwd: dir, env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.end(input);
  });
}
