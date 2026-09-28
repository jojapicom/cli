// Command dispatch and the commands themselves.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { client, describeDeploy } from "./api.mjs";
import { PROJECT_FILE, readConfig, readProject, writeConfig, writeProject } from "./config.mjs";
import { bundle, bundleEntry, collectFiles, hasDependencies } from "./files.mjs";
import { gitOrigin } from "./git.mjs";
import { matchEndpoint } from "./match.mjs";

const USAGE = `jojapi <command>

  login --token jm_… [--base URL]   store a management token (scopes code:read, code:write)
  pull <slug> [dir]                  download the API's files, or its generated Worker in template mode
  deploy [dir] [--prod] [--message text] [--json] [--dry-run]
                                     upload the files (bundling src/ with npm dependencies) as a new
                                     deployment on its own URL; --prod also makes it production;
                                     the commit, branch and pull request (git or GitHub Actions) are
                                     recorded; --json prints the result for scripts; an API in
                                     template mode switches to code mode
  deployments [slug]                 the API's deployments, newest first
  promote [slug] <id> [--note text]  serve a deployment in production (the note is public)
  rollback [slug] [--note text]      back to the deployment production served before
  dev [dir] [--port 8788] [--user alice] [--plan pro]
                                     run the Worker under wrangler dev with the gateway's headers added
  logs <slug> [--follow]             console output captured while logs are on
  errors <slug>                      runtime issues, most recent first
  status <slug>                      mode, files, variables, resources, settings

Environment: JOJAPI_TOKEN, JOJAPI_BASE override ~/.config/jojapi/config.json.`;

export async function run(argv) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case "login": return login(flags);
    case "pull": return pull(positional, flags);
    case "deploy": return deploy(positional, flags);
    case "dev": return dev(positional, flags);
    case "logs": return logs(positional, flags);
    case "errors": return errors(positional);
    case "status": return status(positional);
    case "deployments": return deployments(positional, flags);
    case "promote": return promote(positional, flags);
    case "rollback": return rollback(positional, flags);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

// Switches never take a value: `deploy --prod ./dir` keeps ./dir positional
const BOOLEAN_FLAGS = new Set(["prod", "take-over", "dry-run", "follow", "json"]);

export function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (!BOOLEAN_FLAGS.has(arg.slice(2)) && i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[arg.slice(2)] = args[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------

async function login(flags) {
  const token = typeof flags.token === "string" ? flags.token.trim() : process.env.JOJAPI_TOKEN || "";
  if (!/^jm_[A-Za-z0-9_-]{20,}$/.test(token)) {
    console.error("pass a management token: jojapi login --token jm_…  (Studio → Management API, scopes code:read and code:write)");
    return 2;
  }
  const base = (typeof flags.base === "string" ? flags.base : readConfig().base).replace(/\/$/, "");
  const api = client({ token, base });
  const me = await api.get("v2/ProviderApis");
  if (me.status !== "success") {
    console.error(`the token was refused: ${me.message || me.status}`);
    return 1;
  }
  const path = writeConfig({ token, base });
  console.log(`token stored in ${path} for ${base}`);
  return 0;
}

async function resolveSlugAndDir(positional, flags, needSlug = true) {
  let slug = positional[0];
  let dir = positional[1];
  if (slug && !dir && existsSync(resolve(slug)) && readProject(resolve(slug))) {
    // `jojapi deploy ./dir`
    dir = slug;
    slug = undefined;
  }
  dir = resolve(dir ?? ".");
  const project = readProject(dir);
  slug = slug ?? (typeof flags.slug === "string" ? flags.slug : project?.slug);
  if (needSlug && !slug) throw new Error(`no API slug: pass it or run inside a directory with ${PROJECT_FILE} (jojapi pull <slug>)`);
  return { slug, dir, project };
}

async function pull(positional, flags) {
  const slug = positional[0];
  if (!slug) throw new Error("usage: jojapi pull <slug> [dir]");
  const dir = resolve(positional[1] ?? slug);
  const config = readConfig();
  const api = client(config);
  const edge = await loadEdge(api, slug);

  mkdirSync(dir, { recursive: true });
  let files;
  if (edge.mode === "custom") {
    files = {};
    for (const file of edge.files) {
      const res = await api.get("v2/provider-api-edge-file", { slug, path: file.path });
      if (res.status !== "success") throw new Error(`${file.path}: ${res.message || res.status}`);
      files[file.path] = res.file.content;
    }
  } else {
    const res = await api.get("v2/provider-api-edge-source", { slug });
    if (res.status !== "success") throw new Error(res.message || res.status);
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
  const { slug, dir } = await resolveSlugAndDir(positional, flags);
  const api = client(readConfig());
  const edge = await loadEdge(api, slug);
  // --json: the result alone on stdout (CI steps parse it), progress on stderr
  const say = flags.json ? (text) => console.error(text) : (text) => console.log(text);

  let files = collectFiles(dir);
  const entry = bundleEntry(dir);
  if (entry || (hasDependencies(dir) && files["index.mjs"] === undefined)) {
    const source = entry ?? "index.mjs";
    say(`bundling ${source} with esbuild…`);
    files["index.mjs"] = await bundle(dir, source);
    // Modules the bundle already contains are not uploaded twice
    for (const path of Object.keys(files)) if (path !== "index.mjs" && /\.(mjs|js)$/.test(path) && path.startsWith("lib/") === false && path.startsWith("endpoints/") === false) continue;
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
    return 0;
  }
  const production = flags.prod === true;
  const unchanged = changed.length === 0 && remove.length === 0;
  if (unchanged && !production) {
    if (flags.json) console.log(JSON.stringify({ status: "unchanged" }));
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
  const res = await api.post("v2/update-api-edge-files", payload);
  if (res.status !== "success") {
    if (flags.json) console.log(JSON.stringify({ status: res.status, message: res.message ?? null, errors: res.errors ?? [] }));
    console.error(`${res.message || res.status}${Array.isArray(res.errors) ? "\n  " + res.errors.join("\n  ") : ""}`);
    return 1;
  }
  if (res.switched_to_code === true) say("switched to code mode (Back to template in Studio restores the template)");
  const failed = res.deploy?.status === "error" || res.deploy?.status === "needs_code";
  if (res.deploy?.status === "unchanged") {
    if (flags.json) console.log(JSON.stringify({ status: "unchanged" }));
    else say("nothing to deploy: production already runs these files");
    return 0;
  }
  if (flags.json) {
    console.log(JSON.stringify({
      status: failed ? "failed" : "deployed",
      promoted: res.deploy?.promoted === true,
      deployment: res.deploy?.deployment ?? null,
      preview_url: res.deploy?.preview_url ?? null,
      message: res.deploy?.message ?? null,
      uploaded: changed.length,
      deleted: remove.length,
      ...(res.switched_to_code === true ? { switched_to_code: true } : {}),
    }));
  } else {
    say(`${unchanged ? "no file changes" : `${changed.length} file(s) uploaded, ${remove.length} deleted`} — ${describeDeploy(res.deploy)}`);
  }
  return failed ? 1 : 0;
}

async function dev(positional, flags) {
  const { slug, dir } = await resolveSlugAndDir(positional, flags);
  const api = client(readConfig());
  const edge = await loadEdge(api, slug);
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
  const slug = positional[0];
  if (!slug) throw new Error("usage: jojapi logs <slug> [--follow]");
  const api = client(readConfig());
  let lastTs = 0;
  const print = async () => {
    const res = await api.get("v2/provider-api-edge-console", { slug, limit: 200 });
    if (res.status !== "success") throw new Error(res.message || res.status);
    if (!res.enabled && lastTs === 0) console.error("logs are off for this API — switch them on in Studio → Code → Worker settings");
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

async function errors(positional) {
  const slug = positional[0];
  if (!slug) throw new Error("usage: jojapi errors <slug>");
  const api = client(readConfig());
  const res = await api.get("v2/provider-api-edge-errors", { slug });
  if (res.status !== "success") throw new Error(res.message || res.status);
  if (!res.issues?.length) {
    console.log(res.edge_reachable === false ? "the edge gateway could not be reached" : "no runtime errors recorded");
    return 0;
  }
  for (const issue of res.issues) {
    console.log(`${new Date(issue.lastSeen).toISOString()}  ×${String(issue.count).padStart(4)}  ${issue.kind.padEnd(10)} ${issue.message}${issue.lastEndpoint ? `  [${issue.lastEndpoint}]` : ""}`);
  }
  return 0;
}

async function status(positional) {
  const slug = positional[0];
  if (!slug) throw new Error("usage: jojapi status <slug>");
  const api = client(readConfig());
  const edge = await loadEdge(api, slug);
  console.log(`${slug}: ${edge.mode === "custom" ? "code" : "template"} mode`);
  console.log(`files: ${edge.files.map((f) => `${f.path} (${f.size} B)`).join(", ") || "— (generated from the template)"}`);
  console.log(`variables: ${edge.variables.map((v) => `${v.name} (${v.kind})`).join(", ") || "—"}`);
  console.log(`resources: ${edge.resources.map((r) => `${r.binding} (${r.kind})`).join(", ") || "—"}`);
  console.log(`settings: cpu ${edge.settings.cpuMs ?? "default"} ms, subrequests ${edge.settings.subRequests ?? "default"}, logs ${edge.settings.logs ? "on" : "off"}`);
  return 0;
}

async function deployments(positional, flags) {
  const { slug } = await resolveSlugAndDir(positional.slice(0, 1), flags);
  const api = client(readConfig());
  const res = await api.get("v2/provider-api-edge-deployments", { slug });
  if (res.status !== "success") throw new Error(res.message || res.status);
  console.log(`${res.active} active · ${res.included} included · latest: ${res.preview_url}`);
  for (const d of res.deployments) {
    const flagsText = [d.production && "production", d.previous_production && "previous", d.latest && !d.production && "latest", d.access === "everyone" && "public", d.keep && "kept", d.status !== "active" && d.status].filter(Boolean).join(", ");
    const commit = d.git?.commit ? `${d.git.commit.slice(0, 7)}${d.git.pr ? ` #${d.git.pr}` : ""}` : "";
    console.log(`#${String(d.number).padEnd(4)} ${d.id}  ${new Date(d.created_ts).toISOString().slice(0, 16).replace("T", " ")}  ${(d.source + "/" + d.mode).padEnd(15)} ${commit.padEnd(12)} ${flagsText.padEnd(28)} ${d.message ?? ""}`);
    if (d.status === "failed" && d.error) console.log(`      ${d.error}`);
  }
  return 0;
}

async function promote(positional, flags) {
  // `promote <id>` inside a project directory, or `promote <slug> <id>`
  const [first, second] = positional;
  const id = second ?? first;
  if (!id || !/^[a-z0-9]{8}$/.test(id)) throw new Error("usage: jojapi promote [slug] <deployment id> [--note text]");
  const { slug } = await resolveSlugAndDir(second ? [first] : [], flags);
  const api = client(readConfig());
  const res = await api.post("v2/promote-api-edge-deployment", { slug, deployment: id, note: typeof flags.note === "string" ? flags.note : undefined });
  if (res.status !== "success") {
    console.error(res.message || res.status);
    return 1;
  }
  console.log(`${id} is in production`);
  return 0;
}

async function rollback(positional, flags) {
  const { slug } = await resolveSlugAndDir(positional.slice(0, 1), flags);
  const api = client(readConfig());
  const res = await api.post("v2/rollback-api-edge", { slug, note: typeof flags.note === "string" ? flags.note : undefined });
  if (res.status !== "success") {
    console.error(res.message || res.status);
    return 1;
  }
  console.log(`rolled back: ${res.deployment} is in production`);
  return 0;
}

// ---------------------------------------------------------------------------

async function loadEdge(api, slug) {
  const res = await api.get("v2/provider-api-edge", { slug });
  if (res.status !== "success") throw new Error(res.message || res.status);
  if (!res.edge) throw new Error(`${slug} is not served by the edge gateway yet`);
  return { ...res.edge, files: res.edge.files ?? [], variables: res.edge.variables ?? [], resources: res.edge.resources ?? [], endpoints: res.edge.endpoints ?? [], settings: res.edge.settings ?? {} };
}

// A wrangler.jsonc for local runs: the API's resources as local bindings
function writeWranglerConfig(dir, slug, edge) {
  const config = {
    name: `jojapi-${slug}`,
    main: "index.mjs",
    compatibility_date: "2026-08-15",
    compatibility_flags: ["nodejs_compat"],
  };
  const kv = edge.resources.filter((r) => r.kind === "kv").map((r) => ({ binding: r.binding, id: r.cloudflareId || "local" }));
  const d1 = edge.resources.filter((r) => r.kind === "d1").map((r) => ({ binding: r.binding, database_name: r.cloudflareId || r.binding.toLowerCase(), database_id: r.cloudflareId || "local" }));
  const r2 = edge.resources.filter((r) => r.kind === "r2").map((r) => ({ binding: r.binding, bucket_name: r.cloudflareId || r.binding.toLowerCase() }));
  const queues = edge.resources.filter((r) => r.kind === "queue").map((r) => ({ binding: r.binding, queue: r.cloudflareId || r.binding.toLowerCase() }));
  const dos = edge.resources.filter((r) => r.kind === "do" && r.className).map((r) => ({ name: r.binding, class_name: r.className }));
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
  return createHashHex(text).slice(0, 16);
}

import { createHash } from "node:crypto";
function createHashHex(text) {
  return createHash("sha256").update(text).digest("hex");
}
