// OpenAPI document → import-bundle pieces, the same parse as the Studio's
// import wizard. Deliberately forgiving: sloppy per-field values degrade
// (dropped example, trimmed name) instead of failing an endpoint, and the
// platform's bundle validation stays the real gate.

import {
  openApiSchemaToValueType,
  resolveOpenApiRef,
  openApiExampleString,
  openApiDefaultString,
  isValidParameterExample,
  normalizeOpenApiResponseKey,
  openApiMediaExamples,
  derefOpenApiSchema,
} from "./schema.mjs";

// Client-side limits (mirroring the platform's validators) so a sloppy spec still
// imports instead of failing whole endpoints on one long/odd field
function sanitizeParameterName(name) {
  return String(name || "")
    .replace(/[^a-zA-Z0-9_\-(). ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

function buildImportedParameter(key, rawName, description, example, valueTypeInfo, defaultValue = "") {
  const enumValues = valueTypeInfo.enum_values
    ? valueTypeInfo.enum_values.slice(0, 100).map((v) => String(v).slice(0, 256))
    : null;

  // A spec example/default that doesn't conform to the declared type (the
  // backend rejects those) is dropped rather than failing the whole endpoint
  let exampleValue = String(example || "").slice(0, 256);

  if (!isValidParameterExample(exampleValue, valueTypeInfo.value_type, enumValues)) {
    exampleValue = "";
  }

  let cleanDefaultValue = String(defaultValue || "").slice(0, 256);

  if (!isValidParameterExample(cleanDefaultValue, valueTypeInfo.value_type, enumValues)) {
    cleanDefaultValue = "";
  }

  return {
    key,
    name: sanitizeParameterName(rawName),
    description: String(description || "").slice(0, 2048),
    example: exampleValue,
    value_type: valueTypeInfo.value_type,
    enum_values: enumValues,
    default_value: cleanDefaultValue,
  };
}

// Auth-ish headers the gateway injects or strips — never imported as docs
export const IMPORT_SKIPPED_HEADERS = [
  "authorization",
  "x-api-key",
  "api-key",
  "x-jojapi-key",
  "x-rapidapi-key",
  "x-rapidapi-host",
  "x-rapidapi-proxy-secret",
];

/**
 * Parsed OpenAPI/Swagger object → { meta, endpoints }.
 * Throws Error with a user-facing message when the document has no usable
 * structure; per-endpoint oddities degrade silently instead.
 */
export function parseOpenApiDocument(openApiSpec) {
    // Validate basic OpenAPI structure
    if (!openApiSpec || typeof openApiSpec !== "object" || !openApiSpec.paths) {
      throw new Error("Invalid OpenAPI specification: 'paths' property is missing");
    }

    // API metadata carried by the spec (info.summary → short description,
    // info.description → About). Callers decide what to do with it.
    const info = openApiSpec.info && typeof openApiSpec.info === "object" ? openApiSpec.info : {};

    const meta = {
      name: typeof info.title === "string" && info.title.trim() !== "" ? info.title.trim().slice(0, 255) : null,
      description: typeof info.summary === "string" && info.summary.trim() !== "" ? info.summary.trim().slice(0, 1024) : null,
      about: typeof info.description === "string" && info.description.trim() !== "" ? info.description.trim().slice(0, 65535) : null,
      logo_url: null,
    };

    // Extract endpoints from paths
    const endpoints = [];

    for (const [path, rawPathItem] of Object.entries(openApiSpec.paths)) {
      const pathItem = resolveOpenApiRef(rawPathItem, openApiSpec);

      if (!pathItem || typeof pathItem !== "object") continue;

      // Path-level parameters apply to every operation unless the operation
      // redefines the same (name, in) pair
      const pathLevelParameters = Array.isArray(pathItem.parameters)
        ? pathItem.parameters.map((p) => resolveOpenApiRef(p, openApiSpec))
        : [];

      // The {variable} segments of the path itself decide which path
      // parameters exist; docs for anything else are dropped
      const pathVariables = (path.match(/\{([^}]+)\}/g) || []).map((s) => s.slice(1, -1));

      // Process each HTTP method
      for (const [method, operation] of Object.entries(pathItem)) {
        // Skip non-HTTP method properties
        if (!["get", "post", "put", "delete", "patch", "options", "head"].includes(method)) {
          continue;
        }

        // Create endpoint object
        const endpoint = {
          method: method.toUpperCase(),
          url_path: path,
          name: operation.summary || `${method.toUpperCase()} ${path}`,
          description: operation.description || "",
          // First tag → endpoint group (created/matched on apply)
          group: Array.isArray(operation.tags) && typeof operation.tags[0] === "string"
            ? operation.tags[0].trim().slice(0, 255)
            : null,
          parameters: [],
          pathParameters: [],
          headerParameters: [],
          responses: [],
        };

        // Merge path-level and operation-level parameters (operation wins)
        const operationParameters = Array.isArray(operation.parameters)
          ? operation.parameters.map((p) => resolveOpenApiRef(p, openApiSpec))
          : [];
        const mergedParameters = [
          ...pathLevelParameters.filter(
            (p) => !operationParameters.some((o) => o?.name === p?.name && o?.in === p?.in)
          ),
          ...operationParameters,
        ];

        // Extract query and path parameters
        mergedParameters.forEach((param) => {
          if (!param || typeof param !== "object" || !param.name) return;

          // Swagger 2 keeps the type on the parameter itself, OpenAPI 3 in schema
          const schema = resolveOpenApiRef(param.schema, openApiSpec) || param;
          const valueTypeInfo = openApiSchemaToValueType(schema);
          const docs = buildImportedParameter(
            param.name,
            schema.title || "",
            param.description,
            openApiExampleString(param, schema),
            valueTypeInfo,
            openApiDefaultString(schema)
          );

          if (param.in === "query") {
            endpoint.parameters.push({
              ...docs,
              required: param.required === true,
              type: "url",
              order: endpoint.parameters.length,
            });
          } else if (
            param.in === "path" &&
            pathVariables.includes(param.name) &&
            !endpoint.pathParameters.some((p) => p.key === param.name)
          ) {
            // Path parameters are always required per OpenAPI
            endpoint.pathParameters.push(docs);
          } else if (
            param.in === "header" &&
            !IMPORT_SKIPPED_HEADERS.includes(String(param.name).toLowerCase()) &&
            !endpoint.headerParameters.some((p) => p.key.toLowerCase() === String(param.name).toLowerCase())
          ) {
            endpoint.headerParameters.push({
              ...docs,
              required: param.required === true,
              type: "header",
              order: endpoint.headerParameters.length,
            });
          }
        });

        // Extract response docs (per OpenAPI response key — concrete codes,
        // 1XX..5XX ranges and 'default' — with every named application/json
        // example).
        if (operation.responses && typeof operation.responses === "object") {
          Object.entries(operation.responses).forEach(([code, rawResponse]) => {
            const status = normalizeOpenApiResponseKey(code);

            if (!status || endpoint.responses.some((r) => r.status === status)) return;

            const resolvedResponse = resolveOpenApiRef(rawResponse, openApiSpec);

            if (!resolvedResponse || typeof resolvedResponse !== "object") return;

            const responseMedia = resolvedResponse.content?.["application/json"];
            const responseSchema = derefOpenApiSchema(responseMedia?.schema, openApiSpec);

            endpoint.responses.push({
              status,
              description: String(resolvedResponse.description || "").slice(0, 512),
              // Stored self-contained (local $refs inlined)
              ...(responseSchema ? { schema: JSON.stringify(responseSchema) } : {}),
              examples: openApiMediaExamples(responseMedia, openApiSpec),
            });
          });
        }

        // Extract request body for non-GET methods
        if (method !== "get" && operation.requestBody) {
          const content = resolveOpenApiRef(operation.requestBody, openApiSpec)?.content;

          if (content && content["application/json"]) {
            const media = content["application/json"];
            const schema = resolveOpenApiRef(media.schema, openApiSpec);

            let example = media.example;

            if (example === undefined && media.examples && typeof media.examples === "object") {
              const first = Object.values(media.examples)[0];
              example = first && typeof first === "object" && "value" in first ? first.value : first;
            }

            if (example === undefined && schema) {
              example = schema.example ?? schema.default;
            }

            // Field-level body schema, stored self-contained
            const bodySchema = derefOpenApiSchema(media.schema, openApiSpec);

            if (example !== undefined && example !== null) {
              endpoint.requestBody = {
                contentType: "application/json",
                body: example,
                ...(bodySchema ? { schema: bodySchema } : {})
              };
            } else if (bodySchema) {
              // Schema but no example anywhere in the spec — keep the schema,
              // document an empty example
              endpoint.requestBody = {
                contentType: "application/json",
                body: {},
                schema: bodySchema
              };
            }
          } else if (content && content["application/x-www-form-urlencoded"]) {
            const schema = resolveOpenApiRef(content["application/x-www-form-urlencoded"].schema, openApiSpec);

            if (schema && schema.properties) {
              const requiredList = Array.isArray(schema.required) ? schema.required : [];
              const formParams = [];

              Object.entries(schema.properties).forEach(([name, rawProp], index) => {
                const prop = resolveOpenApiRef(rawProp, openApiSpec) || {};

                formParams.push({
                  ...buildImportedParameter(
                    name,
                    prop.title || "",
                    prop.description,
                    openApiExampleString(null, prop),
                    openApiSchemaToValueType(prop),
                    openApiDefaultString(prop)
                  ),
                  required: requiredList.includes(name),
                  type: "post",
                  order: index
                });
              });

              endpoint.requestBody = {
                contentType: "application/x-www-form-urlencoded",
                parameters: formParams
              };
            }
          }
        }

        endpoints.push(endpoint);
      }
    }


    return { meta, endpoints };
}
