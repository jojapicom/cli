import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/jojapi.mjs", import.meta.url));

const PREVIEW = { status: "deployed", promoted: false, deployment: { id: "abcd1234", number: 5, url: "https://test-api--abcd1234.jojapi.dev" }, preview_url: "https://test-api--preview.jojapi.dev" };

const EDGE = {
  mode: "custom",
  files: [],
  resources: [
    { kind: "kv", binding: "CACHE", cloudflareId: "TEST0kv0id", className: null, status: "active", error: null },
    { kind: "do", binding: "COUNTER", cloudflareId: null, className: "Counter", status: "active", error: null },
    { kind: "r2", binding: "OLD_FILES", cloudflareId: "test-bucket", className: null, status: "removed", error: "bucket is not empty" },
    {
      kind: "shared", binding: "POOL", cloudflareId: null, className: "TestPool", status: "active", error: null,
      shared: { share: "sh000001", kind: "do", name: "POOL", status: "active", owner: { slug: "test-owner-api", name: "TEST Owner API", account: "TEST Account" }, same_account: true },
    },
  ],
};

const SHARES = {
  status: "success",
  outgoing: [{ binding: "CACHE", kind: "kv", shares: [{ status: "active", target: { slug: "test-other-api" } }] }],
  incoming: [
    { share: "sh000001", status: "active", kind: "do", name: "POOL", class_name: "TestPool", owner: { slug: "test-owner-api", account: "TEST Account" }, bindings: ["POOL"] },
    { share: "sh000002", status: "active", kind: "kv", name: "STORE", class_name: null, owner: { slug: "test-store-api", account: "TEST Account" }, bindings: [] },
    { share: "sh000003", status: "pending", kind: "queue", name: "JOBS", class_name: null, owner: { slug: "test-queue-api", account: "TEST Other" }, bindings: [] },
  ],
};

// A stand-in for the Studio's Management API: answers by route and records
// every POST body
function fakeStudio(answers) {
  const posts = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const route = new URL(req.url, "http://localhost").pathname.replace("/rest/", "");
      if (req.method === "POST") posts.push({ route, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answers[route] ?? { status: "not_found" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, posts, base: `http://127.0.0.1:${server.address().port}` })));
}

function jojapi(dir, base, args) {
  const env = { PATH: process.env.PATH, HOME: dir, JOJAPI_TOKEN: "jm_TEST000000000000000000000", JOJAPI_BASE: base };
  return new Promise((resolve) => {
    // stdin closed: not a terminal, so nothing can be confirmed interactively
    const child = execFile(process.execPath, [BIN, ...args], { cwd: dir, env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.end();
  });
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), "jojapi-resources-"));
  writeFileSync(join(dir, "jojapi.json"), JSON.stringify({ slug: "test-api" }));
  return dir;
}

test("resources lists bindings, removals, shares and the grants other APIs made", async () => {
  const studio = await fakeStudio({ "v2/provider-api-edge": { status: "success", edge: EDGE }, "v2/provider-api-edge-shares": SHARES });
  try {
    const result = await jojapi(project(), studio.base, ["resources"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /CACHE\s+kv\s+shared with test-other-api/);
    assert.match(result.stdout, /COUNTER\s+do\s+class Counter/);
    assert.match(result.stdout, /OLD_FILES\s+r2\s+removed — deleted once no active deployment binds it: bucket is not empty/);
    assert.match(result.stdout, /POOL\s+shared\s+do POOL from test-owner-api \(TEST Account\)/);
    assert.match(result.stdout, /sh000001 .* bound as POOL/);
    assert.match(result.stdout, /sh000002 .* bind it: jojapi resources add shared <BINDING> --share sh000002/);
    assert.match(result.stdout, /sh000003 .* invitation — jojapi resources accept sh000003, or decline/);
  } finally {
    studio.server.close();
  }
});

test("resources add creates a resource as a preview, with the slug given or from jojapi.json", async () => {
  const studio = await fakeStudio({ "v2/update-api-edge-resource": { status: "success", message: "Resource added", deploy: PREVIEW } });
  try {
    const inProject = await jojapi(project(), studio.base, ["resources", "add", "queue", "jobs"]);
    assert.equal(inProject.code, 0, inProject.stderr);
    assert.match(inProject.stdout, /JOBS \(queue\): Resource added — deployment #5 abcd1234 ready as a preview \(promote: jojapi promote abcd1234\)/);

    const named = await jojapi(mkdtempSync(join(tmpdir(), "jojapi-resources-")), studio.base, ["resources", "add", "other-api", "do", "COUNTER", "--class", "Counter", "--prod"]);
    assert.equal(named.code, 0, named.stderr);

    assert.deepEqual(studio.posts, [
      { route: "v2/update-api-edge-resource", body: { slug: "test-api", kind: "queue", binding: "jobs" } },
      { route: "v2/update-api-edge-resource", body: { slug: "other-api", kind: "do", binding: "COUNTER", class_name: "Counter", production: true } },
    ]);
  } finally {
    studio.server.close();
  }
});

test("resources add binds a shared resource by its grant", async () => {
  const studio = await fakeStudio({ "v2/update-api-edge-resource": { status: "success", message: "Shared resource bound", deploy: PREVIEW } });
  try {
    const result = await jojapi(project(), studio.base, ["resources", "add", "shared", "STORE", "--share", "sh000002"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(studio.posts[0].body, { slug: "test-api", kind: "shared", binding: "STORE", share_id: "sh000002" });
  } finally {
    studio.server.close();
  }
});

test("resources add refuses an unknown kind, a class-less Durable Object and a grant-less shared binding without calling the platform", async () => {
  const studio = await fakeStudio({});
  try {
    for (const args of [["add", "bucket", "FILES"], ["add", "do", "COUNTER"], ["add", "shared", "STORE"]]) {
      const result = await jojapi(project(), studio.base, ["resources", ...args]);
      assert.equal(result.code, 1, args.join(" "));
    }
    assert.equal(studio.posts.length, 0);
  } finally {
    studio.server.close();
  }
});

test("resources add reports the platform's refusal", async () => {
  const studio = await fakeStudio({ "v2/update-api-edge-resource": { status: "name_in_use", message: "A variable or resource is already bound under this name" } });
  try {
    const result = await jojapi(project(), studio.base, ["resources", "add", "kv", "CACHE"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already bound under this name/);
  } finally {
    studio.server.close();
  }
});

test("resources remove needs --yes without a terminal and then removes the binding", async () => {
  const studio = await fakeStudio({
    "v2/provider-api-edge": { status: "success", edge: EDGE },
    "v2/delete-api-edge-resource": { status: "success", message: "Resource removed", deploy: { ...PREVIEW, promoted: true } },
  });
  try {
    const refused = await jojapi(project(), studio.base, ["resources", "remove", "cache"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /pass --yes/);
    assert.equal(studio.posts.length, 0);

    const missing = await jojapi(project(), studio.base, ["resources", "remove", "NOPE"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no resource bound as NOPE/);

    const removed = await jojapi(project(), studio.base, ["resources", "remove", "cache", "--prod", "--yes"]);
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, /CACHE: Resource removed — deployment #5 abcd1234 is live in production/);
    assert.deepEqual(studio.posts, [{ route: "v2/delete-api-edge-resource", body: { slug: "test-api", binding: "CACHE", production: true } }]);
  } finally {
    studio.server.close();
  }
});

test("a production save with other pending changes reports their preview too", async () => {
  const studio = await fakeStudio({
    "v2/update-api-edge-resource": { status: "success", message: "Resource added", deploy: { ...PREVIEW, promoted: true, preview: { ...PREVIEW, deployment: { id: "efgh5678", number: 6, url: "https://test-api--efgh5678.jojapi.dev" } } } },
  });
  try {
    const result = await jojapi(project(), studio.base, ["resources", "add", "kv", "SESSIONS", "--prod"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /SESSIONS \(kv\): Resource added — deployment #5 abcd1234 is live in production/);
    assert.match(result.stdout, /other pending changes: deployment #6 efgh5678 ready as a preview/);
  } finally {
    studio.server.close();
  }
});
