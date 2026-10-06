// The Worker code of an API: sign in, pull, run locally, deploy, and what it
// logs and reports while it runs.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { client, describeDeploy } from "../api.mjs";
import { readConfig, writeConfig, writeProject } from "../config.mjs";
import { api, columns, loadEdge, ok, printJson, refused, resolveSlugAndDir, when } from "../context.mjs";
import { bundle, bundleEntry, collectFiles, hasDependencies } from "../files.mjs";
import { gitOrigin } from "../git.mjs";
import { matchEndpoint } from "../match.mjs";

async function login(positional, flags) {
  const token = typeof flags.token === "string" ? flags.token.trim() : process.env.JOJAPI_TOKEN || "";
  if (!/^jm_[A-Za-z0-9_-]{20,}$/.test(token)) {
    console.error("pass a management token: jojapi login --token jm_…  (Studio → Management API)");
    return 2;
  }
  const base = (typeof flags.base === "string" ? flags.base : readConfig().base).replace(/\/$/, "");
  const me = await client({ token, base }).get("v2/ProviderApis");
  if (me.status !== "success") {
    console.error(`the token was refused: ${me.message || me.status}`);
    return 1;
  }
  const path = writeConfig({ token, base });
  console.log(`token stored in ${path} for ${base}`);
  return 0;
}

async function pull(positional) {
  const slug = positional[0];
  if (!slug) throw new Error("usage: jojapi pull <slug> [dir]");
  const dir = resolve(positional[1] ?? slug);
  const config = readConfig();
  const platform = client(config);
  const edge = await loadEdge(platform, slug);

  mkdirSync(dir, { recursive: true });
  let files;
  if (edge.mode === "custom") {
    files = {};
    for (const file of edge.files) {
      const res = await platform.get("v2/provider-api-edge-file", { slug, path: file.path });
      if (res.status !== "success") throw new Error(`${file.path}: ${res.message || res.status}`);
      files[file.path] = res.file.content;
    }
  } else {
    const res = ok(await platform.get("v2/provider-api-edge-source", { slug }));
    files = Object.fromEntries(res.files.map((f) => [f.path, f.content]));
  }
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  writeProject(dir, { slug, base: config.base, mode: edge.mode });
  writeFileSync(join(dir, ".dev.vars.example"), edge.variables.map((v) => `${v.name}=${v.kind === "secret" ? "" : v.value ?? ""}`).join("\n") + "\n");
  writeWranglerConfig(dir, slug, edge);

  console.log(`${Object.keys(files).length} file(s) written to ${dir} (${edge.mode === "custom" ? "code mode" : "template mode — generated Worker; the first deploy switches it to code"})`);
  if (edge.variables.length) console.log(`variables: ${edge.variables.map((v) => v.name).join(", ")} → fill .dev.vars for local runs`);
  if (edge.resources.length) console.log(`resources: ${edge.resources.map((r) => `${r.binding} (${r.kind})`).join(", ")} → wrangler.jsonc has local bindings`);
  return 0;
}

async function deploy(positional, flags) {
  const { slug, dir } = resolveSlugAndDir(positional, flags);
  // The release note is public on the API page and belongs to a production deploy only
  const note = typeof flags.note === "string" ? flags.note.trim() : "";
  if (note && flags.prod !== true) throw new Error("--note is the public release note of a production deploy: add --prod");
  const platform = api();
  const edge = await loadEdge(platform, slug);
  // --json: the result alone on stdout (CI steps parse it), progress on stderr
  const say = flags.json ? (text) => console.error(text) : (text) => console.log(text);

  const files = collectFiles(dir);
  const entry = bundleEntry(dir);
  if (entry || (hasDependencies(dir) && files["index.mjs"] === undefined)) {
    const source = entry ?? "index.mjs";
    say(`bundling ${source} with esbuild…`);
    files["index.mjs"] = await bundle(dir, source);
  }
  if (!files["index.mjs"]) throw new Error("no index.mjs (or src/index.ts to bundle) in " + dir);

  // An API in template mode switches to code mode with this deploy (the
  // platform does it; production keeps the template's deployment unless
  // --prod). --take-over is still accepted and changes nothing.
  if (edge.mode !== "custom" && flags["dry-run"]) say("would switch to code mode (Back to template in Studio restores the template)");

  const remote = new Set(edge.files.map((f) => f.path));
  const remove = [...remote].filter((path) => files[path] === undefined);
  const changed = Object.entries(files).filter(([path, content]) => {
    const existing = edge.files.find((f) => f.path === path);
    return !existing || existing.digest !== sha256Prefix(content) || existing.size !== Buffer.byteLength(content);
  });

  const origin = gitOrigin(dir);
  if (flags["dry-run"]) {
    say(`would upload ${changed.length} file(s): ${changed.map(([p]) => p).join(", ") || "—"}`);
    say(`would delete ${remove.length} file(s): ${remove.join(", ") || "—"}`);
    if (origin.git) say(`origin: ${JSON.stringify(origin.git)}`);
    if (note) say(`release note: ${note}`);
    return 0;
  }
  const production = flags.prod === true;
  const unchanged = changed.length === 0 && remove.length === 0;
  if (unchanged && !production) {
    if (flags.json) printJson({ status: "unchanged" });
    else say("nothing to deploy: the files match the platform");
    return 0;
  }
  // Unchanged files with --prod deploy the stored files again as production
  // (after a reviewed preview; CI records the merge commit)
  const payload = { slug, files: changed.map(([path, content]) => ({ path, content })), delete: remove, production };
  if (unchanged) payload.redeploy = true;
  const message = typeof flags.message === "string" ? flags.message : origin.message;
  if (message) payload.message = message;
  if (origin.git) payload.git = origin.git;
  if (note) payload.note = note;
  const res = await platform.post("v2/update-api-edge-files", payload);
  if (res.status !== "success") return refused(res, flags);
  if (res.switched_to_code === true) say("switched to code mode (Back to template in Studio restores the template)");
  const failed = res.deploy?.status === "error" || res.deploy?.status === "needs_code";
  if (res.deploy?.status === "unchanged") {
    if (flags.json) printJson({ status: "unchanged" });
    else say(`nothing to deploy: production already runs these files${note ? " (no release, so the note was not recorded)" : ""}`);
    return 0;
  }
  if (flags.json) {
    printJson({
      status: failed ? "failed" : "deployed",
      promoted: res.deploy?.promoted === true,
      deployment: res.deploy?.deployment ?? null,
      preview_url: res.deploy?.preview_url ?? null,
      message: res.deploy?.message ?? null,
      uploaded: changed.length,
      deleted: remove.length,
      ...(res.switched_to_code === true ? { switched_to_code: true } : {}),
    });
  } else {
    say(`${unchanged ? "no file changes" : `${changed.length} file(s) uploaded, ${remove.length} deleted`} — ${describeDeploy(res.deploy)}`);
  }
  return failed ? 1 : 0;
}

async function dev(positional, flags) {
  const { slug, dir } = resolveSlugAndDir(positional, flags);
  const edge = await loadEdge(api(), slug);
  const port = Number(flags.port ?? 8788);
  const wranglerPort = port + 1;
  writeWranglerConfig(dir, slug, edge);

  const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(wranglerPort), "-c", "wrangler.jsonc"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  wrangler.on("exit", (code) => process.exit(code ?? 0));

  const context = {
    "x-jojapi-user-nick": String(flags.user ?? "devuser"),
    "x-jojapi-user-id": "dev-legacy-id",
    "x-jojapi-consumer": "dev-consumer",
    "x-jojapi-user-plan": String(flags.plan ?? "dev"),
    "x-jojapi-plan-type": String(flags["plan-type"] ?? "periodic"),
    "x-jojapi-endpoint-credits": "",
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const match = matchEndpoint(edge.endpoints, req.method ?? "GET", url.pathname);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !k.startsWith("x-jojapi-") && k !== "host") headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    for (const [k, v] of Object.entries(context)) headers.set(k, v);
    headers.set("x-jojapi-request-id", crypto.randomUUID());
    if (match) {
      headers.set("x-jojapi-endpoint", `${match.endpoint.method} ${match.endpoint.url_path}`);
      headers.set("x-jojapi-params", JSON.stringify(match.params));
    } else {
      console.log(`  ! ${req.method} ${url.pathname} matches no documented endpoint (the gateway would answer 404)`);
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : req;
    try {
      const upstream = await fetch(`http://127.0.0.1:${wranglerPort}${url.pathname}${url.search}`, { method: req.method, headers, body, duplex: "half", redirect: "manual" });
      const usage = upstream.headers.get("x-jojapi-usage") ?? [...upstream.headers].filter(([k]) => /^x-jojapi-.*-used$/.test(k)).map(([k, v]) => `${k}=${v}`).join(" ");
      const error = upstream.headers.get("x-jojapi-error");
      console.log(`  ${req.method} ${url.pathname} → ${upstream.status}${match ? ` [${match.endpoint.method} ${match.endpoint.url_path}]` : ""}${usage ? ` usage ${usage}` : ""}${error ? ` error ${error}` : ""}`);
      res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([k]) => !["content-encoding", "transfer-encoding"].includes(k))));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`wrangler dev not reachable yet: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  server.listen(port, () => {
    console.log(`\njojapi dev: http://127.0.0.1:${port} adds the gateway's x-jojapi-* headers and forwards to wrangler on :${wranglerPort}`);
    console.log(`endpoints: ${edge.endpoints.map((e) => `${e.method} ${e.url_path}`).join(", ") || "none documented"}\n`);
  });
  return new Promise(() => undefined);
}

async function logs(positional, flags) {
  const { slug } = resolveSlugAndDir(positional.slice(0, 1), flags);
  const platform = api();
  let lastTs = 0;
  const print = async () => {
    const res = ok(await platform.get("v2/provider-api-edge-console", { slug, limit: 200 }));
    if (!res.enabled && lastTs === 0) console.error("logs are off for this API — switch them on: jojapi settings --logs on");
    const lines = [...(res.logs ?? [])].reverse().filter((l) => l.ts > lastTs);
    for (const line of lines) {
      console.log(`${new Date(line.ts).toISOString()} ${line.level.padEnd(5)} ${line.message}${line.requestId ? `  (${line.requestId})` : ""}`);
      lastTs = Math.max(lastTs, line.ts);
    }
  };
  await print();
  if (!flags.follow) return 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    await print();
  }
}

async function errors(positional, flags) {
  const { slug } = resolveSlugAndDir(positional.slice(0, 1), flags);
  const res = ok(await api().get("v2/provider-api-edge-errors", { slug }));
  if (flags.json) return printJson({ issues: res.issues ?? [], edge_reachable: res.edge_reachable !== false });
  if (!res.issues?.length) {
    console.log(res.edge_reachable === false ? "the edge gateway could not be reached" : "no runtime errors recorded");
    return 0;
  }
  console.log(columns(res.issues.map((issue) => [when(issue.lastSeen), `×${issue.count}`, issue.kind, `${issue.message}${issue.lastEndpoint ? `  [${issue.lastEndpoint}]` : ""}`])));
  return 0;
}

async function status(positional, flags) {
  const { slug } = resolveSlugAndDir(positional.slice(0, 1), flags);
  const edge = await loadEdge(api(), slug);
  if (flags.json) return printJson(edge);
  console.log(`${slug}: ${edge.mode === "custom" ? "code" : "template"} mode`);
  console.log(`files: ${edge.files.map((f) => `${f.path} (${f.size} B)`).join(", ") || "— (generated from the template)"}`);
  console.log(`variables: ${edge.variables.map((v) => `${v.name} (${v.kind})`).join(", ") || "—"}`);
  console.log(`resources: ${edge.resources.filter((r) => r.status !== "removed").map((r) => `${r.binding} (${r.kind})`).join(", ") || "—"}`);
  console.log(`settings: cpu ${edge.settings.cpuMs ?? "default"} ms, subrequests ${edge.settings.subRequests ?? "default"}, logs ${edge.settings.logs ? "on" : "off"}`);
  return 0;
}

// A wrangler.jsonc for local runs: the API's resources as local bindings
export function writeWranglerConfig(dir, slug, edge) {
  const config = {
    name: `jojapi-${slug}`,
    main: "index.mjs",
    compatibility_date: "2026-08-15",
    compatibility_flags: ["nodejs_compat"],
  };
  // Removed bindings wait for deletion and are left out; a shared one is bound
  // locally as its kind, except a Durable Object class (it runs in the owner's Worker)
  const resources = edge.resources
    .filter((r) => r.status !== "removed")
    .map((r) => (r.kind === "shared" && r.shared ? { ...r, kind: r.shared.kind, className: null } : r));
  const kv = resources.filter((r) => r.kind === "kv").map((r) => ({ binding: r.binding, id: r.cloudflareId || "local" }));
  const d1 = resources.filter((r) => r.kind === "d1").map((r) => ({ binding: r.binding, database_name: r.cloudflareId || r.binding.toLowerCase(), database_id: r.cloudflareId || "local" }));
  const r2 = resources.filter((r) => r.kind === "r2").map((r) => ({ binding: r.binding, bucket_name: r.cloudflareId || r.binding.toLowerCase() }));
  const queues = resources.filter((r) => r.kind === "queue").map((r) => ({ binding: r.binding, queue: r.cloudflareId || r.binding.toLowerCase() }));
  const dos = resources.filter((r) => r.kind === "do" && r.className).map((r) => ({ name: r.binding, class_name: r.className }));
  if (kv.length) config.kv_namespaces = kv;
  if (d1.length) config.d1_databases = d1;
  if (r2.length) config.r2_buckets = r2;
  if (queues.length) config.queues = { producers: queues };
  if (dos.length) {
    config.durable_objects = { bindings: dos };
    config.migrations = [{ tag: "v1", new_sqlite_classes: dos.map((d) => d.class_name) }];
  }
  const text = `// Local development only (jojapi dev); the platform binds these resources itself on deploy.\n${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(join(dir, "wrangler.jsonc"), text);
}

function sha256Prefix(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export default {
  title: "Code",
  commands: {
    login: {
      usage: ["login --token jm_… [--base URL]"],
      summary: "store a management token",
      help: "Create the token in the Studio under Management API with the scopes of the commands you use: code:read and code:write for the Worker, listings:*, plans:write, analytics:read and subscriptions:read for the rest. It is stored in ~/.config/jojapi/config.json (mode 0600); JOJAPI_TOKEN and JOJAPI_BASE override it.",
      run: login,
    },
    pull: {
      usage: ["pull <slug> [dir]"],
      summary: "download the API's files, or its generated Worker in template mode",
      help: "Writes the files, jojapi.json, .dev.vars.example (variable names; secrets empty) and a wrangler.jsonc with the resources as local bindings.",
      run: pull,
    },
    dev: {
      usage: ["dev [dir] [--port 8788] [--user alice] [--plan pro] [--plan-type periodic]"],
      summary: "run the Worker under wrangler dev with the gateway's headers added",
      run: dev,
    },
    deploy: {
      usage: ["deploy [dir] [--prod] [--note text] [--message text] [--json] [--dry-run]"],
      summary: "upload the files as a new deployment on its own URL",
      help: "Bundles src/ (or a project with npm dependencies) with esbuild into index.mjs. --prod also makes the deployment production; --note (with --prod) is its public release note on the API page. The commit, branch and pull request (git or GitHub Actions) are recorded as the deployment's private description (--message overrides it); --json prints the result for scripts. An API in template mode switches to code mode.",
      run: deploy,
    },
    status: {
      usage: ["status [slug] [--json]"],
      summary: "mode, files, variables, resources, settings",
      run: status,
    },
    logs: {
      usage: ["logs [slug] [--follow]"],
      summary: "console output captured while console logging is on",
      run: logs,
    },
    errors: {
      usage: ["errors [slug] [--json]"],
      summary: "runtime issues, most recent first",
      run: errors,
    },
  },
};
