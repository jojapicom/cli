// An import source (an OpenAPI document in JSON or YAML, or a Postman
// Collection, from a file or a URL) → the bundle the platform previews and
// applies. The same parse and bundle as the Studio's import wizard.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseOpenApiDocument } from "./parse-openapi.mjs";
import { looksLikePostmanCollection, parsePostmanCollection } from "./parse-postman.mjs";

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

export async function readSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { redirect: "follow", headers: { accept: "application/json, application/yaml, text/yaml, */*" } });
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    const content = await res.text();
    if (Buffer.byteLength(content) > MAX_SOURCE_BYTES) throw new Error(`${source} is larger than 5 MB`);
    return { content, url: res.url || source };
  }
  const content = readFileSync(source, "utf8");
  if (Buffer.byteLength(content) > MAX_SOURCE_BYTES) throw new Error(`${source} is larger than 5 MB`);
  return { content, url: null };
}

// → { bundle, kind: openapi|postman, warnings: [{context, message}] }
export async function buildBundle({ content, url }) {
  let document;
  try {
    document = JSON.parse(content);
  } catch {
    const { load } = await import("js-yaml");
    try {
      document = load(content);
    } catch {
      throw new Error("the source is not valid JSON or YAML");
    }
  }

  const postman = looksLikePostmanCollection(document);
  const parsed = postman ? parsePostmanCollection(document) : parseOpenApiDocument(document);
  if (!parsed.endpoints.length) throw new Error(postman ? "no importable requests in the Collection" : "no endpoints in the OpenAPI document");

  const kind = postman ? "postman" : "openapi";
  const bundle = {
    source: { type: `${kind}_${url ? "url" : "file"}`, url, hash: createHash("sha256").update(content).digest("hex") },
    meta: parsed.meta,
    plans: [],
    feature_definitions: [],
    endpoints: parsed.endpoints.map(bundleEndpoint),
  };
  return { bundle, kind, warnings: parsed.warnings ?? [] };
}

function bundleParams(list) {
  return (list || []).map((p) => ({
    key: p.key,
    name: p.name || "",
    description: p.description || "",
    example: p.example || "",
    value_type: p.value_type || "string",
    required: p.required === true,
    enum_values: p.enum_values || null,
    default_value: p.default_value || "",
  }));
}

// A path parameter exists because the path names it; one without any
// documentation is the same as none
export function documented(p) {
  return Boolean(p.name || p.description || p.example || p.default_value || (p.value_type && p.value_type !== "string") || p.enum_values?.length);
}

function bundleEndpoint(e) {
  return {
    method: e.method,
    url_path: e.url_path,
    name: e.name,
    description: e.description || "",
    group: e.group || null,
    url_parameters: bundleParams(e.parameters),
    header_parameters: bundleParams(e.headerParameters),
    path_parameters: bundleParams(e.pathParameters).filter(documented),
    body: !e.requestBody
      ? null
      : e.requestBody.contentType === "application/json"
        ? { content_type: "application/json", json_body: JSON.stringify(e.requestBody.body), json_schema: e.requestBody.schema ? JSON.stringify(e.requestBody.schema) : null }
        : { content_type: "application/x-www-form-urlencoded", parameters: bundleParams(e.requestBody.parameters) },
    responses: (e.responses || []).map((r) => ({ status: r.status, description: r.description || "", schema: r.schema || null, examples: r.examples || [] })),
  };
}
