// OpenAPI helpers shared by the import parsers and the exporter: the endpoint
// parameter type system and its mapping from OpenAPI schemas, local $ref
// resolution, examples and response keys. Kept in step with the Studio's
// importer and the platform's validators.

export const PARAMETER_VALUE_TYPES = ["string", "enum", "number", "integer", "boolean", "date", "time", "object", "array", "geopoint"];

// OpenAPI schema (or Swagger 2 parameter object, which carries `type` directly)
// → { value_type, enum_values }. Handles OAS 3.1+ type arrays (["string","null"]).
export function openApiSchemaToValueType(schema) {
  if (!schema || typeof schema !== "object") {
    return { value_type: "string", enum_values: null };
  }

  const jojapiType = schema["x-jojapi-type"];

  if (typeof jojapiType === "string" && PARAMETER_VALUE_TYPES.includes(jojapiType)) {
    return {
      value_type: jojapiType,
      enum_values: jojapiType === "enum" && Array.isArray(schema.enum)
        ? schema.enum.map((v) => String(v))
        : null,
    };
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return { value_type: "enum", enum_values: schema.enum.map((v) => String(v)) };
  }

  const type = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null")
    : schema.type;

  if (type === "string" && schema.format === "date") {
    return { value_type: "date", enum_values: null };
  }

  if (type === "string" && (schema.format === "time" || schema.format === "partial-time")) {
    return { value_type: "time", enum_values: null };
  }

  if (["number", "integer", "boolean", "object", "array"].includes(type)) {
    return { value_type: type, enum_values: null };
  }

  return { value_type: "string", enum_values: null };
}

// Does an example value string conform to the documented value type? Empty is
// always fine (no example). Mirrors is_valid_parameter_example_for_type() in
// the PHP backend — keep the two in sync.
export function isValidParameterExample(example, valueType, enumValues) {
  const value = String(example ?? "");

  if (value === "") {
    return true;
  }

  switch (valueType) {
    case "enum":
      return !Array.isArray(enumValues) || enumValues.length === 0 || enumValues.includes(value);
    case "number":
      return /^-?\d+(\.\d+)?$/.test(value);
    case "integer":
      return /^-?\d+$/.test(value);
    case "boolean":
      return value === "true" || value === "false";
    case "date": {
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return false;
      const month = Number(match[2]);
      const day = Number(match[3]);
      return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Number(match[1]), month, 0).getDate();
    }
    case "time":
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    case "object": {
      try {
        const parsed = JSON.parse(value);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
      } catch (e) {
        return false;
      }
    }
    case "array": {
      try {
        return Array.isArray(JSON.parse(value));
      } catch (e) {
        return false;
      }
    }
    case "geopoint": {
      const match = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (!match) return false;
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
    }
    default:
      return true;
  }
}

// Resolve a local "#/..." $ref against the spec root ("~1"/"~0" per RFC 6901).
// External refs and broken pointers return the node untouched.
export function resolveOpenApiRef(node, spec, depth = 0) {
  if (!node || typeof node !== "object" || typeof node.$ref !== "string" || depth > 10) {
    return node;
  }

  if (!node.$ref.startsWith("#/")) {
    return node;
  }

  let resolved = spec;

  for (const segment of node.$ref.slice(2).split("/")) {
    if (!resolved || typeof resolved !== "object") {
      return node;
    }
    resolved = resolved[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }

  if (!resolved || typeof resolved !== "object") {
    return node;
  }

  return resolveOpenApiRef(resolved, spec, depth + 1);
}

// Deep-copy an OpenAPI schema with every local "#/..." $ref inlined, for
// storage as a self-contained JSON Schema document. Cycles and
// unresolvable/external refs collapse to {} (unknown), and the whole result is
// dropped when it exceeds the storage cap — a truncated schema would lie.
// Returns a plain object or null.
export function derefOpenApiSchema(schema, spec) {
  if (!schema || typeof schema !== "object") {
    return null;
  }

  const resolved = derefNode(schema, spec, new Set(), 0);

  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    return null;
  }

  try {
    const text = JSON.stringify(resolved);
    return text && text.length <= 100000 ? resolved : null;
  } catch (e) {
    return null;
  }
}

function derefNode(node, spec, stack, depth) {
  if (depth > 22 || node === null || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((child) => derefNode(child, spec, stack, depth + 1));
  }

  if (typeof node.$ref === "string") {
    if (stack.has(node.$ref)) {
      return {};
    }

    const resolved = resolveOpenApiRef(node, spec);

    if (resolved === node) {
      return {};
    }

    stack.add(node.$ref);
    const out = derefNode(resolved, spec, stack, depth + 1);
    stack.delete(node.$ref);
    return out;
  }

  const out = {};

  for (const [key, value] of Object.entries(node)) {
    out[key] = derefNode(value, spec, stack, depth + 1);
  }

  return out;
}

// Stored schema text (normalized JSON strings) → the object the exporter
// embeds, or null
export function parseStoredSchemaText(schema) {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema;
  }

  if (typeof schema !== "string" || schema.trim() === "") {
    return null;
  }

  try {
    const parsed = JSON.parse(schema);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

// First usable example from an OpenAPI parameter/media-type node and its schema,
// as the string form the platform stores. `examples` may be an OpenAPI named map
// ({name: {value}}) or a JSON Schema 2020-12 array. schema.default is NOT an
// example — it imports into the separate default_value field.
export function openApiExampleString(node, schema) {
  const candidates = [
    node?.example,
    firstExampleValue(node?.examples),
    schema?.example,
    firstExampleValue(schema?.examples),
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue;
    }

    if (typeof candidate === "object") {
      try {
        return JSON.stringify(candidate);
      } catch (e) {
        continue;
      }
    }

    return String(candidate);
  }

  return "";
}

// schema.default → the string form the platform stores ("" when absent)
export function openApiDefaultString(schema) {
  const value = schema?.default;

  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (e) {
      return "";
    }
  }

  return String(value);
}

function firstExampleValue(examples) {
  if (!examples) {
    return undefined;
  }

  if (Array.isArray(examples)) {
    return examples[0];
  }

  if (typeof examples === "object") {
    const first = Object.values(examples)[0];
    return first && typeof first === "object" && "value" in first ? first.value : first;
  }

  return undefined;
}

// Normalize an OpenAPI Responses Object key: concrete codes verbatim, ranges
// uppercased ('4xx' → '4XX' — the spec mandates uppercase but lowercase
// exports exist in the wild), 'default' lowercased. Anything else → null.
// Mirrors is_valid_endpoint_response_status() in the PHP backend.
export function normalizeOpenApiResponseKey(key) {
  const value = String(key ?? "").trim();

  if (/^[1-5]\d\d$/.test(value)) {
    return value;
  }

  if (/^[1-5]xx$/i.test(value)) {
    return value.toUpperCase();
  }

  if (value.toLowerCase() === "default") {
    return "default";
  }

  return null;
}

// All JSON examples of a media type object, as the [{name, summary,
// description, example}] rows the platform stores (example = normalized JSON
// text). Reads the named `examples` map first — Example Object `value`, with
// the OAS 3.2 `dataValue` as fallback — then the singular `example`, then
// schema-level examples. Examples with only an externalValue carry no inline
// body and are skipped.
export function openApiMediaExamples(media, spec) {
  if (!media || typeof media !== "object") {
    return [];
  }

  const resolvedMedia = resolveOpenApiRef(media, spec);
  const results = [];
  const named = resolvedMedia?.examples;

  if (named && typeof named === "object" && !Array.isArray(named)) {
    Object.entries(named).forEach(([name, rawExample]) => {
      const example = resolveOpenApiRef(rawExample, spec);
      const value = example && typeof example === "object" && !Array.isArray(example)
        ? (example.value !== undefined ? example.value : example.dataValue)
        : example;
      const body = exampleBodyString(value);

      if (body === "") {
        return;
      }

      const cleanName = sanitizeExampleName(name) || "example" + (results.length + 1);

      if (results.some((r) => r.name === cleanName)) {
        return;
      }

      results.push({
        name: cleanName,
        summary: typeof example?.summary === "string" ? example.summary.slice(0, 256) : "",
        description: typeof example?.description === "string" ? example.description.slice(0, 512) : "",
        example: body,
      });
    });
  }

  if (results.length === 0) {
    const schema = resolveOpenApiRef(resolvedMedia?.schema, spec);
    const single = resolvedMedia?.example !== undefined
      ? resolvedMedia.example
      : schema?.example !== undefined
        ? schema.example
        : Array.isArray(schema?.examples)
          ? schema.examples[0]
          : undefined;
    const body = exampleBodyString(single);

    if (body !== "") {
      results.push({ name: "default", summary: "", description: "", example: body });
    }
  }

  return results;
}

// Example value → normalized JSON text ('' when absent or unencodable).
// Oversized examples are dropped whole — a truncated one isn't valid JSON
// (1MB, mirrors the backend ceiling).
function exampleBodyString(value) {
  if (value === undefined) {
    return "";
  }

  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined || encoded.length > 1000000 ? "" : encoded;
  } catch (e) {
    return "";
  }
}

// Foreign specs may key examples arbitrarily; our stored names follow the
// OpenAPI component-key charset
function sanitizeExampleName(name) {
  return String(name ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
}
