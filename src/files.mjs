// The files of an API on disk: which ones are uploaded, and how a project with
// npm dependencies or TypeScript is bundled into the single index.mjs the
// platform accepts (relative imports only, no bare specifiers).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const FILE_PATH = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.(mjs|js|json|txt)$/;
const IGNORED_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist", "build", "src"]);
const IGNORED_FILES = new Set(["jojapi.json", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "wrangler.jsonc", "wrangler.json", "wrangler.toml", "tsconfig.json"]);

// Files that would be uploaded as they are (path → content). `src/` is the
// source of a bundled project and never uploaded directly.
export function collectFiles(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full);
        continue;
      }
      const rel = relative(dir, full).split(sep).join("/");
      if (IGNORED_FILES.has(rel) || rel.startsWith(".dev.vars")) continue;
      if (!FILE_PATH.test(rel)) continue;
      if (rel.split("/").length > 4) continue;
      out[rel] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

// A project needs bundling when it has a src/ entry point (TypeScript or
// modules with npm imports) or dependencies in package.json
export function bundleEntry(dir) {
  for (const candidate of ["src/index.ts", "src/index.mts", "src/index.mjs", "src/index.js"]) {
    if (existsSync(join(dir, candidate))) return candidate;
  }
  return null;
}

export function hasDependencies(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return Object.keys(pkg.dependencies ?? {}).length > 0;
  } catch {
    return false;
  }
}

// esbuild the entry into one ESM file for workerd: platform-neutral, ES2022,
// Cloudflare and Node built-ins stay external (nodejs_compat provides them)
export async function bundle(dir, entry) {
  const { build } = await import("esbuild");
  const result = await build({
    absWorkingDir: dir,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["workerd", "worker", "browser", "module", "main"],
    external: ["cloudflare:*", "node:*"],
    minify: false,
    sourcemap: false,
    legalComments: "none",
  });
  const output = result.outputFiles.find((f) => f.path.endsWith(".js") || f.path.endsWith(".mjs")) ?? result.outputFiles[0];
  return output.text;
}

export function fileSize(dir, rel) {
  try {
    return statSync(join(dir, rel)).size;
  } catch {
    return 0;
  }
}
