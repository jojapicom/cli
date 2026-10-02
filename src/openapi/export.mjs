// The API as an OpenAPI 3.2 document that imports back without changes: title,
// summary and description carry the name, short description and stored about
// text; examples keep their exact stored text; empty descriptions stay empty;
// no placeholder responses. Endpoints come from the owner's API page payload
// (hidden and requests-off ones included), the details from provider-api.

import { pageEndpoints } from "../page.mjs";
import { parseStoredSchemaText } from "./schema.mjs";

// The stored value as the JSON type its schema declares, but only when that
// converts back to the same text ("3.10" stays a string, "3" becomes 3)
function exactValue(value, valueType) {
  const text = String(value);
  if ((valueType === "number" || valueType === "integer") && /^-?\d+(\.\d+)?$/.test(text) && String(Number(text)) === text) return Number(text);
  if (valueType === "boolean" && (text === "true" || text === "false")) return text === "true";
  if (valueType === "object" || valueType === "array") {
    try {
      const parsed = JSON.parse(text);
      if (JSON.stringify(parsed) === text) return parsed;
    } catch {
      // not JSON: kept as text
    }
  }
  return text;
}

function parameterSchema(p) {
  const valueType = p.value_type || "string";
  const schema = {};
  switch (valueType) {
    case "enum":
      schema.type = "string";
      if (Array.isArray(p.enum_values) && p.enum_values.length) schema.enum = [...p.enum_values];
      else schema["x-jojapi-type"] = "enum";
      break;
    case "number":
    case "integer":
    case "boolean":
    case "object":
      schema.type = valueType;
      break;
    case "array":
      schema.type = "array";
      schema.items = { type: "string" };
      break;
    case "date":
    case "time":
      schema.type = "string";
      schema.format = valueType;
      break;
    case "geopoint":
      schema.type = "string";
      schema["x-jojapi-type"] = "geopoint";
      break;
    default:
      schema.type = "string";
  }
  if (p.name) schema.title = p.name;
  if (p.example !== undefined && p.example !== null && p.example !== "") schema.example = exactValue(p.example, valueType);
  if (p.default_value !== undefined && p.default_value !== null && p.default_value !== "") schema.default = exactValue(p.default_value, valueType);
  return schema;
}

function parameter(p, location) {
  return {
    name: p.key,
    in: location,
    ...(p.description ? { description: p.description } : {}),
    required: location === "path" ? true : p.required === true,
    schema: parameterSchema(p),
  };
}

function exampleValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function responses(list) {
  const result = {};
  for (const r of list || []) {
    const status = String(r.status ?? r.status_code ?? "");
    if (!status) continue;
    const media = {};
    const schema = parseStoredSchemaText(r.schema);
    if (schema) media.schema = schema;
    const examples = Array.isArray(r.examples) && r.examples.length ? r.examples : r.example ? [{ name: "default", example: r.example }] : [];
    if (examples.length === 1 && (!examples[0].name || examples[0].name === "default") && !examples[0].summary && !examples[0].description) {
      media.example = exampleValue(examples[0].example);
    } else if (examples.length) {
      media.examples = Object.fromEntries(examples.map((x, i) => [x.name || `example${i + 1}`, { ...(x.summary ? { summary: x.summary } : {}), ...(x.description ? { description: x.description } : {}), value: exampleValue(x.example) }]));
    }
    result[status] = { description: r.description ?? "", ...(Object.keys(media).length ? { content: { "application/json": media } } : {}) };
  }
  return result;
}

function requestBody(e) {
  const form = e.parameters?.post ?? [];
  const body = (e.parameters?.body ?? [])[0];
  if (form.length) {
    const required = form.filter((p) => p.required).map((p) => p.key);
    const properties = Object.fromEntries(form.map((p) => [p.key, { ...parameterSchema(p), ...(p.description ? { description: p.description } : {}) }]));
    return { required: required.length > 0, content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties, ...(required.length ? { required } : {}) } } } };
  }
  if (body && (body.example || body.schema)) {
    const schema = parseStoredSchemaText(body.schema);
    return { content: { "application/json": { ...(schema ? { schema } : {}), ...(body.example ? { example: exampleValue(body.example) } : {}) } } };
  }
  return null;
}

function operationId(method, path, used) {
  const base = `${method.toLowerCase()}_${path}`.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "operation";
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  used.add(id);
  return id;
}

// details: GET provider-api's `api` (name, description, stored about);
// page: the scrubbed API page payload (loadPage)
export function buildSpec(details, page) {
  const paths = {};
  const tags = [];
  const used = new Set();
  let rootUrl = null;
  for (const group of page.endpoint_groups ?? []) {
    if (!group.ungrouped && group.endpoints?.length) tags.push({ name: group.name, ...(group.description ? { description: group.description } : {}) });
  }
  for (const { group, endpoint: e } of pageEndpoints(page)) {
    rootUrl = rootUrl ?? e.root_url ?? null;
    const method = e.method.toLowerCase();
    const params = [
      ...(e.parameters?.path ?? []).map((p) => parameter(p, "path")),
      ...(e.parameters?.url ?? []).map((p) => parameter(p, "query")),
      ...(e.parameters?.header ?? []).filter((p) => !p.is_auth).map((p) => parameter(p, "header")),
    ];
    const body = method === "get" ? null : requestBody(e);
    const documented = responses(e.responses);
    const operation = {
      operationId: operationId(e.method, e.url_path, used),
      ...(e.name ? { summary: e.name } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(group.ungrouped ? {} : { tags: [group.name] }),
      ...(params.length ? { parameters: params } : {}),
      ...(body ? { requestBody: body } : {}),
      ...(Object.keys(documented).length ? { responses: documented } : {}),
      ...(e.agent_price !== null && e.agent_price !== undefined
        ? { "x-payment-info": { protocols: ["x402", "mpp"], price: { mode: "fixed", currency: "USD", amount: String(Number(e.agent_price)) }, intent: "charge" } }
        : {}),
    };
    paths[e.url_path] = { ...(paths[e.url_path] ?? {}), [method]: operation };
  }
  return {
    openapi: "3.2.0",
    info: {
      title: details.name,
      ...(details.description ? { summary: details.description } : {}),
      ...(details.about ? { description: details.about } : {}),
      version: "1.0.0",
    },
    ...(rootUrl ? { servers: [{ url: rootUrl }] } : {}),
    security: [{ ApiKeyAuth: [] }],
    ...(tags.length ? { tags } : {}),
    paths,
    components: { securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "X-JoJAPI-Key", description: "Your JoJ API key." } } },
  };
}
