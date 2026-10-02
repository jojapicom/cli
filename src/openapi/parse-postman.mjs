// Postman Collection (v2.x) source adapter, parse side. Collections
// are folders of requests with optional saved example responses; top-level
// folders become endpoint groups, `:var`/`{{var}}` path pieces become {var}
// templates, and anything the model can't hold (formdata bodies, GraphQL,
// unparseable segments) is skipped with a note rather than failing the
// import. Collections carry no pricing or logo.

import { normalizeOpenApiResponseKey } from "./schema.mjs";
import { IMPORT_SKIPPED_HEADERS } from "./parse-openapi.mjs";

const POSTMAN_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"];

// Mirrors the backend's URL-path charset (is_url_path_part_valid) plus the
// {video} braces of a template segment
const SEGMENT_CHARSET = /^[a-zA-Z0-9.*()_\-~+@[\]:;=,&$!^{}%]*$/;

export function looksLikePostmanCollection(document) {
  return !!(
    document &&
    typeof document === "object" &&
    document.info &&
    (String(document.info.schema || "").includes("getpostman.com/json/collection") ||
      document.info._postman_id !== undefined) &&
    Array.isArray(document.item)
  );
}

export function parsePostmanCollection(collection) {
  if (!collection || typeof collection !== "object" || !Array.isArray(collection.item)) {
    throw new Error("This does not look like a Postman Collection (v2) — no 'item' list found");
  }

  const info = collection.info && typeof collection.info === "object" ? collection.info : {};
  const warnings = [];
  const endpoints = [];

  const walk = (items, group) => {
    items.forEach((item) => {
      if (!item || typeof item !== "object") return;

      if (Array.isArray(item.item)) {
        // Top-level folders become groups; deeper nesting keeps the top name
        walk(item.item, group ?? inline(item.name, 255) ?? null);
        return;
      }

      if (item.request) {
        buildEndpoint(item, group, endpoints, warnings);
      }
    });
  };

  walk(collection.item, null);

  return {
    meta: {
      name: inline(info.name, 255) || null,
      description: null,
      about: block(descriptionText(info.description), 65535) || null,
      logo_url: null,
    },
    endpoints,
    plans: [],
    warnings,
  };
}

function buildEndpoint(item, group, endpoints, warnings) {
  const request = typeof item.request === "string" ? { url: item.request, method: "GET" } : item.request;
  const label = inline(item.name, 120) || "request";
  const method = String(request.method || "GET").toUpperCase();

  if (!POSTMAN_METHODS.includes(method)) {
    warnings.push({ context: label, message: `Unsupported method ${method} — skipped` });
    return;
  }

  const url = request.url;
  const segments = urlSegments(url);

  if (segments === null) {
    warnings.push({ context: label, message: "Could not derive a URL path — skipped" });
    return;
  }

  // Postman `:var` and `{{var}}` path pieces → {var} templates
  const cleanSegments = [];

  for (const rawSegment of segments) {
    let segment = String(rawSegment);

    if (/^:[A-Za-z0-9_-]+$/.test(segment)) {
      segment = "{" + segment.slice(1) + "}";
    } else {
      segment = segment.replace(/\{\{([^}]+)\}\}/g, (m, name) => "{" + String(name).trim() + "}");
    }

    if (!SEGMENT_CHARSET.test(segment)) {
      warnings.push({ context: label, message: `Path segment "${rawSegment}" has characters the gateway can't route — skipped` });
      return;
    }

    cleanSegments.push(segment);
  }

  const urlPath = "/" + cleanSegments.filter((segment) => segment !== "").join("/");

  if (urlPath.length > 218) {
    warnings.push({ context: label, message: "URL path is too long — skipped" });
    return;
  }

  const pathVariables = (urlPath.match(/\{([^}]+)\}/g) || []).map((part) => part.slice(1, -1));

  // Query parameters
  const parameters = [];

  (Array.isArray(url?.query) ? url.query : []).forEach((entry, index) => {
    const key = inline(entry?.key, 128);

    if (!entry || entry.disabled === true || !key || parameters.some((existing) => existing.key === key)) {
      return;
    }

    parameters.push({
      key,
      name: "",
      description: block(descriptionText(entry.description), 2048),
      example: inline(entry.value, 256),
      value_type: "string",
      required: false,
      enum_values: null,
      default_value: "",
      type: "url",
      order: index,
    });
  });

  // Path variable docs (url.variable) + bare template rows
  const pathParameters = [];

  (Array.isArray(url?.variable) ? url.variable : []).forEach((entry) => {
    const key = inline(entry?.key, 128);

    if (!key || !pathVariables.includes(key) || pathParameters.some((existing) => existing.key === key)) {
      return;
    }

    pathParameters.push({
      key,
      name: "",
      description: block(descriptionText(entry.description), 2048),
      example: inline(entry.value, 256),
      value_type: "string",
      required: true,
      enum_values: null,
      default_value: "",
    });
  });

  pathVariables.forEach((variable) => {
    if (!pathParameters.some((existing) => existing.key === variable)) {
      pathParameters.push({
        key: variable,
        name: "",
        description: "",
        example: "",
        value_type: "string",
        required: true,
        enum_values: null,
        default_value: "",
      });
    }
  });

  // Headers (auth-ish and content-type are the transport's business)
  const headerParameters = [];

  (Array.isArray(request.header) ? request.header : []).forEach((entry, index) => {
    const key = inline(entry?.key, 128);

    if (
      !entry ||
      entry.disabled === true ||
      !key ||
      key.toLowerCase() === "content-type" ||
      IMPORT_SKIPPED_HEADERS.includes(key.toLowerCase()) ||
      headerParameters.some((existing) => existing.key.toLowerCase() === key.toLowerCase())
    ) {
      return;
    }

    headerParameters.push({
      key,
      name: "",
      description: block(descriptionText(entry.description), 2048),
      example: inline(entry.value, 256),
      value_type: "string",
      required: false,
      enum_values: null,
      default_value: "",
      type: "header",
      order: index,
    });
  });

  // Body
  let requestBody = null;
  const body = request.body;

  if (body && typeof body === "object" && method !== "GET") {
    if (body.mode === "raw" && typeof body.raw === "string" && body.raw.trim() !== "") {
      try {
        requestBody = { contentType: "application/json", body: JSON.parse(body.raw) };
      } catch (e) {
        warnings.push({ context: label, message: "Raw body is not valid JSON — body skipped" });
      }
    } else if (body.mode === "urlencoded" && Array.isArray(body.urlencoded)) {
      const formParameters = [];

      body.urlencoded.forEach((entry, index) => {
        const key = inline(entry?.key, 128);

        if (!entry || entry.disabled === true || !key || formParameters.some((existing) => existing.key === key)) {
          return;
        }

        formParameters.push({
          key,
          name: "",
          description: block(descriptionText(entry.description), 2048),
          example: inline(entry.value, 256),
          value_type: "string",
          required: false,
          enum_values: null,
          default_value: "",
          type: "post",
          order: index,
        });
      });

      if (formParameters.length > 0) {
        requestBody = { contentType: "application/x-www-form-urlencoded", parameters: formParameters };
      }
    } else if (body.mode && body.mode !== "raw") {
      warnings.push({ context: label, message: `Body mode "${body.mode}" is not importable — body skipped` });
    }
  }

  // Saved example responses → named examples grouped by status
  const byStatus = new Map();

  (Array.isArray(item.response) ? item.response : []).forEach((saved) => {
    const status = normalizeOpenApiResponseKey(saved?.code);

    if (!status || typeof saved?.body !== "string" || saved.body.trim() === "") {
      return;
    }

    let encoded;

    try {
      encoded = JSON.stringify(JSON.parse(saved.body));
    } catch (e) {
      return;
    }

    if (encoded.length > 1000000) return;

    if (!byStatus.has(status)) {
      byStatus.set(status, { status, description: inline(saved.status, 512), examples: [] });
    }

    const responseEntry = byStatus.get(status);

    if (responseEntry.examples.length >= 20) return;

    let name = inline(saved.name, 120).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "example";
    let counter = 2;
    const base = name;

    while (responseEntry.examples.some((existing) => existing.name === name)) {
      name = base + "-" + counter++;
    }

    responseEntry.examples.push({ name, summary: "", description: "", example: encoded });
  });

  endpoints.push({
    method,
    url_path: urlPath,
    name: inline(item.name, 255) || `${method} ${urlPath}`,
    description: block(descriptionText(request.description), 2048),
    group,
    parameters,
    pathParameters,
    headerParameters,
    requestBody,
    responses: [...byStatus.values()],
  });
}

// url can be a string ("https://x.test/a/b?c=1" or "{{base}}/a/b") or the
// object form ({raw, host, path, query, variable})
function urlSegments(url) {
  if (url && typeof url === "object" && Array.isArray(url.path)) {
    return url.path.map((segment) => String(segment ?? ""));
  }

  let raw = typeof url === "string" ? url : typeof url?.raw === "string" ? url.raw : "";

  if (raw === "") return null;

  // Strip scheme+host or a {{baseUrl}}-style prefix, then the query/fragment
  raw = raw.replace(/^https?:\/\/[^/?#]+/i, "").replace(/^\{\{[^}]+\}\}/, "");
  raw = raw.split("?")[0].split("#")[0];

  return raw.split("/").map((segment) => segment.trim());
}

function descriptionText(description) {
  if (typeof description === "string") return description;
  if (description && typeof description === "object" && typeof description.content === "string") return description.content;

  return "";
}

function inline(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function block(value, max) {
  return String(value ?? "").trim().slice(0, max);
}
