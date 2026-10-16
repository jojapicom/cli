// The account a token acts for, and its API keys (the jk_ keys that call the
// APIs it subscribes to). Key values stay out of the terminal unless asked
// for: the platform masks them for a token, `--to-env-file` writes a new key
// to a file without printing it, and only `--reveal` prints one.
//
// Not `--env-file`: Node.js takes that flag (and --env-file-if-exists) from
// anywhere on the command line, also after the script, and either stops when
// the file does not exist or loads the file into the environment.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { text } from "../args.mjs";
import { api, columns, confirmed, printJson, refused, when } from "../context.mjs";

const KEY_ID = /^n[0-9a-f]{8}$/;
const KEY_VALUE = /^jk_[A-Za-z0-9]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The token describes itself (GET v2/management-token)
async function introspect(platform) {
  const res = await platform.get("v2/management-token");
  if (res.status === "method_not_allowed") throw new Error("this platform does not describe tokens yet (GET v2/management-token); update needed on the platform side");
  if (res.status !== "success") throw new Error(res.message || res.status);
  return res;
}

async function whoami(positional, flags) {
  const res = await introspect(api());
  if (flags.json) return printJson(res);
  const { token, account } = res;
  const restriction = (list, label) => (list === null || list === undefined ? `all ${label}` : list.map((item) => item.slug ?? item.name).join(", "));
  const rows = [
    ["account", `@${account.username}${account.name && account.name !== account.username ? ` (${account.name})` : ""}${account.kind && account.kind !== "human" ? ` · ${account.kind}` : ""}`],
    ["token", `${token.name} (jm_…${token.last4})${token.legacy ? " · scopes from before v2: upgrade them in the Studio" : ""}`],
    ["scopes", token.scopes.join(", ")],
    ["APIs", restriction(token.restrictions?.apis, "APIs")],
    ["projects", restriction(token.restrictions?.projects, "projects")],
  ];
  if (token.spend) rows.push(["spend", `$${token.spend.spent_this_month_usd.toFixed(2)} of $${token.spend.limit_usd.toFixed(2)} this month ($${token.spend.remaining_usd.toFixed(2)} left)`]);
  if (res.wallet) rows.push(["wallet", `$${res.wallet.balance_usd.toFixed(2)}`]);
  rows.push(["expires", token.expires_at ? when(token.expires_at) : "never"]);
  console.log(columns(rows));
  return 0;
}

async function keys(positional, flags) {
  const sub = positional[0] ?? "list";
  if (sub === "list") return keysList(positional.slice(1), flags);
  if (sub === "create") return keysCreate(positional.slice(1), flags);
  if (sub === "delete") return keysDelete(positional.slice(1), flags);
  throw new Error(`unknown keys command "${sub}" — list, create or delete`);
}

async function listKeys(platform, reveal) {
  const res = await platform.get("v1/api-keys", reveal ? { reveal: "true" } : {});
  // This route answers status true (an older shape) or "success"
  if (res.status !== true && res.status !== "success") throw new Error(res.message || res.code || String(res.status));
  return res.api_keys ?? [];
}

async function keysList(positional, flags) {
  let list = await listKeys(api(), flags.reveal === true);
  const project = text(flags, "project");
  if (project) list = list.filter((k) => k.project?.id === project || k.project?.name === project);
  if (flags.json) return printJson({ api_keys: list });
  if (!list.length) {
    console.log(project ? `no API keys in ${project}` : "no API keys yet — create one: jojapi keys create");
    return 0;
  }
  console.log(columns([
    ["ID", "LABEL", "PROJECT", "KEY", "APIS", "LAST USED"],
    ...list.map((k) => [
      k.id,
      k.label,
      k.project?.name ?? "",
      k.preview,
      k.restricted_apis === null || k.restricted_apis === undefined ? "all" : k.restricted_apis.map((a) => a.slug).join(", ") || "none",
      k.last_used_at ? when(k.last_used_at) : "never",
    ]),
  ]));
  if (flags.reveal !== true && list.some((k) => k.masked)) console.error("key values are masked: --reveal prints them (the token needs keys:read)");
  return 0;
}

// NAME=value into a dotenv file: replaces the line that sets NAME, else
// appends one. A new file is readable by its owner only.
function writeEnvFile(path, name, value) {
  const line = `${name}=${value}`;
  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return "created";
  }
  const current = readFileSync(path, "utf8");
  const pattern = new RegExp(`^(export\\s+)?${name}=.*$`, "m");
  if (pattern.test(current)) {
    writeFileSync(path, current.replace(pattern, (match, exported) => `${exported ?? ""}${line}`));
    return "replaced";
  }
  writeFileSync(path, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`);
  return "appended";
}

async function keysCreate(positional, flags) {
  if (flags["env-file"] !== undefined) throw new Error("use --to-env-file: Node.js reads --env-file itself and loads that file into the environment");
  const envFile = text(flags, "to-env-file");
  const reveal = flags.reveal === true;
  const envName = text(flags, "env-name") ?? "JOJAPI_KEY";
  if (envFile && reveal) throw new Error("--to-env-file keeps the key off the screen and --reveal prints it: pick one");
  if (!ENV_NAME.test(envName)) throw new Error(`--env-name ${envName}: letters, digits and _ only, not starting with a digit`);
  const platform = api();

  // The value comes back only to a token with keys:read: check before a key
  // is made that could not be written anywhere
  if (envFile || reveal) {
    const me = await introspect(platform);
    if (!me.token.scopes.includes("keys:read")) throw new Error(`${envFile ? "--to-env-file" : "--reveal"} needs a token with the keys:read scope; this one has ${me.token.scopes.join(", ") || "none"}`);
  }

  const body = {};
  const project = text(flags, "project");
  const label = text(flags, "label");
  if (project) body.project = project;
  if (label) body.label = label;
  if (envFile || reveal) body.reveal = true;
  const res = await platform.post("v2/create-api-key", body);
  if (res.status !== "success") return refused(res, flags);

  const value = res.api_key;
  const full = typeof value === "string" && KEY_VALUE.test(value) && res.masked !== true;
  if ((envFile || reveal) && !full) {
    console.error(`key ${res.id ?? ""} was created, but the platform did not return its value, so it was not ${envFile ? `written to ${envFile}` : "printed"}`);
    return 1;
  }

  let written = null;
  if (envFile) written = writeEnvFile(resolve(envFile), envName, value);

  if (flags.json) {
    return printJson({
      status: "success",
      id: res.id ?? null,
      project: res.project ?? null,
      label: label ?? null,
      ...(envFile ? { env_file: resolve(envFile), env_name: envName } : {}),
      ...(reveal ? { api_key: value } : {}),
    });
  }
  console.log(`key ${res.id ?? ""} created${res.project ? ` in ${res.project.name}` : ""}${label ? ` (${label})` : ""}`);
  if (envFile) console.log(`${written === "created" ? "wrote" : written === "replaced" ? "replaced" : "added"} ${envName} in ${envFile}${written === "created" ? " (mode 600)" : ""}`);
  else if (reveal) console.log(value);
  else console.log("the value stays hidden: --to-env-file <path> writes a new key to a file, --reveal prints it");
  return 0;
}

async function keysDelete(positional, flags) {
  const id = positional[0];
  if (!id || positional.length > 1) throw new Error("usage: jojapi keys delete <id> [--yes]");
  if (!KEY_ID.test(id)) throw new Error("pass the key's id from jojapi keys list (n…), never the key itself");
  const platform = api();
  const key = (await listKeys(platform, false)).find((k) => k.id === id);
  if (!key) throw new Error(`no API key ${id} — jojapi keys list shows the ids`);
  const ok = await confirmed(flags, {
    action: `deleting key ${id}`,
    details: `key ${id}${key.label ? ` "${key.label}"` : ""} in ${key.project?.name ?? "its project"}, last used ${key.last_used_at ? when(key.last_used_at) : "never"}: it stops working at once, everywhere`,
    question: `Delete API key ${id}?`,
  });
  if (!ok) return 1;
  const res = await platform.post("v1/delete-api-key", { api_key: { id } });
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson({ status: "success", id });
  console.log(`key ${id} deleted`);
  return 0;
}

export default {
  title: "Account",
  commands: {
    whoami: {
      usage: ["whoami [--json]"],
      summary: "the account the token acts for, its scopes, limits and expiry",
      run: whoami,
    },
    keys: {
      usage: [
        "keys [list] [--project proj_…|name] [--reveal] [--json]",
        "keys create [--project proj_…] [--label text] [--to-env-file path [--env-name JOJAPI_KEY] | --reveal] [--json]",
        "keys delete <id> [--yes]",
      ],
      summary: "the account's API keys: list, create, delete",
      help: "Needs keys:read to list and keys:write to create or delete. Key values are masked: create --to-env-file writes the new key to a dotenv file without printing it (the line JOJAPI_KEY=…, or --env-name; a new file gets mode 600), --reveal prints it; both need keys:read. Agents should prefer --to-env-file, so the key never reaches their transcript. Without --project a key goes to the account's first project. delete takes the id from keys list and asks first.",
      run: keys,
    },
  },
};
