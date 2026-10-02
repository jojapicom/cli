// Deployments and pending changes, listing edits and pricing against a
// stand-in platform: what each command sends, and that every write that
// cannot be taken back asks first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeStudio, jojapi } from "./helpers.mjs";

const PENDING = {
  changes: [{ type: "variable", name: "REGION", change: "changed" }, { type: "resource", name: "CACHE", change: "added" }],
  production: { id: "prod0001", number: 5 },
  deployment: { id: "prev0002", number: 6, status: "active", error: null, url: "https://test-api--prev0002.example.test", current: true },
};

const DEPLOYMENTS = {
  status: "success", active: 3, included: 3, limit: 50, preview_url: "https://test-api--preview.example.test", pending: PENDING,
  deployments: [
    { id: "prev0002", number: 6, source: "cli", mode: "code", status: "active", latest: true, production: false, previous_production: false, access: "owner", keep: false, created_ts: 1790000000000, message: "TEST preview" },
    { id: "prod0001", number: 5, source: "cli", mode: "code", status: "active", latest: false, production: true, previous_production: false, access: "owner", keep: false, created_ts: 1789990000000, message: "TEST production" },
    { id: "old00003", number: 4, source: "studio", mode: "code", status: "active", latest: false, production: false, previous_production: true, access: "owner", keep: false, created_ts: 1789980000000 },
  ],
};

test("changes lists what production is behind; deploy promotes the reviewed preview after asking", async () => {
  const s = await fakeStudio({
    "v2/provider-api-edge-deployments": DEPLOYMENTS,
    "v2/deploy-api-edge-changes": { status: "success", promoted: true, message: "Deployed to production" },
  });
  try {
    const listed = await jojapi(s, ["changes"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /production \(#5 prod0001\) is 2 change\(s\) behind/);
    assert.match(listed.stdout, /added\s+resource\s+CACHE/);
    const asked = await jojapi(s, ["changes", "deploy"]);
    assert.equal(asked.code, 1);
    assert.equal(s.posts().length, 0);
    const deployed = await jojapi(s, ["changes", "deploy", "--note", "TEST release note", "--yes"]);
    assert.equal(deployed.code, 0, deployed.stderr);
    assert.deepEqual(s.posts("v2/deploy-api-edge-changes")[0].body, { slug: "test-api", deployment: "prev0002", note: "TEST release note" });
  } finally {
    s.close();
  }
});

test("discard names the storage it deletes; archive names the rollback target", async () => {
  const s = await fakeStudio({
    "v2/provider-api-edge-deployments": DEPLOYMENTS,
    "v2/discard-api-edge-changes": { status: "success", message: "Changes discarded", archived: ["prev0002"], kept: [] },
    "v2/update-api-edge-deployment": { status: "success", message: "Deployment updated", deployments: [] },
  });
  try {
    const discard = await jojapi(s, ["changes", "discard"]);
    assert.equal(discard.code, 1);
    assert.match(discard.stderr, /needs confirmation/);
    const archive = await jojapi(s, ["deployments", "archive", "old00003"]);
    assert.equal(archive.code, 1);
    const kept = await jojapi(s, ["deployments", "keep", "prev0002"]);
    assert.equal(kept.code, 0, kept.stderr);
    assert.deepEqual(s.posts("v2/update-api-edge-deployment")[0].body, { slug: "test-api", deployment: "prev0002", keep: true });
    const madePublic = await jojapi(s, ["deployments", "public", "prev0002"]);
    assert.equal(madePublic.code, 0);
    assert.deepEqual(s.posts("v2/update-api-edge-deployment")[1].body, { slug: "test-api", deployment: "prev0002", access: "everyone" });
    assert.equal(s.posts("v2/discard-api-edge-changes").length, 0);
  } finally {
    s.close();
  }
});

// --- listing ---------------------------------------------------------------

const ENDPOINT = {
  method: "GET", url_path: "/users/{id}", name: "Get user", description: "One user", blocked: false, hidden: false,
  consumptions: [{ id: "objTEST1", name: "Requests", slug: "requests", cost: "1", label: "", object_default_used_logic: "1" }, { id: "objTEST2", name: "Tokens", slug: "tokens", cost: "", label: "AI tokens", object_default_used_logic: "{{x}}" }],
  parameters: [], path_parameters: [], responses: [],
};

const PROVIDER_API = {
  slug: "test-api", name: "TEST API", description: "TEST", blocked: false, marketplace_status: "approved", agent_request_enabled: false, agent_price_limits: { min_usd: 0.01, max_usd: 50 },
  endpoints: [{ method: "GET", url_path: "/users/{id}", name: "Get user", agent_price: null }, { method: "GET", url_path: "/users", name: "List users", agent_price: null }],
  endpoint_groups: [
    { name: "Ungrouped Endpoints", ungrouped: true, order: -1, endpoints: [{ method: "GET", url_path: "/users", name: "List users", order: 0 }] },
    { name: "Users", description: "", order: 0, endpoints: [{ method: "GET", url_path: "/users/{id}", name: "Get user", order: 1 }] },
  ],
};

test("hiding an endpoint sends its billing back unchanged", async () => {
  const s = await fakeStudio({
    "v2/provider/api-endpoint": { status: "success", endpoint: ENDPOINT },
    "v2/provider/update-endpoint-details": { status: "success" },
  });
  try {
    const result = await jojapi(s, ["endpoints", "hide", "get", "/users/{id}"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(s.posts("v2/provider/update-endpoint-details")[0].body, {
      slug: "test-api", method: "GET", url_path: "/users/{id}", name: "Get user", description: "One user", blocked: false, hidden: true,
      consumptions: [{ id: "objTEST1", cost: "1", label: "" }, { id: "objTEST2", cost: "", label: "AI tokens" }],
    });
    const disable = await jojapi(s, ["endpoints", "disable", "GET", "/users/{id}"]);
    assert.equal(disable.code, 1);
    assert.match(disable.stderr, /needs confirmation/);
  } finally {
    s.close();
  }
});

test("moving an endpoint puts it last in its new group and resends the whole order", async () => {
  const s = await fakeStudio({
    "v2/move-endpoint-to-group": { status: "success" },
    "v2/provider-api": { status: "success", api: PROVIDER_API },
    "v2/update-endpoint-orders": { status: "success" },
  });
  try {
    const result = await jojapi(s, ["endpoints", "move", "GET", "/users", "Users"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(s.posts("v2/move-endpoint-to-group")[0].body, { slug: "test-api", method: "GET", url_path: "/users", group_name: "Users", ungrouped: false });
    // The stand-in still lists /users as ungrouped; the order names every endpoint once
    assert.equal(s.posts("v2/update-endpoint-orders")[0].body.orders.length, 2);
  } finally {
    s.close();
  }
});

test("leaving the marketplace asks first; details not given are sent as they are", async () => {
  const s = await fakeStudio({
    "v2/provider-api": { status: "success", api: PROVIDER_API },
    "v2/update-api-details": { status: "success", message: "API updated", marketplace_status: "private" },
  });
  try {
    const asked = await jojapi(s, ["update", "--marketplace", "private"]);
    assert.equal(asked.code, 1);
    const renamed = await jojapi(s, ["update", "--name", "TEST API Two"]);
    assert.equal(renamed.code, 0, renamed.stderr);
    assert.deepEqual(s.posts("v2/update-api-details")[0].body, { slug: "test-api", name: "TEST API Two", description: "TEST", logo: "", blocked: false, marketplace_status: "public" });
  } finally {
    s.close();
  }
});

test("a refused listing change prints the failing checks", async () => {
  const s = await fakeStudio({
    "v2/provider-api": { status: "success", api: { ...PROVIDER_API, marketplace_status: "private" } },
    "v2/update-api-details": { status: "precheck_failed", message: "The API is not ready for the marketplace", checks: [{ check: "faqs", status: "fail", detail: "At least 2 FAQs" }, { check: "logo", status: "pass" }] },
  });
  try {
    const result = await jojapi(s, ["update", "--marketplace", "public"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /✗ faqs: At least 2 FAQs/);
    assert.doesNotMatch(result.stderr, /logo/);
  } finally {
    s.close();
  }
});

// --- pricing ---------------------------------------------------------------

const OBJECTS = { status: "success", objects: [{ id: "objTEST1", slug: "requests", name: "Requests", endpoint_count: 2, plan_count: 1, default_used_logic: "1" }, { id: "objTEST2", slug: "tokens", name: "Tokens", endpoint_count: 1, plan_count: 0, default_used_logic: "" }] };

function plansAnswer(extraPlans = []) {
  return () => ({
    status: "success",
    api: {
      features: [{ id: "featTEST1", name: "Priority support" }],
      plans: {
        periodic: [
          { slug: "plantest000000000000basic", type: "periodic", name: "10,000 Requests", display_name: null, period: "1 MONTH", price: { currency: "usd" }, pricing: { price: 9 }, objects: [{ id: "objTEST1", slug: "requests", quota: 10000 }], blocked: false, rate_limit: { enabled: true, max_requests: 10, time_window: "1" }, subscriptions_count: 4, custom_users: [], features: [] },
          ...extraPlans,
        ],
        payasyougo: [],
      },
    },
  });
}

test("plans create sends typed values, warns about objects it leaves out, and names the new plan", async () => {
  let created = false;
  const s = await fakeStudio({
    "v2/studio/api-plans": (body, query) => plansAnswer(created ? [{ slug: "plantest00000000000newone", type: "periodic", name: "Pro", period: "1 YEAR", price: { currency: "usd" }, pricing: { price: 99.5 }, objects: [], blocked: true, rate_limit: {}, subscriptions_count: 0, custom_users: [], features: [] }] : [])(body, query),
    "v2/studio/api-objects": OBJECTS,
    "v2/studio/create-api-plan": () => ((created = true), { status: "success", message: "Plan created" }),
  });
  try {
    const asked = await jojapi(s, ["plans", "create", "--price", "99.50", "--period", "year", "--quota", "requests=100000", "--name", "Pro", "--features", "priority support"]);
    assert.equal(asked.code, 1);
    assert.match(asked.stderr, /Endpoints that bill tokens refuse this plan's subscribers \(402\)/);
    assert.match(asked.stderr, /can never change/);
    const result = await jojapi(s, ["plans", "create", "--price", "99.50", "--period", "year", "--quota", "requests=100000", "--rate", "600/min", "--name", "Pro", "--features", "priority support", "--yes"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(s.posts("v2/studio/create-api-plan")[0].body, {
      api_slug: "test-api",
      plan: { type: "periodic", blocked: true, period: "1 YEAR", currency: "usd", price: { amount: 99.5 }, objects: [{ id: "objTEST1", quota: 100000 }], rate_limit_enabled: true, rate_limit: 600, rate_limit_window: "60", name: "Pro", features: ["featTEST1"] },
    });
    assert.match(result.stdout, /plan plantest00000000000newone created — private/);
  } finally {
    s.close();
  }
});

test("making a plan private resends its rate limit; add-object names the subscribers it emails", async () => {
  const s = await fakeStudio({
    "v2/studio/api-plans": plansAnswer(),
    "v2/studio/api-objects": OBJECTS,
    "v2/update-api-plan": { status: "success" },
  });
  try {
    const hidden = await jojapi(s, ["plans", "private", "plantest000000000000basic", "--yes"]);
    assert.equal(hidden.code, 0, hidden.stderr);
    assert.deepEqual(s.posts("v2/update-api-plan")[0].body, { slug: "plantest000000000000basic", rate_limit: { enabled: true, max_requests: 10, time_window: "1" }, blocked: true });
    const add = await jojapi(s, ["plans", "add-object", "plantest000000000000basic", "tokens", "--quota", "500"]);
    assert.equal(add.code, 1);
    assert.match(add.stderr, /all 4 current subscriber\(s\) at once, cannot be changed or removed later, and every subscriber of this plan is notified by email/);
  } finally {
    s.close();
  }
});

test("grant finds the subscription by its subscriber and never prints its id", async () => {
  const s = await fakeStudio({
    "v2/ProviderSubscriptions": { status: "success", subscriptions: [{ api: { slug: "test-api" }, user: { nick: "testuser" }, plan: { slug: "plantest000000000000basic", type: "periodic", name: "10,000 Requests" }, subscription: { id: 987654, status: "active", current_period: { objects: [{ id: "objTEST1", slug: "requests", name: "Requests", used: 9500, quota: 10000 }] } } }] },
    "v2/studio/grant-quota": { status: "success", message: "Added 1,000 Requests to @testuser's current period." },
  });
  try {
    const result = await jojapi(s, ["grant", "testuser", "requests", "1000", "--note", "TEST note", "--yes"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(s.posts("v2/studio/grant-quota")[0].body, { subscription_id: 987654, object_id: "objTEST1", units: 1000, note: "TEST note" });
    assert.doesNotMatch(result.stdout + result.stderr, /987654/);
  } finally {
    s.close();
  }
});

test("billing sends endpoints in batches of 100 and reports the ones that failed", async () => {
  const endpoints = Array.from({ length: 150 }, (_, i) => ({ method: "GET", url_path: `/e${i}`, name: `E${i}`, agent_price: null }));
  const s = await fakeStudio({
    "v2/studio/api-objects": OBJECTS,
    "v2/provider-api": { status: "success", api: { ...PROVIDER_API, endpoints } },
    "v2/studio/api-plans": plansAnswer(),
    "v2/provider/bulk-update-endpoint-billing": (body) => ({ status: "success", updated: body.endpoints.length - (body.endpoints.some((e) => e.url_path === "/e120") ? 1 : 0), failed: body.endpoints.some((e) => e.url_path === "/e120") ? [{ method: "GET", url_path: "/e120", message: "Endpoint not found" }] : [] }),
  });
  try {
    const asked = await jojapi(s, ["billing", "tokens", "--cost", "2", "--all"]);
    assert.equal(asked.code, 1);
    assert.match(asked.stderr, /Plans without tokens \(plantest000000000000basic\) refuse these endpoints with 402/);
    const result = await jojapi(s, ["billing", "tokens", "--cost", "2", "--all", "--yes"]);
    assert.equal(result.code, 1);
    assert.deepEqual(s.posts("v2/provider/bulk-update-endpoint-billing").map((c) => c.body.endpoints.length), [100, 50]);
    assert.match(result.stdout, /149 endpoint\(s\) bill tokens/);
    assert.match(result.stderr, /✗ GET \/e120: Endpoint not found/);
  } finally {
    s.close();
  }
});

// --- analytics -------------------------------------------------------------

test("request logs never show credentials or cookies, also in --json", async () => {
  const s = await fakeStudio({
    "v2/request-logs-studio": {
      status: "success",
      logs: [{
        date: "2026-10-02 10:00:00", endpoint: { method: "GET", name: "Get user", base_url: "/users/{id}" }, user: { username: "testuser" },
        request: { path: "/users/42", url_query: "", headers: { authorization: "Bearer jk_TESTKEY000000000000abcd", cookie: "session=TEST", "x-other": "token jk_TESTKEY000000000000wxyz", "user-agent": "TEST" } },
        response: { code: 200, headers: {}, body: { ok: true } }, client: { ip: "192.0.2.10", country: "TR" }, latency: 0.123, used_credits: 1, used_objects: null,
      }],
    },
  });
  try {
    const table = await jojapi(s, ["requests"]);
    assert.equal(table.code, 0, table.stderr);
    assert.match(table.stdout, /200\s+GET \/users\/42\s+123\s+1 credits\s+testuser\s+TR/);
    assert.doesNotMatch(table.stdout, /192\.0\.2\.10/);
    for (const args of [["requests", "--details"], ["requests", "--json"]]) {
      const out = (await jojapi(s, args)).stdout;
      assert.doesNotMatch(out, /jk_TESTKEY000000000000abcd|jk_TESTKEY000000000000wxyz|session=TEST/);
      assert.match(out, /jk_…wxyz/);
    }
  } finally {
    s.close();
  }
});

test("subscribers never show raw subscription ids", async () => {
  const s = await fakeStudio({
    "v2/ProviderSubscriptions": { status: "success", subscriptions: [{ api: { slug: "test-api" }, user: { nick: "testuser", kind: "human" }, plan: { slug: "p", type: "periodic", name: "Basic", period: "1 MONTH", pricing: { price: 9 }, price: { currency: "usd" } }, subscription: { id: 987654, status: "active", cancel_next: false, created_at: "2026-09-01 00:00:00", current_period: { end_at: "2026-10-01 00:00:00", objects: [{ slug: "requests", used: 10, quota: 100 }] } }, pending_transfer: { id: 4321, status: "pending", target_plan: { name: "Pro" } } }] },
  });
  try {
    for (const args of [["subscribers"], ["subscribers", "--json"]]) {
      const result = await jojapi(s, args);
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /987654|4321/);
    }
    assert.match((await jojapi(s, ["subscribers"])).stdout, /testuser\s+test-api\s+Basic \(9\.00 USD\/month\)\s+active\s+2026-09-01\s+2026-10-01\s+10\/100 requests\s+→ Pro \(pending\)/);
  } finally {
    s.close();
  }
});
