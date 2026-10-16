// whoami, login and API keys against a stand-in platform: what each command
// sends, and that a key value reaches the terminal only with --reveal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeStudio, jojapi, project } from "./helpers.mjs";

const KEY = "jk_TEST" + "a".repeat(60) + "WXYZ";
const MASK = "jk_••••••••WXYZ";

function introspection(scopes, extra = {}) {
  return {
    status: "success",
    token: {
      id: "n0000test", name: "TEST agent", last4: "TEST", scopes, legacy: false,
      restrictions: { apis: null, projects: [{ id: "proj_test", name: "TEST project", deleted: false }] },
      spend: { limit_usd: 10, spent_this_month_usd: 7.5, remaining_usd: 2.5 },
      created_at: "2026-10-16 10:00:00", expires_at: null, last_used_at: null,
    },
    account: { id: "tst1", username: "test-consumer", name: "TEST Consumer", kind: "human" },
    wallet: { balance_usd: 17.5 },
    ...extra,
  };
}

const KEYS = (reveal) => ({
  status: true,
  api_keys: [
    { id: "n11111111", preview: reveal ? KEY : MASK, masked: !reveal, label: "TEST one", project: { id: "proj_test", name: "TEST project" }, restricted_apis: null, last_used_at: null },
    { id: "n22222222", preview: reveal ? KEY : MASK, masked: !reveal, label: "TEST two", project: { id: "proj_other", name: "Other" }, restricted_apis: [{ slug: "test-api", name: "TEST API" }], last_used_at: "2026-10-15 09:00:00" },
  ],
});

test("whoami prints the account, scopes, restrictions, spend and wallet; --json passes the answer through", async () => {
  const s = await fakeStudio({ "v2/management-token": introspection(["subscriptions:write", "keys:read"]) });
  try {
    const out = await jojapi(s, ["whoami"]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /@test-consumer \(TEST Consumer\)/);
    assert.match(out.stdout, /subscriptions:write, keys:read/);
    assert.match(out.stdout, /projects\s+TEST project/);
    assert.match(out.stdout, /APIs\s+all APIs/);
    assert.match(out.stdout, /\$7\.50 of \$10\.00 this month \(\$2\.50 left\)/);
    assert.match(out.stdout, /wallet\s+\$17\.50/);
    const json = await jojapi(s, ["whoami", "--json"]);
    assert.equal(JSON.parse(json.stdout).account.username, "test-consumer");
  } finally {
    s.close();
  }
});

test("whoami on a platform without introspection says so; a legacy token is told to upgrade", async () => {
  const old = await fakeStudio({ "v2/management-token": { status: "method_not_allowed", message: "Method Not Allowed" } });
  try {
    const out = await jojapi(old, ["whoami"]);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /does not describe tokens yet/);
  } finally {
    old.close();
  }
  const answer = introspection(["listings:read", "code:read", "code:write"]);
  answer.token.legacy = true;
  const legacy = await fakeStudio({ "v2/management-token": answer });
  try {
    const out = await jojapi(legacy, ["whoami"]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /scopes from before v2: upgrade them in the Studio/);
  } finally {
    legacy.close();
  }
});

test("login checks the token with introspection, and with the API list on an older platform", async () => {
  const s = await fakeStudio({ "v2/management-token": introspection(["keys:read"]) });
  try {
    const dir = project();
    const out = await jojapi(s, ["login", "--token", "jm_TEST111111111111111111111", "--base", s.base], { dir });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /@test-consumer, 1 scope\(s\)/);
    assert.deepEqual(s.calls.map((c) => c.route), ["v2/management-token"]);
    const stored = JSON.parse(readFileSync(join(dir, ".config", "jojapi", "config.json"), "utf8"));
    assert.equal(stored.base, s.base);
    assert.equal((statSync(join(dir, ".config", "jojapi", "config.json")).mode & 0o777).toString(8), "600");
  } finally {
    s.close();
  }
  const old = await fakeStudio({
    "v2/management-token": { status: "method_not_allowed", message: "Method Not Allowed" },
    "v2/ProviderApis": { status: "success", apis: [] },
  });
  try {
    const out = await jojapi(old, ["login", "--token", "jm_TEST111111111111111111111", "--base", old.base]);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(old.calls.map((c) => c.route), ["v2/management-token", "v2/ProviderApis"]);
  } finally {
    old.close();
  }
});

test("keys list shows masks unless --reveal, which asks the platform for the values", async () => {
  const s = await fakeStudio({ "v1/api-keys": (body, query) => KEYS(query.reveal === "true") });
  try {
    const masked = await jojapi(s, ["keys"]);
    assert.equal(masked.code, 0, masked.stderr);
    assert.ok(!masked.stdout.includes(KEY));
    assert.ok(masked.stdout.includes(MASK));
    assert.match(masked.stderr, /--reveal prints them/);
    assert.deepEqual(s.calls[0].query, {});
    const filtered = await jojapi(s, ["keys", "list", "--project", "Other"]);
    assert.match(filtered.stdout, /n22222222/);
    assert.doesNotMatch(filtered.stdout, /n11111111/);
    const revealed = await jojapi(s, ["keys", "list", "--reveal"]);
    assert.ok(revealed.stdout.includes(KEY));
    assert.deepEqual(s.calls.at(-1).query, { reveal: "true" });
  } finally {
    s.close();
  }
});

test("keys create keeps the value off the screen; --to-env-file writes it (mode 600) without printing it", async () => {
  const created = (body) => ({
    status: "success", message: "New API Key created successfully.", id: "n33333333",
    project: { id: body?.project ?? "proj_test", name: "TEST project" },
    api_key: body?.reveal ? KEY : MASK, masked: !body?.reveal,
  });
  const s = await fakeStudio({ "v2/management-token": introspection(["keys:read", "keys:write"]), "v2/create-api-key": created });
  try {
    const dir = project();
    const hidden = await jojapi(s, ["keys", "create", "--label", "TEST hidden"], { dir });
    assert.equal(hidden.code, 0, hidden.stderr);
    assert.ok(!hidden.stdout.includes(KEY) && !hidden.stderr.includes(KEY));
    assert.match(hidden.stdout, /value stays hidden/);
    assert.deepEqual(s.posts("v2/create-api-key")[0].body, { label: "TEST hidden" });

    const env = join(dir, ".env");
    const toFile = await jojapi(s, ["keys", "create", "--project", "proj_test", "--to-env-file", ".env"], { dir });
    assert.equal(toFile.code, 0, toFile.stderr);
    assert.ok(!toFile.stdout.includes(KEY) && !toFile.stderr.includes(KEY));
    assert.match(toFile.stdout, /wrote JOJAPI_KEY in \.env \(mode 600\)/);
    assert.equal(readFileSync(env, "utf8"), `JOJAPI_KEY=${KEY}\n`);
    assert.equal((statSync(env).mode & 0o777).toString(8), "600");
    assert.deepEqual(s.posts("v2/create-api-key")[1].body, { project: "proj_test", reveal: true });

    // An existing line is replaced, other lines stay; another name is appended
    writeFileSync(env, "OTHER=1\nexport JOJAPI_KEY=old\n");
    await jojapi(s, ["keys", "create", "--to-env-file", ".env"], { dir });
    await jojapi(s, ["keys", "create", "--to-env-file", ".env", "--env-name", "SERP_KEY"], { dir });
    assert.equal(readFileSync(env, "utf8"), `OTHER=1\nexport JOJAPI_KEY=${KEY}\nSERP_KEY=${KEY}\n`);

    const json = await jojapi(s, ["keys", "create", "--to-env-file", "k.env", "--json"], { dir });
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.id, "n33333333");
    assert.equal(parsed.api_key, undefined);
    assert.ok(existsSync(join(dir, "k.env")));

    const revealed = await jojapi(s, ["keys", "create", "--reveal"], { dir });
    assert.ok(revealed.stdout.includes(KEY));

    const both = await jojapi(s, ["keys", "create", "--reveal", "--to-env-file", ".env"], { dir });
    assert.equal(both.code, 1);
    assert.match(both.stderr, /pick one/);
  } finally {
    s.close();
  }
});

test("keys create --to-env-file without keys:read stops before creating a key", async () => {
  const s = await fakeStudio({ "v2/management-token": introspection(["keys:write"]), "v2/create-api-key": { status: "success", id: "n44444444", api_key: MASK, masked: true } });
  try {
    const out = await jojapi(s, ["keys", "create", "--to-env-file", ".env"]);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /needs a token with the keys:read scope/);
    assert.equal(s.posts("v2/create-api-key").length, 0);
  } finally {
    s.close();
  }
});

test("--env-file is Node's own flag: the CLI points to --to-env-file instead of creating a key", async () => {
  const s = await fakeStudio({ "v2/management-token": introspection(["keys:read", "keys:write"]) });
  try {
    // Node stops before the CLI when the file is missing, so the file exists here
    const dir = project();
    writeFileSync(join(dir, ".env"), "TEST_ONLY=1\n");
    const out = await jojapi(s, ["keys", "create", "--env-file", ".env"], { dir });
    assert.equal(out.code, 1);
    assert.match(out.stderr, /use --to-env-file/);
    assert.equal(s.posts().length, 0);
  } finally {
    s.close();
  }
});

test("keys delete takes an id, asks first, and sends the id, never the key", async () => {
  const s = await fakeStudio({ "v1/api-keys": KEYS(false), "v1/delete-api-key": { status: "success", message: "API key deleted." } });
  try {
    const asked = await jojapi(s, ["keys", "delete", "n11111111"]);
    assert.equal(asked.code, 1);
    assert.match(asked.stderr, /"TEST one" in TEST project, last used never: it stops working at once/);
    assert.equal(s.posts().length, 0);
    const byValue = await jojapi(s, ["keys", "delete", KEY, "--yes"]);
    assert.equal(byValue.code, 1);
    assert.match(byValue.stderr, /never the key itself/);
    const unknown = await jojapi(s, ["keys", "delete", "n99999999", "--yes"]);
    assert.match(unknown.stderr, /no API key n99999999/);
    const deleted = await jojapi(s, ["keys", "delete", "n11111111", "--yes"]);
    assert.equal(deleted.code, 0, deleted.stderr);
    assert.deepEqual(s.posts("v1/delete-api-key")[0].body, { api_key: { id: "n11111111" } });
  } finally {
    s.close();
  }
});

test("a token restricted away from a resource gets the platform's reason", async () => {
  const s = await fakeStudio({ "v1/api-keys": { status: "resource_not_allowed", message: "This management token is limited to some of your projects, and this route covers all of them." } });
  try {
    const out = await jojapi(s, ["keys"]);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /limited to some of your projects/);
  } finally {
    s.close();
  }
});
