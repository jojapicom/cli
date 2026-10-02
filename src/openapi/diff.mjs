// What an import changes, field by field. The platform's preview says which
// sections of an endpoint change (info, parameters, path parameters, body,
// responses); this compares the same fields the platform compares — the
// stored documentation from the API page against the incoming bundle — so a
// person or an agent sees every value that moves before anything is applied.

import { documented } from "./bundle.mjs";

const PARAMETER_FIELDS = ["name", "description", "example", "value_type", "required", "enum_values", "default_value"];

function canonicalParameter(p) {
  return {
    key: String(p.key),
    name: String(p.name ?? ""),
    description: String(p.description ?? ""),
    example: String(p.example ?? ""),
    value_type: p.value_type || "string",
    required: p.required === true,
    enum_values: Array.isArray(p.enum_values) ? p.enum_values.map(String) : null,
    default_value: String(p.default_value ?? ""),
  };
}

// Path parameters are always required (the platform stores them so)
function pathParameter(p) {
  return { ...canonicalParameter(p), required: true };
}

function parseJson(text) {
  if (text === null || text === undefined || text === "") return undefined;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// The stored state of an endpoint (an API page entry) in the bundle's terms
export function currentRecord(e) {
  const p = e.parameters ?? {};
  const bodyRow = (p.body ?? [])[0];
  return {
    name: e.name ?? "",
    description: e.description ?? "",
    url_parameters: (p.url ?? []).map(canonicalParameter),
    header_parameters: (p.header ?? []).filter((h) => !h.is_auth).map(canonicalParameter),
    // The page lists every path variable; undocumented ones are no documentation
    path_parameters: (p.path ?? []).filter(documented).map(pathParameter),
    body: bodyRow
      ? { content_type: "application/json", json_body: bodyRow.example ?? "", json_schema: bodyRow.schema ?? null }
      : (p.post ?? []).length
        ? { content_type: "application/x-www-form-urlencoded", parameters: p.post.map(canonicalParameter) }
        : null,
    responses: (e.responses ?? []).map((r) => ({
      status: String(r.status ?? r.status_code),
      description: r.description ?? "",
      schema: r.schema ?? null,
      examples: r.examples ?? [],
    })),
  };
}

export function incomingRecord(b) {
  return {
    name: b.name ?? "",
    description: b.description ?? "",
    url_parameters: (b.url_parameters ?? []).map(canonicalParameter),
    header_parameters: (b.header_parameters ?? []).map(canonicalParameter),
    path_parameters: (b.path_parameters ?? []).map(pathParameter),
    body: b.body
      ? b.body.content_type === "application/json"
        ? { content_type: "application/json", json_body: b.body.json_body ?? "", json_schema: b.body.json_schema ?? null }
        : { content_type: b.body.content_type, parameters: (b.body.parameters ?? []).map(canonicalParameter) }
      : null,
    responses: (b.responses ?? []).map((r) => ({ status: String(r.status), description: r.description ?? "", schema: r.schema ?? null, examples: r.examples ?? [] })),
  };
}

// Value-level differences between two JSON values, with their JSON paths
export function jsonDiff(before, after, path = "") {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObject(before) && isObject(after)) {
    const out = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const child = path ? `${path}.${key}` : key;
      if (!(key in after)) out.push({ op: "remove", path: child, before: before[key] });
      else if (!(key in before)) out.push({ op: "add", path: child, after: after[key] });
      else out.push(...jsonDiff(before[key], after[key], child));
    }
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const out = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const child = `${path}[${i}]`;
      if (i >= after.length) out.push({ op: "remove", path: child, before: before[i] });
      else if (i >= before.length) out.push({ op: "add", path: child, after: after[i] });
      else out.push(...jsonDiff(before[i], after[i], child));
    }
    return out;
  }
  if (before === undefined) return [{ op: "add", path: path || "(value)", after }];
  if (after === undefined) return [{ op: "remove", path: path || "(value)", before }];
  return [{ op: "change", path: path || "(value)", before, after }];
}

function parameterDiff(before, after, location) {
  const out = [];
  const keyed = (list) => new Map(list.map((p) => [p.key, p]));
  const was = keyed(before);
  const now = keyed(after);
  for (const [key, p] of now) {
    if (!was.has(key)) {
      out.push({ op: "add", location, key, after: p });
      continue;
    }
    const fields = PARAMETER_FIELDS.filter((f) => JSON.stringify(was.get(key)[f]) !== JSON.stringify(p[f])).map((f) => ({ field: f, before: was.get(key)[f], after: p[f] }));
    if (fields.length) out.push({ op: "change", location, key, fields });
  }
  for (const [key, p] of was) if (!now.has(key)) out.push({ op: "remove", location, key, before: p });
  return out;
}

function examplesDiff(before, after) {
  const out = [];
  const keyed = (list) => new Map(list.map((x) => [x.name, x]));
  const was = keyed(before);
  const now = keyed(after);
  for (const [name, x] of now) {
    if (!was.has(name)) {
      out.push({ op: "add", name, after: x });
      continue;
    }
    const old = was.get(name);
    const changes = [
      ...(String(old.summary ?? "") !== String(x.summary ?? "") ? [{ field: "summary", before: old.summary ?? "", after: x.summary ?? "" }] : []),
      ...(String(old.description ?? "") !== String(x.description ?? "") ? [{ field: "description", before: old.description ?? "", after: x.description ?? "" }] : []),
    ];
    const body = jsonDiff(parseJson(old.example), parseJson(x.example));
    if (changes.length || body.length) out.push({ op: "change", name, fields: changes, example: body });
  }
  for (const [name, x] of was) if (!now.has(name)) out.push({ op: "remove", name, before: x });
  return out;
}

// The sections the platform reported as changed, each with its value changes
export function endpointDiff(current, incoming, aspects) {
  const diff = {};
  for (const aspect of aspects) {
    if (aspect === "info") {
      diff.info = ["name", "description"].filter((f) => current[f] !== incoming[f]).map((f) => ({ field: f, before: current[f], after: incoming[f] }));
    } else if (aspect === "parameters") {
      diff.parameters = [...parameterDiff(current.url_parameters, incoming.url_parameters, "query"), ...parameterDiff(current.header_parameters, incoming.header_parameters, "header")];
    } else if (aspect === "path_parameters") {
      diff.path_parameters = parameterDiff(current.path_parameters, incoming.path_parameters, "path");
    } else if (aspect === "body") {
      const was = current.body;
      const now = incoming.body;
      const out = [];
      if ((was?.content_type ?? "none") !== (now?.content_type ?? "none")) out.push({ field: "content_type", before: was?.content_type ?? "none", after: now?.content_type ?? "none" });
      if (now?.content_type === "application/json" || was?.content_type === "application/json") {
        const example = jsonDiff(parseJson(was?.json_body), parseJson(now?.json_body));
        const schema = jsonDiff(parseJson(was?.json_schema), parseJson(now?.json_schema));
        if (example.length) out.push({ field: "example", changes: example });
        if (schema.length) out.push({ field: "schema", changes: schema });
      }
      if (now?.content_type === "application/x-www-form-urlencoded" || was?.content_type === "application/x-www-form-urlencoded") {
        const form = parameterDiff(was?.parameters ?? [], now?.parameters ?? [], "form");
        if (form.length) out.push({ field: "form", changes: form });
      }
      diff.body = out;
    } else if (aspect === "responses") {
      const out = [];
      const was = new Map(current.responses.map((r) => [r.status, r]));
      const now = new Map(incoming.responses.map((r) => [r.status, r]));
      for (const [status, r] of now) {
        if (!was.has(status)) {
          out.push({ op: "add", status, after: { description: r.description, schema: Boolean(r.schema), examples: r.examples.map((x) => x.name) } });
          continue;
        }
        const old = was.get(status);
        const change = { op: "change", status, fields: [] };
        if (old.description !== r.description) change.fields.push({ field: "description", before: old.description, after: r.description });
        const schema = jsonDiff(parseJson(old.schema), parseJson(r.schema));
        if (schema.length) change.schema = schema;
        const examples = examplesDiff(old.examples, r.examples);
        if (examples.length) change.examples = examples;
        if (change.fields.length || change.schema || change.examples) out.push(change);
      }
      for (const [status, r] of was) if (!now.has(status)) out.push({ op: "remove", status, before: { description: r.description, examples: r.examples.map((x) => x.name) } });
      diff.responses = out;
    }
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Terminal rendering

function show(value, limit = 120) {
  if (value === undefined) return "(none)";
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length} chars)` : text;
}

function parameterLine(p) {
  return `${p.value_type}${p.required ? ", required" : ""}${p.enum_values?.length ? `, one of ${p.enum_values.join("|")}` : ""}${p.example ? `, e.g. ${show(p.example, 60)}` : ""}${p.description ? ` — ${show(p.description, 80)}` : ""}`;
}

function jsonLines(changes, indent) {
  return changes.map((c) => (c.op === "add" ? `${indent}+ ${c.path}: ${show(c.after)}` : c.op === "remove" ? `${indent}- ${c.path}: ${show(c.before)}` : `${indent}~ ${c.path}: ${show(c.before)} → ${show(c.after)}`));
}

function parameterLines(changes, indent) {
  return changes.flatMap((c) => {
    if (c.op === "add") return [`${indent}+ ${c.location} ${c.key} (${parameterLine(c.after)})`];
    if (c.op === "remove") return [`${indent}- ${c.location} ${c.key}`];
    return [`${indent}~ ${c.location} ${c.key}`, ...c.fields.map((f) => `${indent}    ${f.field}: ${show(f.before)} → ${show(f.after)}`)];
  });
}

export function renderEndpointDiff(diff, indent = "      ") {
  const lines = [];
  if (diff.info?.length) lines.push(`${indent}info`, ...diff.info.map((f) => `${indent}  ${f.field}: ${show(f.before)} → ${show(f.after)}`));
  if (diff.parameters?.length) lines.push(`${indent}parameters`, ...parameterLines(diff.parameters, `${indent}  `));
  if (diff.path_parameters?.length) lines.push(`${indent}path parameter docs`, ...parameterLines(diff.path_parameters, `${indent}  `));
  if (diff.body?.length) {
    lines.push(`${indent}body`);
    for (const f of diff.body) {
      if (f.field === "content_type") lines.push(`${indent}  content type: ${f.before} → ${f.after}`);
      if (f.field === "example") lines.push(`${indent}  example`, ...jsonLines(f.changes, `${indent}    `));
      if (f.field === "schema") lines.push(`${indent}  schema`, ...jsonLines(f.changes, `${indent}    `));
      if (f.field === "form") lines.push(...parameterLines(f.changes, `${indent}  `));
    }
  }
  if (diff.responses?.length) {
    lines.push(`${indent}responses`);
    for (const r of diff.responses) {
      if (r.op === "add") lines.push(`${indent}  + ${r.status} ${show(r.after.description, 80)}${r.after.schema ? " · schema" : ""}${r.after.examples.length ? ` · examples ${r.after.examples.join(", ")}` : ""}`);
      else if (r.op === "remove") lines.push(`${indent}  - ${r.status} ${show(r.before.description, 80)}`);
      else {
        lines.push(`${indent}  ~ ${r.status}`);
        for (const f of r.fields) lines.push(`${indent}      ${f.field}: ${show(f.before)} → ${show(f.after)}`);
        if (r.schema) lines.push(`${indent}      schema`, ...jsonLines(r.schema, `${indent}        `));
        for (const x of r.examples ?? []) {
          if (x.op === "add") lines.push(`${indent}      + example ${x.name}`);
          else if (x.op === "remove") lines.push(`${indent}      - example ${x.name}`);
          else {
            lines.push(`${indent}      ~ example ${x.name}`);
            for (const f of x.fields) lines.push(`${indent}          ${f.field}: ${show(f.before)} → ${show(f.after)}`);
            lines.push(...jsonLines(x.example, `${indent}          `));
          }
        }
      }
    }
  }
  return lines;
}

// A new endpoint as it will be created
export function renderNewEndpoint(b, indent = "      ") {
  const lines = [];
  if (b.description) lines.push(`${indent}${show(b.description, 100)}`);
  for (const [title, list] of [["path", b.path_parameters], ["query", b.url_parameters], ["header", b.header_parameters]]) {
    for (const p of list ?? []) lines.push(`${indent}${title} ${p.key} (${parameterLine(canonicalParameter(p))})`);
  }
  if (b.body?.content_type === "application/json") lines.push(`${indent}body JSON${b.body.json_schema ? " with schema" : ""}: ${show(parseJson(b.body.json_body), 100)}`);
  if (b.body?.content_type === "application/x-www-form-urlencoded") for (const p of b.body.parameters ?? []) lines.push(`${indent}form ${p.key} (${parameterLine(canonicalParameter(p))})`);
  for (const r of b.responses ?? []) lines.push(`${indent}response ${r.status}${r.description ? ` ${show(r.description, 60)}` : ""}${r.schema ? " · schema" : ""}${r.examples?.length ? ` · examples ${r.examples.map((x) => x.name).join(", ")}` : ""}`);
  return lines;
}
