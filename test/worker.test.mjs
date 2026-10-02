import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeStudio, jojapi } from "./helpers.mjs";

const DEPLOY = { status: "deployed", promoted: false, deployment: { id: "abcd1234", number: 7, url: "https://test-api--abcd1234.example.test" }, preview_url: "https://test-api--preview.example.test" };

const EDGE = {
  mode: "custom",
  files: [],
  variables: [
    { name: "UPSTREAM_URL", kind: "plain", value: "https://upstream.example.test" },
    { name: "UPSTREAM_TOKEN", kind: "secret", value: null },
  ],
  resources: [],
  settings: { logs: false, cpuMs: null, subRequests: null },
};

function studio(extra = {}) {
  return fakeStudio({
    "v2/provider-api-edge": { status: "success", edge: EDGE },
    "v2/update-api-variable": { status: "success", message: "Variable updated", deploy: DEPLOY },
    "v2/delete-api-variable": { status: "success", message: "Variable deleted", deploy: DEPLOY },
    ...extra,
  });
}

test("vars lists names and plain values, never a secret", async () => {
  const s = await studio();
  try {
    const result = await jojapi(s, ["vars"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /UPSTREAM_URL\s+plain\s+https:\/\/upstream\.example\.test/);
    assert.match(result.stdout, /UPSTREAM_TOKEN\s+secret\s+••••••/);
  } finally {
    s.close();
  }
});

test("vars set stores a plain value as a preview, or with --prod in production", async () => {
  const s = await studio();
  try {
    const result = await jojapi(s, ["vars", "set", "region=eu-west", "--prod"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /REGION \(plain\): Variable updated — deployment #7 abcd1234 ready as a preview/);
    assert.deepEqual(s.posts("v2/update-api-variable")[0].body, { slug: "test-api", name: "REGION", kind: "plain", value: "eu-west", production: true });
  } finally {
    s.close();
  }
});

test("a secret comes from stdin, never from the command line", async () => {
  const s = await studio();
  try {
    const refusedOnArgv = await jojapi(s, ["vars", "set", "API_TOKEN=TESTVALUE", "--secret"]);
    assert.equal(refusedOnArgv.code, 1);
    assert.match(refusedOnArgv.stderr, /shell history/);
    assert.equal(s.posts().length, 0);

    const piped = await jojapi(s, ["vars", "set", "API_TOKEN", "--secret"], { input: "TEST-secret-value\n" });
    assert.equal(piped.code, 0, piped.stderr);
    assert.deepEqual(s.posts("v2/update-api-variable")[0].body, { slug: "test-api", name: "API_TOKEN", kind: "secret", value: "TEST-secret-value" });
    assert.doesNotMatch(piped.stdout + piped.stderr, /TEST-secret-value/);
  } finally {
    s.close();
  }
});

test("turning a secret into a plain value and deleting a variable ask first", async () => {
  const s = await studio();
  try {
    const toPlain = await jojapi(s, ["vars", "set", "UPSTREAM_TOKEN=visible"]);
    assert.equal(toPlain.code, 1);
    assert.match(toPlain.stderr, /needs confirmation: pass --yes/);
    const unset = await jojapi(s, ["vars", "unset", "UPSTREAM_URL"]);
    assert.equal(unset.code, 1);
    assert.equal(s.posts().length, 0);
    const confirmedUnset = await jojapi(s, ["vars", "unset", "upstream_url", "--yes"]);
    assert.equal(confirmedUnset.code, 0, confirmedUnset.stderr);
    assert.deepEqual(s.posts("v2/delete-api-variable")[0].body, { slug: "test-api", name: "UPSTREAM_URL" });
  } finally {
    s.close();
  }
});

test("a save whose deployment failed exits non-zero with the platform's message", async () => {
  const s = await studio({ "v2/update-api-variable": { status: "success", message: "Variable updated", deploy: { status: "error", message: "TEST: limit of active deployments reached" } } });
  try {
    const result = await jojapi(s, ["vars", "set", "REGION=eu"]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /deploy failed: TEST: limit of active deployments reached/);
  } finally {
    s.close();
  }
});

test("settings switches console logging; mode template asks before deleting the files", async () => {
  const s = await studio({
    "v2/update-api-edge-settings": { status: "success", message: "Console logging on", settings: { logs: true }, deploy: { status: "deployed", refreshed: ["TEST"] } },
    "v2/update-api-edge-mode": { status: "success", message: "Back to the template", deploy: DEPLOY },
  });
  try {
    const logs = await jojapi(s, ["settings", "--logs", "on"]);
    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(s.posts("v2/update-api-edge-settings")[0].body, { slug: "test-api", logs: true });
    const asked = await jojapi(s, ["mode", "template"]);
    assert.equal(asked.code, 1);
    assert.equal(s.posts("v2/update-api-edge-mode").length, 0);
    const same = await jojapi(s, ["mode", "code"]);
    assert.match(same.stdout, /already in code mode/);
    const done = await jojapi(s, ["mode", "template", "--yes"]);
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(s.posts("v2/update-api-edge-mode")[0].body, { slug: "test-api", mode: "template" });
  } finally {
    s.close();
  }
});

test("resources share and revoke a grant; revoke asks first", async () => {
  const s = await studio({
    "v2/share-api-edge-resource": { status: "success", message: "Resource shared and bound", share: { share: "sh0000test" }, deploy: DEPLOY },
    "v2/revoke-api-edge-share": { status: "success", message: "Access revoked", release: { status: "deployed" } },
  });
  try {
    const shared = await jojapi(s, ["resources", "share", "cache", "test-other-api", "--as", "SHARED_CACHE"]);
    assert.equal(shared.code, 0, shared.stderr);
    assert.deepEqual(s.posts("v2/share-api-edge-resource")[0].body, { slug: "test-api", binding: "CACHE", target_slug: "test-other-api", target_binding: "SHARED_CACHE" });
    assert.match(shared.stdout, /grant sh0000test/);
    const asked = await jojapi(s, ["resources", "revoke", "sh0000test"]);
    assert.equal(asked.code, 1);
    const revoked = await jojapi(s, ["resources", "revoke", "sh0000test", "--yes"]);
    assert.equal(revoked.code, 0, revoked.stderr);
    assert.deepEqual(s.posts("v2/revoke-api-edge-share")[0].body, { share_id: "sh0000test" });
  } finally {
    s.close();
  }
});

test("usage prints the metrics and the estimate as informational", async () => {
  const s = await studio({
    "v2/provider-api-edge-compute": { status: "success", from: "2026-09-02", to: "2026-10-01", metrics: [{ metric: "requests", label: "Requests", unit: "requests", units: 120000, included: 100000, billable_units: 20000, cost_usd: 0.006 }], estimated_cost_usd: 0.006, shared_with: [] },
  });
  try {
    const result = await jojapi(s, ["usage", "--days", "30"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /nothing is charged for compute today/);
    assert.match(result.stdout, /Requests\s+120,000 requests\s+100,000\s+20,000\s+\$0\.01/);
    assert.equal(s.calls.find((c) => c.route === "v2/provider-api-edge-compute").query.days, "30");
  } finally {
    s.close();
  }
});
