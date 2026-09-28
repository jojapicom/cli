import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/jojapi.mjs", import.meta.url));

// A stand-in for the Studio's Management API: answers the two calls of a
// deploy and records the files save
function fakeStudio(edge, saveAnswer) {
  const saves = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const path = new URL(req.url, "http://localhost").pathname;
      let answer = { status: "not_found" };
      if (path === "/rest/v2/provider-api-edge") answer = { status: "success", edge };
      if (path === "/rest/v2/update-api-edge-files") {
        saves.push(JSON.parse(body));
        answer = saveAnswer;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, saves, base: `http://127.0.0.1:${server.address().port}` })));
}

function deploy(dir, base, args = []) {
  const env = { PATH: process.env.PATH, HOME: dir, JOJAPI_TOKEN: "jm_TEST000000000000000000000", JOJAPI_BASE: base };
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, "deploy", dir, ...args], { env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), "jojapi-deploy-"));
  writeFileSync(join(dir, "jojapi.json"), JSON.stringify({ slug: "test-api" }));
  writeFileSync(join(dir, "index.mjs"), "export default { fetch: () => new Response('TEST') };\n");
  return dir;
}

test("a deploy to an API in template mode uploads the files and reports the switch to code mode", async () => {
  const studio = await fakeStudio(
    { mode: "generated", files: [] },
    {
      status: "success",
      switched_to_code: true,
      deploy: { status: "deployed", promoted: false, deployment: { id: "abcd1234", number: 3, url: "https://test-api--abcd1234.jojapi.dev" }, preview_url: "https://test-api--preview.jojapi.dev" },
    },
  );
  try {
    const result = await deploy(project(), studio.base, ["--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(studio.saves.length, 1);
    assert.deepEqual(studio.saves[0].files.map((f) => f.path), ["index.mjs"]);
    assert.equal(studio.saves[0].production, false);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, "deployed");
    assert.equal(out.switched_to_code, true);
    assert.equal(out.deployment.id, "abcd1234");
    assert.match(result.stderr, /switched to code mode/);
  } finally {
    studio.server.close();
  }
});

test("a dry run against an API in template mode announces the switch and saves nothing", async () => {
  const studio = await fakeStudio({ mode: "generated", files: [] }, { status: "success" });
  try {
    const result = await deploy(project(), studio.base, ["--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(studio.saves.length, 0);
    assert.match(result.stdout, /would switch to code mode/);
    assert.match(result.stdout, /would upload 1 file\(s\): index\.mjs/);
  } finally {
    studio.server.close();
  }
});
