// CLI configuration: the management token and the Studio base URL, stored at
// ~/.config/jojapi/config.json (mode 0600). Environment variables win:
// JOJAPI_TOKEN, JOJAPI_BASE.

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE = "https://app.jojapi.com";

export function configPath() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jojapi", "config.json");
}

export function readConfig() {
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    stored = {};
  }
  return {
    token: process.env.JOJAPI_TOKEN || stored.token || "",
    base: (process.env.JOJAPI_BASE || stored.base || DEFAULT_BASE).replace(/\/$/, ""),
  };
}

export function writeConfig(config) {
  const path = configPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

// The project file next to the code: which API these files belong to
export const PROJECT_FILE = "jojapi.json";

export function readProject(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, PROJECT_FILE), "utf8"));
  } catch {
    return null;
  }
}

export function writeProject(dir, project) {
  writeFileSync(join(dir, PROJECT_FILE), JSON.stringify(project, null, 2) + "\n");
}
