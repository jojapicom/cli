// Management API client: the Studio's REST routes under /rest/v2 with a
// bearer management token. Every answer is JSON with a `status` field; the
// HTTP status is 200 for anything the application produced.

export class ApiError extends Error {
  constructor(message, response) {
    super(message);
    this.response = response;
  }
}

export function client(config) {
  if (!config.token) throw new ApiError("no management token — run `jojapi login --token jm_…` or set JOJAPI_TOKEN", null);

  async function call(method, path, params) {
    const url = new URL(`${config.base}/rest/${path}`);
    const init = { method, headers: { authorization: `Bearer ${config.token}`, accept: "application/json" } };
    if (method === "GET") {
      for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    } else {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(params ?? {});
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, null);
    }
    if (json.status === "unauthorized" || json.status === "insufficient_scope") {
      throw new ApiError(`${method} ${path}: ${json.message || json.status}${json.required_scopes ? ` (needs ${json.required_scopes.join(", ")})` : ""}`, json);
    }
    return json;
  }

  return {
    get: (path, params) => call("GET", path, params),
    post: (path, params) => call("POST", path, params),
  };
}

// The deploy result of a write, as one line for the terminal
export function describeDeploy(deploy) {
  if (!deploy || typeof deploy !== "object") return "";
  switch (deploy.status) {
    case "deployed":
      // A deployment: a preview on its own URL, or production
      if (deploy.deployment) {
        const n = `#${deploy.deployment.number} ${deploy.deployment.id}`;
        if (deploy.message) return `deployment ${n} ready, but: ${deploy.message}\n  ${deploy.deployment.url}`;
        return deploy.promoted
          ? `deployment ${n} is live in production`
          : `deployment ${n} ready as a preview (promote: jojapi promote ${deploy.deployment.id})\n  ${deploy.deployment.url}\n  ${deploy.preview_url ?? ""}`.trimEnd();
      }
      return `deployed (${deploy.mode}, ${(deploy.files ?? []).length} file(s), version ${deploy.version})`;
    case "skipped":
      return `not deployed: ${deploy.reason}`;
    case "needs_code":
      return `not deployed: ${(deploy.issues ?? []).map((i) => `${i.field}: ${i.reason}`).join("; ")}`;
    case "error":
      return `deploy failed: ${deploy.message}`;
    case "unreachable":
      return `edge unreachable: ${deploy.message}`;
    default:
      return `deploy: ${deploy.status}`;
  }
}
