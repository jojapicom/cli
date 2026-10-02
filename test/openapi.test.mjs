import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump } from "js-yaml";
import { buildBundle } from "../src/openapi/bundle.mjs";
import { currentRecord, endpointDiff, incomingRecord } from "../src/openapi/diff.mjs";
import { buildSpec } from "../src/openapi/export.mjs";
import { fakeStudio, jojapi, project } from "./helpers.mjs";

const ASPECTS = ["info", "parameters", "path_parameters", "body", "responses"];
const param = (key, fields = {}) => ({ key, name: "", description: "", example: "", value_type: "string", required: false, enum_values: null, default_value: "", ...fields });

// An API page payload as the owner receives it (TEST data), including the
// auth header row the page adds with the viewer's own key
function testPage() {
  const current = {
    method: "GET", url_path: "/current", name: "Current weather", description: "Weather now", hidden: false, blocked: false, agent_price: 0.05, order: 0,
    root_url: "https://test-weather.example.test",
    parameters: {
      url: [
        param("city", { name: "City", description: "City name", example: "Istanbul", required: true }),
        param("units", { value_type: "enum", enum_values: ["metric", "imperial"], example: "metric", default_value: "metric" }),
        param("days", { value_type: "number", example: "3.10", default_value: "1" }),
        param("filter", { value_type: "object", example: '{"a": 1}' }),
        param("tags", { value_type: "array", example: '["x","y"]' }),
        param("flag", { value_type: "boolean", example: "true" }),
        param("loc", { value_type: "geopoint", example: "41.0,29.0" }),
        param("kind", { value_type: "enum" }),
      ],
      header: [
        { key: "X-JoJAPI-Key", is_auth: true, example: ["jk_TESTSECRETKEY0000000000001"], name: "JoJ API Key" },
        param("X-Trace", { description: "Trace id" }),
      ],
      path: [], post: [], body: [],
    },
    responses: [
      { status: "200", description: "", schema: '{"type":"object","properties":{"temp":{"type":"number"}}}', examples: [{ name: "default", summary: "", description: "", example: '{"temp":21.5}' }] },
      { status: "4XX", description: "Client error", schema: null, examples: [] },
    ],
  };
  const forecast = {
    method: "POST", url_path: "/forecast/{city}/{day}", name: "Forecast", description: "", hidden: false, blocked: true, agent_price: null, order: 1,
    parameters: {
      url: [], header: [], post: [],
      path: [param("city", { name: "City", required: true }), param("day", { required: true })],
      body: [{ key: "body", example: '{"hours": 24}', schema: '{"type":"object","properties":{"hours":{"type":"integer"}}}' }],
    },
    responses: [
      { status: "200", description: "OK", schema: null, examples: [{ name: "short", summary: "Short", description: "", example: '{"a":1}' }, { name: "long", summary: "", description: "Long one", example: "[1,2]" }] },
      { status: "default", description: "Error", schema: null, examples: [] },
    ],
  };
  const settings = {
    method: "PUT", url_path: "/settings", name: "Settings", description: "Change settings", hidden: true, blocked: false, agent_price: null, order: 2,
    parameters: { url: [], header: [], path: [], body: [], post: [param("theme", { required: true, example: "dark" }), param("count", { value_type: "integer", example: "5" })] },
    responses: [],
  };
  const raw = {
    method: "POST", url_path: "/raw", name: "Raw", description: "", hidden: false, blocked: false, agent_price: null, order: 3,
    parameters: { url: [], header: [], path: [], post: [], body: [{ key: "body", example: '{"q":"x"}', schema: null }] },
    responses: [{ status: "201", description: "Created", schema: null, examples: [] }],
  };
  return {
    name: "TEST Weather", title: "TEST Weather API", description: "Short TEST description", about: "proxied about",
    endpoint_groups: [
      { id: -1, name: "Ungrouped Endpoints", description: "", order: -1, ungrouped: true, endpoints: [current] },
      { name: "Forecasts", description: "Forecast endpoints", order: 0, endpoints: [forecast, settings, raw] },
    ],
  };
}

const DETAILS = { name: "TEST Weather", description: "Short TEST description", about: "# About\n\nStored TEST about text." };

async function roundTrip(content) {
  const page = testPage();
  const { bundle } = await buildBundle({ content, url: null });
  const listed = page.endpoint_groups.flatMap((g) => g.endpoints);
  assert.equal(bundle.endpoints.length, listed.length);
  for (const endpoint of listed) {
    const incoming = bundle.endpoints.find((b) => b.method === endpoint.method && b.url_path === endpoint.url_path);
    assert.ok(incoming, `${endpoint.method} ${endpoint.url_path} exported`);
    const diff = endpointDiff(currentRecord(endpoint), incomingRecord(incoming), ASPECTS);
    for (const aspect of ASPECTS) assert.deepEqual(diff[aspect], [], `${endpoint.method} ${endpoint.url_path} ${aspect}: ${JSON.stringify(diff[aspect])}`);
  }
  assert.deepEqual({ name: bundle.meta.name, description: bundle.meta.description, about: bundle.meta.about }, DETAILS);
}

test("an export imports back without a single difference (JSON)", async () => {
  const spec = buildSpec(DETAILS, testPage());
  await roundTrip(JSON.stringify(spec));
});

test("an export imports back without a single difference (YAML)", async () => {
  const spec = buildSpec(DETAILS, testPage());
  await roundTrip(dump(spec, { lineWidth: -1, noRefs: true }));
});

test("an export never carries the viewer's API keys and documents the gateway and groups", () => {
  const spec = buildSpec(DETAILS, testPage());
  const text = JSON.stringify(spec);
  assert.doesNotMatch(text, /jk_TEST/);
  assert.deepEqual(spec.servers, [{ url: "https://test-weather.example.test" }]);
  assert.deepEqual(spec.tags, [{ name: "Forecasts", description: "Forecast endpoints" }]);
  assert.equal(spec.paths["/current"].get["x-payment-info"].price.amount, "0.05");
  assert.equal(spec.paths["/current"].get.responses["402"], undefined);
  assert.equal(spec.paths["/current"].get.responses["200"].description, "");
});

test("the diff names every value that changes", async () => {
  const page = testPage();
  const spec = buildSpec(DETAILS, page);
  const op = spec.paths["/current"].get;
  op.summary = "Weather right now";
  op.parameters.find((p) => p.name === "city").schema.example = "Ankara";
  op.parameters = op.parameters.filter((p) => p.name !== "flag");
  op.parameters.push({ name: "lang", in: "query", required: true, schema: { type: "string" } });
  op.responses["200"].content["application/json"].schema.properties.humidity = { type: "number" };
  op.responses["200"].content["application/json"].example = { temp: 22 };
  op.responses["404"] = { description: "Not found" };
  const { bundle } = await buildBundle({ content: JSON.stringify(spec), url: null });
  const incoming = bundle.endpoints.find((b) => b.url_path === "/current");
  const diff = endpointDiff(currentRecord(page.endpoint_groups[0].endpoints[0]), incomingRecord(incoming), ASPECTS);
  assert.deepEqual(diff.info, [{ field: "name", before: "Current weather", after: "Weather right now" }]);
  assert.deepEqual(diff.parameters.map((c) => `${c.op} ${c.location} ${c.key}`).sort(), ["add query lang", "change query city", "remove query flag"]);
  assert.deepEqual(diff.parameters.find((c) => c.key === "city").fields, [{ field: "example", before: "Istanbul", after: "Ankara" }]);
  const ok200 = diff.responses.find((r) => r.status === "200");
  assert.deepEqual(ok200.schema, [{ op: "add", path: "properties.humidity", after: { type: "number" } }]);
  assert.deepEqual(ok200.examples[0].example, [{ op: "change", path: "temp", before: 21.5, after: 22 }]);
  assert.ok(diff.responses.some((r) => r.op === "add" && r.status === "404"));
});

// --- the import command against a stand-in platform ----------------------

const PREVIEW = {
  status: "success",
  preview: {
    counts: { new: 1, changed: 1, unchanged: 0, missing: 1 },
    endpoints: {
      new: [{ method: "GET", url_path: "/new", name: "New" }],
      changed: [{ method: "GET", url_path: "/current", incoming_url_path: "/current", name: "Current weather", aspects: ["info"] }],
      unchanged: [],
      missing: [{ method: "DELETE", url_path: "/old", name: "Old", hidden: false, blocked: false }],
    },
    meta: { name: { current: "TEST Weather", incoming: "TEST Weather v2", changed: true } },
    warnings: [],
  },
};

function documentFile() {
  const dir = mkdtempSync(join(tmpdir(), "jojapi-import-"));
  const file = join(dir, "openapi.json");
  writeFileSync(file, JSON.stringify({
    openapi: "3.1.0",
    info: { title: "TEST Weather v2", version: "1" },
    paths: {
      "/current": { get: { summary: "Weather right now", responses: { 200: { description: "" } } } },
      "/new": { get: { summary: "New", parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }] } },
    },
  }));
  return file;
}

function importStudio(extra = {}) {
  return fakeStudio({
    "v2/import/preview": PREVIEW,
    "v2/api-page": { status: "success", api: testPage(), seo: { canonical: "https://example.test/hub/api/test-api" } },
    "v2/import/upload": { status: "success", snapshot: "TESTsnap", hash: "0".repeat(64) },
    "v2/import/apply": { status: "success", report: { created: [{ method: "GET", url_path: "/new" }], updated: [{ method: "GET", url_path: "/current", aspects: ["info"] }], skipped: [], unchanged: 0, hidden: [], meta_updated: [], warnings: [] } },
    ...extra,
  });
}

test("an import without --apply prints every change and a digest, and changes nothing", async () => {
  const studio = await importStudio();
  try {
    const result = await jojapi(studio, ["import", documentFile()]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\+ GET \/new — New/);
    assert.match(result.stdout, /query q \(string, required\)/);
    assert.match(result.stdout, /~ GET \/current — Current weather/);
    assert.match(result.stdout, /name: "Current weather" → "Weather right now"/);
    assert.match(result.stdout, /\? DELETE \/old — Old/);
    assert.match(result.stdout, /name: "TEST Weather" → "TEST Weather v2"  \(not applied; --metadata name applies it\)/);
    assert.match(result.stdout, /digest [0-9a-f]{12}/);
    assert.equal(studio.posts("v2/import/apply").length, 0);
    assert.equal(studio.posts("v2/import/upload").length, 0);
  } finally {
    studio.close();
  }
});

test("--apply without a terminal needs the reviewed digest, and a different digest is refused", async () => {
  const studio = await importStudio();
  try {
    const file = documentFile();
    const bare = await jojapi(studio, ["import", file, "--apply"]);
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /--expect <digest>/);
    const stale = await jojapi(studio, ["import", file, "--apply", "--expect", "000000000000"]);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /no longer the reviewed ones/);
    assert.equal(studio.posts("v2/import/apply").length, 0);
  } finally {
    studio.close();
  }
});

test("--apply --expect with the reviewed digest applies exactly the previewed options", async () => {
  const studio = await importStudio();
  try {
    const file = documentFile();
    const reviewed = JSON.parse((await jojapi(studio, ["import", file, "--hide-missing", "--json"])).stdout);
    assert.equal(reviewed.status, "preview");
    assert.match(reviewed.apply, /--hide-missing --apply --expect [0-9a-f]{12}$/);
    const applied = await jojapi(studio, ["import", file, "--hide-missing", "--apply", "--expect", reviewed.digest, "--json"]);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).status, "applied");
    const [call] = studio.posts("v2/import/apply");
    assert.equal(call.body.slug, "test-api");
    assert.equal(call.body.hide_missing, true);
    assert.equal(call.body.overwrite_changed, true);
    assert.deepEqual(call.body.update_meta, []);
    assert.equal(call.body.import_plans, false);
    assert.equal(call.body.snapshot, "TESTsnap");
    assert.equal(JSON.parse(call.body.bundle).source.type, "openapi_file");
    // Other options make another preview: the digest no longer matches
    const other = await jojapi(studio, ["import", file, "--apply", "--expect", reviewed.digest]);
    assert.equal(other.code, 1);
  } finally {
    studio.close();
  }
});

test("page prints what consumers see and never the viewer's keys", async () => {
  const page = testPage();
  page.periodic_plans = [
    { type: "periodic", slug: "plan-public", blocked: false, name: "Pro", period: "1 MONTH", currency: "usd", pricing: { price: 9.99 }, objects: [{ name: "Requests", slug: "requests", quota: 10000, tiers: null }], features: [] },
    { type: "periodic", slug: "plan-private", blocked: true, name: "Secret deal", period: "1 MONTH", currency: "usd", pricing: { price: 1 }, objects: [], features: [] },
  ];
  page.user = { nick: "testprovider", name: "TEST Provider", verified: true };
  page.releases = [{ date: "2026-10-01 10:00:00", kind: "promote", note: "TEST release" }];
  const studio = await fakeStudio({ "v2/api-page": { status: "success", api: page, seo: { canonical: "https://example.test/hub/api/test-api" } } });
  try {
    const human = await jojapi(studio, ["page"]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /TEST Weather API by TEST Provider ✓ verified/);
    assert.match(human.stdout, /Pro\s+9\.99 USD\/month\s+10,000 Requests/);
    assert.doesNotMatch(human.stdout, /Secret deal/);
    assert.match(human.stdout, /3 endpoint\(s\) in the docs \(1 hidden\)/);
    const json = await jojapi(studio, ["page", "--json"]);
    assert.doesNotMatch(json.stdout, /jk_TEST/);
    assert.doesNotMatch(human.stdout, /jk_TEST/);
  } finally {
    studio.close();
  }
});

test("export writes YAML that names the next step", async () => {
  const studio = await fakeStudio({
    "v2/provider-api": { status: "success", api: { ...DETAILS, slug: "test-api" } },
    "v2/api-page": { status: "success", api: testPage(), seo: {} },
  });
  try {
    const dir = project();
    const result = await jojapi(studio, ["export", "--output", "openapi.yaml"], { dir });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /4 endpoint\(s\) written to openapi\.yaml; edit it and run: jojapi import test-api openapi\.yaml/);
  } finally {
    studio.close();
  }
});
