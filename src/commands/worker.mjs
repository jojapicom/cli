// What the Worker is bound to and how it runs: storage and queues (and their
// shares), variables, settings, compute usage and the template/code mode.

import { describeDeploy } from "../api.mjs";
import { api, columns, confirmed, loadEdge, ok, printJson, readSecret, refused, slugAndArgs } from "../context.mjs";

const RESOURCE_KINDS = ["kv", "d1", "r2", "queue", "do", "shared"];
const RESOURCE_LABELS = { kv: "key-value store", d1: "database", r2: "bucket", queue: "queue" };

// A save deploys like any other save: a preview, or with --prod production's
// snapshot with only this change (other pending changes then get a preview of
// their own)
function reportSave(headline, deploy, flags = {}) {
  const failed = deploy?.status === "error" || deploy?.status === "needs_code";
  if (flags.json) {
    printJson({ status: failed ? "failed" : "success", message: headline, deploy: deploy ?? null });
    return failed ? 1 : 0;
  }
  const result = describeDeploy(deploy);
  console.log(result ? `${headline} — ${result}` : headline);
  if (deploy?.preview) console.log(`other pending changes: ${describeDeploy(deploy.preview)}`);
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Resources

async function resources(positional, flags) {
  const [action, ...rest] = positional;
  switch (action) {
    case "add": return resourceAdd(rest, flags);
    case "remove": return resourceRemove(rest, flags);
    case "share": return resourceShare(rest, flags);
    case "revoke": return shareAnswer("revoke", rest, flags);
    case "accept": return shareAnswer("accept", rest, flags);
    case "decline": return shareAnswer("decline", rest, flags);
    default: return resourceList(positional, flags);
  }
}

async function resourceList(positional, flags) {
  const { slug } = slugAndArgs(positional, flags, 0, "resources [slug]");
  const platform = api();
  const edge = await loadEdge(platform, slug);
  const shares = ok(await platform.get("v2/provider-api-edge-shares", { slug }));
  if (flags.json) return printJson({ resources: edge.resources, outgoing: shares.outgoing ?? [], incoming: shares.incoming ?? [] });

  const grantees = new Map((shares.outgoing ?? []).map((o) => [o.binding, o.shares.filter((s) => s.status === "active").map((s) => s.target.slug)]));
  if (!edge.resources.length) console.log("no resources — add one: jojapi resources add <kv|d1|r2|queue|do> <BINDING>");
  const rows = edge.resources.map((r) => {
    let detail;
    if (r.kind === "shared") {
      detail = r.shared ? `${r.shared.kind} ${r.shared.name} from ${r.shared.owner.slug} (${r.shared.owner.account})${r.shared.status === "active" ? "" : `, ${r.shared.status}`}` : "the grant no longer exists";
    } else {
      const usedBy = grantees.get(r.binding) ?? [];
      detail = [r.className && `class ${r.className}`, usedBy.length && `shared with ${usedBy.join(", ")}`].filter(Boolean).join(" · ");
    }
    if (r.status === "removed") detail = `removed — deleted once no active deployment binds it${r.error ? `: ${r.error}` : ""}`;
    return [r.binding, r.kind, detail];
  });
  if (rows.length) console.log(columns(rows));

  const incoming = shares.incoming ?? [];
  if (incoming.length) {
    console.log("\nshared with this API:");
    for (const s of incoming) {
      const what = `${s.kind} ${s.name}${s.class_name ? ` (class ${s.class_name})` : ""} from ${s.owner.slug} (${s.owner.account})`;
      const state = s.status === "pending"
        ? `invitation — jojapi resources accept ${s.share}, or decline`
        : s.bindings.length ? `bound as ${s.bindings.join(", ")}` : `bind it: jojapi resources add shared <BINDING> --share ${s.share}`;
      console.log(`  ${s.share}  ${what}  ${state}`);
    }
  }
  return 0;
}

async function resourceAdd(positional, flags) {
  const usage = "resources add [slug] <kv|d1|r2|queue|do|shared> <BINDING> [--class Name] [--share id] [--prod]";
  const { slug, args: [kind, binding] } = slugAndArgs(positional, flags, 2, usage);
  if (!RESOURCE_KINDS.includes(kind)) throw new Error(`usage: jojapi ${usage}`);
  if (kind === "do" && typeof flags.class !== "string") throw new Error("a Durable Object needs the class your code exports: --class Name");
  if (kind === "shared" && typeof flags.share !== "string") throw new Error("pass the grant to bind: --share id (listed by jojapi resources)");

  const payload = { slug, kind, binding };
  if (kind === "do") payload.class_name = flags.class;
  if (kind === "shared") payload.share_id = flags.share;
  if (flags.prod === true) payload.production = true;
  const res = await api().post("v2/update-api-edge-resource", payload);
  if (res.status !== "success") return refused(res, flags);
  return reportSave(`${binding.toUpperCase()} (${kind}): ${res.message}`, res.deploy, flags);
}

async function resourceRemove(positional, flags) {
  const { slug, args: [name] } = slugAndArgs(positional, flags, 1, "resources remove [slug] <BINDING> [--prod] [--yes]");
  const binding = name.toUpperCase();
  const platform = api();

  if (flags.yes !== true) {
    const edge = await loadEdge(platform, slug);
    const resource = edge.resources.find((r) => r.binding === binding && r.status !== "removed");
    if (!resource) throw new Error(`${slug} has no resource bound as ${binding}`);
    const when = flags.prod === true ? "Production loses the binding at once." : "The binding leaves a new preview; production keeps it until you deploy.";
    const effect = resource.kind === "shared"
      ? `The resource and its data stay with ${resource.shared?.owner.slug ?? "its owner"}.`
      : resource.kind === "do"
        ? "The class stays in your code; the objects' storage is deleted once no active deployment binds it. This cannot be undone."
        : `The ${RESOURCE_LABELS[resource.kind]} and all data in it are deleted once no active deployment binds it${resource.kind === "r2" ? "; it must be empty by then" : ""}. This cannot be undone.`;
    const go = await confirmed(flags, { action: `removing ${binding}`, details: `${when}\n${effect}`, question: `${resource.kind === "shared" ? "Unbind" : "Remove"} ${binding} from ${slug}?` });
    if (!go) return 1;
  }

  const payload = { slug, binding };
  if (flags.prod === true) payload.production = true;
  const res = await platform.post("v2/delete-api-edge-resource", payload);
  if (res.status !== "success") return refused(res, flags);
  return reportSave(`${binding}: ${res.message}`, res.deploy, flags);
}

// One of the account's own APIs gets the grant at once (--as binds it there
// in the same step); another account's API gets an invitation
async function resourceShare(positional, flags) {
  const { slug, args: [binding, target] } = slugAndArgs(positional, flags, 2, "resources share [slug] <BINDING> <target API slug> [--as BINDING]");
  const payload = { slug, binding: binding.toUpperCase(), target_slug: target };
  if (typeof flags.as === "string") payload.target_binding = flags.as;
  const res = await api().post("v2/share-api-edge-resource", payload);
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson(res);
  console.log(`${payload.binding} → ${target}: ${res.message}${res.share?.share ? ` (grant ${res.share.share})` : ""}`);
  if (res.deploy) console.log(`  ${target}: ${describeDeploy(res.deploy)}`);
  return 0;
}

const SHARE_ACTIONS = {
  revoke: {
    route: "v2/revoke-api-edge-share",
    confirm: {
      details: "The other API's production and active deployments are re-released without the binding at once; calls through it then fail in its code. You can share again later.",
      question: "Revoke this grant?",
    },
  },
  accept: { route: "v2/accept-api-edge-share" },
  decline: { route: "v2/decline-api-edge-share" },
};

async function shareAnswer(action, positional, flags) {
  if (positional.length !== 1) throw new Error(`usage: jojapi resources ${action} <grant id>${action === "revoke" ? " [--yes]" : ""}`);
  const [shareId] = positional;
  const { route, confirm } = SHARE_ACTIONS[action];
  if (confirm && !(await confirmed(flags, { action: `revoking ${shareId}`, ...confirm }))) return 1;
  const res = await api().post(route, { share_id: shareId });
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson(res);
  console.log(`${shareId}: ${res.message}`);
  if (action === "accept") console.log(`bind it: jojapi resources add shared <BINDING> --share ${shareId}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Variables

const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

async function vars(positional, flags) {
  const [action, ...rest] = positional;
  if (action === "set") return varSet(rest, flags);
  if (action === "unset") return varUnset(rest, flags);
  const { slug } = slugAndArgs(positional, flags, 0, "vars [slug]");
  const edge = await loadEdge(api(), slug);
  if (flags.json) return printJson({ variables: edge.variables });
  if (!edge.variables.length) {
    console.log("no variables — set one: jojapi vars set NAME=value, or jojapi vars set NAME --secret");
    return 0;
  }
  console.log(columns(edge.variables.map((v) => [v.name, v.kind, v.kind === "secret" ? "••••••" : v.value ?? ""])));
  return 0;
}

// `NAME=value` sets a plain value; `NAME --secret` reads the secret from a
// prompt or stdin, never from the command line
async function varSet(positional, flags) {
  const usage = "vars set [slug] NAME=value | NAME --secret [--prod]";
  const { slug, args: [assignment] } = slugAndArgs(positional, flags, 1, usage);
  const eq = assignment.indexOf("=");
  const name = (eq === -1 ? assignment : assignment.slice(0, eq)).toUpperCase();
  if (!VARIABLE_NAME.test(name)) throw new Error("variable names use letters, digits and underscores and start with a letter");
  const platform = api();
  const existing = (await loadEdge(platform, slug)).variables.find((v) => v.name === name);

  let kind;
  let value;
  if (flags.secret === true) {
    if (eq !== -1) throw new Error("a secret value on the command line stays in the shell history: run jojapi vars set NAME --secret and type it, or pipe it in");
    kind = "secret";
    value = await readSecret(`${name} (secret, not shown): `);
    if (value === "") throw new Error("no value given: nothing changed");
  } else {
    if (eq === -1) throw new Error(`usage: jojapi ${usage}`);
    kind = "plain";
    value = assignment.slice(eq + 1);
    if (existing?.kind === "secret") {
      const go = await confirmed(flags, { action: `storing ${name} as a plain value`, details: `${name} is a secret now; a plain value is shown to anyone with access to this API in the Studio.`, question: `Store ${name} as a plain value?` });
      if (!go) return 1;
    }
  }

  const payload = { slug, name, kind, value };
  if (flags.prod === true) payload.production = true;
  const res = await platform.post("v2/update-api-variable", payload);
  if (res.status !== "success") return refused(res, flags);
  return reportSave(`${name} (${kind}): ${res.message}`, res.deploy, flags);
}

async function varUnset(positional, flags) {
  const { slug, args: [given] } = slugAndArgs(positional, flags, 1, "vars unset [slug] NAME [--prod] [--yes]");
  const name = given.toUpperCase();
  const platform = api();
  if (flags.yes !== true) {
    const variable = (await loadEdge(platform, slug)).variables.find((v) => v.name === name);
    if (!variable) throw new Error(`${slug} has no variable ${name}`);
    const when = flags.prod === true ? "Production loses it at once" : "It leaves a new preview; production keeps it until you deploy";
    const details = `${when}, and code that reads env.${name} then sees undefined.${variable.kind === "secret" ? " A secret's value cannot be read back; older deployments keep their copy." : ""}`;
    if (!(await confirmed(flags, { action: `deleting ${name}`, details, question: `Delete ${name} from ${slug}?` }))) return 1;
  }
  const payload = { slug, name };
  if (flags.prod === true) payload.production = true;
  const res = await platform.post("v2/delete-api-variable", payload);
  if (res.status !== "success") return refused(res, flags);
  return reportSave(`${name}: ${res.message}`, res.deploy, flags);
}

// ---------------------------------------------------------------------------
// Settings, compute usage, mode

async function settings(positional, flags) {
  const { slug } = slugAndArgs(positional, flags, 0, "settings [slug] [--logs on|off]");
  const platform = api();
  if (flags.logs === undefined) {
    const edge = await loadEdge(platform, slug);
    if (flags.json) return printJson({ settings: edge.settings });
    console.log(columns([
      ["console logging", edge.settings.logs ? "on" : "off"],
      ["CPU per request", edge.settings.cpuMs ? `${edge.settings.cpuMs} ms` : "platform default"],
      ["subrequests", edge.settings.subRequests ?? "platform default"],
    ]));
    return 0;
  }
  if (flags.logs !== "on" && flags.logs !== "off") throw new Error("--logs on or --logs off");
  const res = await platform.post("v2/update-api-edge-settings", { slug, logs: flags.logs === "on" });
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson(res);
  console.log(res.message);
  if (flags.logs === "on") console.log("each request now costs a little more to process (compute usage: console logging); read them with jojapi logs --follow");
  // Saved even when the running deployments could not be refreshed yet
  if (res.deploy?.status === "error") {
    console.error(`the running deployments were not updated yet: ${res.deploy.message}`);
    return 1;
  }
  return 0;
}

async function usage(positional, flags) {
  const { slug } = slugAndArgs(positional, flags, 0, "usage [slug] [--days 30]");
  const res = ok(await api().get("v2/provider-api-edge-compute", { slug, days: typeof flags.days === "string" ? flags.days : undefined }));
  if (flags.json) return printJson(res);
  console.log(`${slug} · ${res.from} → ${res.to} · informational, nothing is charged for compute today`);
  if (!res.metrics?.length) {
    console.log("no usage recorded");
    return 0;
  }
  const number = (n) => Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
  console.log(columns([
    ["METRIC", "USED", "INCLUDED", "BILLABLE", "LIST PRICE"],
    ...res.metrics.map((m) => [m.label, `${number(m.units)} ${m.unit ?? ""}`.trim(), number(m.included), number(m.billable_units), `$${Number(m.cost_usd ?? 0).toFixed(2)}`]),
    ["estimate", "", "", "", `$${Number(res.estimated_cost_usd ?? 0).toFixed(2)}`],
  ]));
  for (const other of res.shared_with ?? []) console.log(`includes ${other.name} (${other.account?.nick ?? other.account?.name ?? ""}) using ${other.resources.join(", ")}`);
  return 0;
}

async function mode(positional, flags) {
  const { slug, args: [target] } = slugAndArgs(positional, flags, 1, "mode [slug] <code|template> [--prod] [--yes]");
  if (target !== "code" && target !== "template") throw new Error("usage: jojapi mode [slug] <code|template> [--prod] [--yes]");
  const platform = api();
  const edge = await loadEdge(platform, slug);
  if ((edge.mode === "custom") === (target === "code")) {
    console.log(`${slug} is already in ${target} mode`);
    return 0;
  }
  if (target === "template") {
    const details = `The files are deleted from the working copy and the Worker is generated from the template again; nothing is carried over from the code (keep a copy: jojapi pull ${slug}). ${flags.prod === true ? "Production runs the template at once." : "Production keeps running your code until you deploy the preview."}`;
    if (!(await confirmed(flags, { action: "going back to the template", details, question: `Back to the template for ${slug}?` }))) return 1;
  }
  const payload = { slug, mode: target };
  if (flags.prod === true) payload.production = true;
  const res = await platform.post("v2/update-api-edge-mode", payload);
  if (res.status !== "success") return refused(res, flags);
  return reportSave(res.message, res.deploy, flags);
}

export default {
  title: "Worker",
  commands: {
    resources: {
      usage: [
        "resources [slug] [--json]",
        "resources add [slug] <kv|d1|r2|queue|do> <BINDING> [--class Name] [--prod]",
        "resources add [slug] shared <BINDING> --share <id> [--prod]",
        "resources remove [slug] <BINDING> [--prod] [--yes]",
        "resources share [slug] <BINDING> <target API slug> [--as BINDING]",
        "resources revoke <grant id> [--yes]",
        "resources accept <grant id>",
        "resources decline <grant id>",
      ],
      summary: "storage and queues bound to the Worker, and their shares",
      help: "add creates a key-value store (kv), SQL database (d1), object storage bucket (r2), queue or Durable Object class (do; --class names the class your code exports) for this API alone and binds it as env.BINDING; kind shared binds a resource another API shares with this one (the grant id comes from `jojapi resources`). Like every save it becomes a preview deployment; --prod puts only this change into production.\nremove asks first (--yes skips the question and is required without a terminal). The resource and its data are deleted once no active deployment binds it, so a rollback still finds it; unbinding a shared resource leaves it with its owner.\nshare grants a resource to another API: one of your own gets it at once (--as binds it there right away), another account's API gets an invitation it accepts (accept, decline) before it binds the resource. revoke re-releases the other API without the binding at once.",
      run: resources,
    },
    vars: {
      usage: [
        "vars [slug] [--json]",
        "vars set [slug] NAME=value [--prod]",
        "vars set [slug] NAME --secret [--prod]",
        "vars unset [slug] NAME [--prod] [--yes]",
      ],
      summary: "variables and secrets bound to the Worker as env.NAME",
      help: "A secret is typed at a prompt that does not echo it, or piped in (printf %s \"$TOKEN\" | jojapi vars set TOKEN --secret); it is encrypted at rest and never shown again. Every change is a preview deployment; --prod puts only this change into production at once, for example to rotate a leaked key. unset asks first (--yes skips the question).",
      run: vars,
    },
    settings: {
      usage: ["settings [slug] [--json]", "settings [slug] --logs on|off"],
      summary: "console logging and the Worker's limits",
      help: "Console logging applies at once to production and every active deployment (it is not a deployment). While it is on, each request costs a little more to process.",
      run: settings,
    },
    usage: {
      usage: ["usage [slug] [--days 30] [--json]"],
      summary: "compute the Worker and its storage used, with the included allowance",
      run: usage,
    },
    mode: {
      usage: ["mode [slug] <code|template> [--prod] [--yes]"],
      summary: "take the generated code over, or go back to the template",
      help: "code stores the files the Worker runs now as yours; the template no longer applies. template deletes your files from the working copy and generates the Worker from the template again (it asks first; --yes skips the question). Both are a preview deployment unless --prod.",
      run: mode,
    },
  },
};
