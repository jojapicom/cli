// The marketplace listing: the API's details, its endpoints and groups, FAQs
// and the billable objects its endpoints and plans count.

import { readFileSync } from "node:fs";
import { text } from "../args.mjs";
import { api, columns, confirmed, ok, printJson, refused, slugAndArgs, when } from "../context.mjs";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const DIMENSIONS = ["requests", "ai_tokens", "compute_time", "bandwidth", "storage", "media_units", "other"];

// `GET /users/{id}` as two arguments
function endpointRef(method, path) {
  const upper = String(method).toUpperCase();
  if (!METHODS.includes(upper) || !String(path).startsWith("/")) throw new Error(`an endpoint is a method (${METHODS.join(", ")}) and a path starting with /, e.g. GET /users/{id}`);
  return { method: upper, url_path: path };
}

async function loadApi(platform, slug) {
  return ok(await platform.get("v2/provider-api", { slug })).api;
}

async function loadEndpoint(platform, slug, ref) {
  return ok(await platform.get("v2/provider/api-endpoint", { slug, ...ref })).endpoint;
}

// Endpoints in the order the Studio shows them: ungrouped first, then groups
function orderedEndpoints(a) {
  return (a.endpoint_groups ?? []).flatMap((g) => [...g.endpoints].sort((x, y) => (x.order ?? 0) - (y.order ?? 0)).map((e) => ({ ...e, group: g.ungrouped ? null : g.name })));
}

function billingText(e) {
  return (e.billing ?? []).filter((b) => b.kind !== "none").map((b) => `${b.kind === "fixed" ? b.cost : b.kind === "default" ? "default" : "metered"} ${b.slug}`).join(", ");
}

// ---------------------------------------------------------------------------
// The API

const MARKETPLACE_NOTE = {
  private: "only you can see it",
  unlisted: "anyone with the link can see and subscribe; not in search",
  pending: "in review for the marketplace",
  approved: "listed on the marketplace",
};

async function info(positional, flags) {
  const { slug } = slugAndArgs(positional, flags, 0, "info [slug]");
  const a = await loadApi(api(), slug);
  if (flags.json) return printJson({ api: a });
  const endpoints = a.endpoints ?? [];
  const status = a.marketplace_status ?? "private";
  console.log(`${a.name} (${a.slug})`);
  if (a.description) console.log(a.description);
  console.log("");
  console.log(columns([
    ["marketplace", `${status}${MARKETPLACE_NOTE[status] ? ` — ${MARKETPLACE_NOTE[status]}` : ""}${a.marketplace_reason ? ` (${a.marketplace_reason})` : ""}`],
    ...(a.warned_at ? [["warning", `${a.warning_reason ?? ""} — fix before ${when(a.warning_deadline_at)}${a.warning_resubmitted_at ? ", resubmitted" : ", then jojapi resubmit"}`]] : []),
    ["requests", a.blocked ? "off — the gateway rejects every call" : "on"],
    ["gateway", `${a.edge ? "edge" : "classic"}${(a.gateways ?? []).length ? ` · ${a.gateways.map((g) => g.sub).join(", ")}` : ""}`],
    ["endpoints", `${endpoints.length} (${endpoints.filter((e) => e.hidden).length} hidden from docs, ${endpoints.filter((e) => e.blocked).length} with requests off) in ${(a.endpoint_groups ?? []).filter((g) => !g.ungrouped).length} group(s)`],
    ["agent payments", a.agent_request_enabled ? "on" : "off"],
    ...(a.import_source ? [["imported from", `${a.import_source.url ?? a.import_source.type} (${when(a.import_source.last_imported_at)})`]] : []),
    ["about", a.about ? `${a.about.length} characters` : "—"],
  ]));
  return 0;
}

async function create(positional, flags) {
  if (positional.length > 1 || typeof flags.name !== "string") throw new Error('usage: jojapi create [slug] --name "Name" [--description text]');
  const payload = { name: flags.name, description: text(flags, "description") ?? "" };
  if (positional[0]) payload.slug = positional[0];
  const res = await api().post("v2/provider/add-api", payload);
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson({ status: "success", slug: res.slug });
  console.log(`${res.slug} created (private)`);
  console.log(`next: jojapi import ${res.slug} openapi.yaml, or jojapi endpoints add ${res.slug} GET /path --name "…"`);
  return 0;
}

// update-api-details replaces every field: what is not given is sent as it is
async function update(positional, flags) {
  const { slug } = slugAndArgs(positional, flags, 0, "update [slug] [--name] [--description] [--logo file.png] [--requests on|off] [--marketplace private|unlisted|public] [--about-file file.md]");
  const platform = api();
  const a = await loadApi(platform, slug);
  const stored = a.marketplace_status;
  const current = stored === "approved" || stored === "pending" ? "public" : stored === "unlisted" ? "unlisted" : "private";
  const marketplace = text(flags, "marketplace") ?? current;
  if (!["private", "unlisted", "public"].includes(marketplace)) throw new Error("--marketplace is private, unlisted or public");
  const requests = text(flags, "requests");
  if (requests !== undefined && requests !== "on" && requests !== "off") throw new Error("--requests on or --requests off");
  const logoFile = text(flags, "logo");
  const aboutFile = text(flags, "about-file");
  const detailsChange = ["name", "description", "logo", "requests", "marketplace"].some((name) => flags[name] !== undefined);
  if (!detailsChange && aboutFile === undefined) throw new Error("nothing to update: pass --name, --description, --logo, --requests, --marketplace or --about-file");

  if (detailsChange) {
    if (current === "public" && marketplace !== "public") {
      const go = await confirmed(flags, { action: "leaving the marketplace", details: "Leaving Public delists your API from the marketplace; going Public again goes through review.", question: `Delist ${slug}?` });
      if (!go) return 1;
    }
    if (requests === "off") {
      const go = await confirmed(flags, { action: "turning requests off", details: "The gateway rejects every call to this API until you turn requests on again.", question: `Turn requests off for ${slug}?` });
      if (!go) return 1;
    }
    const payload = {
      slug,
      name: text(flags, "name") ?? a.name,
      description: text(flags, "description") ?? a.description ?? "",
      // "" keeps the stored logo; otherwise a PNG as base64
      logo: logoFile ? readFileSync(logoFile).toString("base64") : "",
      blocked: requests === undefined ? a.blocked === true : requests === "off",
      marketplace_status: marketplace,
    };
    const res = await platform.post("v2/update-api-details", payload);
    if (res.status !== "success") return refused(res, flags);
    if (!flags.json) {
      console.log(res.message);
      if (marketplace === "public" && current !== "public") console.log(`marketplace: ${res.marketplace_status} — the review starts now`);
    }
  }
  if (aboutFile !== undefined) {
    const res = await platform.post("v2/update-api-about", { slug, about: readFileSync(aboutFile, "utf8") });
    if (res.status !== "success") return refused(res, flags);
    if (!flags.json) console.log(res.message);
  }
  if (flags.json) printJson({ status: "success" });
  return 0;
}

async function resubmit(positional, flags) {
  const { slug } = slugAndArgs(positional, flags, 0, "resubmit [slug]");
  const res = await api().post("v2/provider/listing-resubmit", { slug });
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson(res);
  console.log(res.message);
  return 0;
}

// ---------------------------------------------------------------------------
// Endpoints

async function endpoints(positional, flags) {
  const [action, ...rest] = positional;
  const handler = ENDPOINT_ACTIONS[action];
  if (handler) return handler(rest, flags);
  const { slug } = slugAndArgs(positional, flags, 0, "endpoints [slug]");
  const a = await loadApi(api(), slug);
  const list = orderedEndpoints(a);
  if (flags.json) return printJson({ endpoints: list, groups: (a.endpoint_groups ?? []).filter((g) => !g.ungrouped).map((g) => ({ name: g.name, description: g.description })) });
  if (!list.length) {
    console.log(`no endpoints — add one: jojapi endpoints add GET /path --name "…", or import an OpenAPI document: jojapi import openapi.yaml`);
    return 0;
  }
  // One table across groups (aligned), with each group's heading above its rows
  const lines = columns(list.map((e) => [`  ${e.method}`, e.url_path, e.name, [e.blocked && "requests off", e.hidden && "hidden"].filter(Boolean).join(", "), billingText(e), e.agent_price ? `agent $${e.agent_price}` : ""])).split("\n");
  const out = [];
  list.forEach((e, i) => {
    if (i === 0 || e.group !== list[i - 1].group) out.push(`${i === 0 ? "" : "\n"}${e.group ?? "Ungrouped"}`);
    out.push(lines[i]);
  });
  console.log(out.join("\n"));
  return 0;
}

async function endpointShow(positional, flags) {
  const { slug, args } = slugAndArgs(positional, flags, 2, "endpoints show [slug] <METHOD> <path>");
  const e = await loadEndpoint(api(), slug, endpointRef(...args));
  if (flags.json) return printJson({ endpoint: e });
  console.log(`${e.method} ${e.url_path} — ${e.name}`);
  if (e.description) console.log(e.description);
  console.log(`\nrequests ${e.blocked ? "off" : "on"} · ${e.hidden ? "hidden from docs" : "in docs"}`);
  console.log(`billing: ${e.consumptions?.length ? e.consumptions.map((c) => `${c.slug} ${c.cost === "" ? `(object default: ${c.object_default_used_logic || "nothing"})` : c.cost}${c.label ? ` "${c.label}"` : ""}`).join("; ") : "free (no billable object)"}`);
  const param = (p) => [`  ${p.key}`, p.value_type ?? "string", p.required ? "required" : "", p.example ? `e.g. ${p.example}` : "", p.description ?? ""];
  const path = e.path_parameters ?? [];
  const query = (e.parameters ?? []).filter((p) => p.type === "url");
  const headers = (e.parameters ?? []).filter((p) => p.type === "header");
  const form = (e.parameters ?? []).filter((p) => p.type === "post");
  const body = (e.parameters ?? []).find((p) => p.type === "body");
  for (const [title, rows] of [["path parameters", path], ["query parameters", query], ["headers", headers], ["form body", form]]) {
    if (rows.length) console.log(`\n${title}:\n${columns(rows.map(param))}`);
  }
  if (body) console.log(`\nJSON body${body.schema ? " (with schema)" : ""}:\n  ${String(body.example ?? "").slice(0, 400)}`);
  if (e.responses?.length) {
    console.log("\nresponses:");
    console.log(columns(e.responses.map((r) => [`  ${r.status ?? r.status_code}`, r.description ?? "", r.schema ? "schema" : "", (r.examples ?? []).map((x) => x.name).join(", ")])));
  }
  return 0;
}

async function endpointAdd(positional, flags) {
  const { slug, args } = slugAndArgs(positional, flags, 2, 'endpoints add [slug] <METHOD> <path> --name "Name" [--description text]');
  if (typeof flags.name !== "string") throw new Error('usage: jojapi endpoints add [slug] <METHOD> <path> --name "Name" [--description text]');
  const ref = endpointRef(...args);
  const res = await api().post("v2/provider/add-endpoint", { slug, ...ref, name: flags.name, description: text(flags, "description") ?? "" });
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson({ status: "success", endpoint: ref });
  console.log(`${ref.method} ${ref.url_path} added (requests on, in docs, free until you bill it: jojapi billing)`);
  return 0;
}

// update-endpoint-details replaces the endpoint's details and billing: the
// stored billing is sent back as it is so nothing but the change moves
async function saveEndpoint(platform, slug, e, change) {
  return platform.post("v2/provider/update-endpoint-details", {
    slug,
    method: e.method,
    url_path: e.url_path,
    name: e.name,
    description: e.description ?? "",
    blocked: e.blocked === true,
    hidden: e.hidden === true,
    consumptions: (e.consumptions ?? []).map((c) => ({ id: c.id, cost: c.cost ?? "", label: c.label ?? "" })),
    ...change,
  });
}

async function endpointUpdate(positional, flags) {
  const { slug, args } = slugAndArgs(positional, flags, 2, 'endpoints update [slug] <METHOD> <path> [--name "Name"] [--description text]');
  const change = {};
  if (typeof flags.name === "string") change.name = flags.name;
  if (typeof flags.description === "string") change.description = flags.description;
  if (!Object.keys(change).length) throw new Error("nothing to update: pass --name or --description");
  const platform = api();
  const e = await loadEndpoint(platform, slug, endpointRef(...args));
  const res = await saveEndpoint(platform, slug, e, change);
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson({ status: "success" });
  console.log(`${e.method} ${e.url_path} updated`);
  return 0;
}

const VISIBILITY = {
  hide: { change: { hidden: true }, done: "hidden from the API page, the OpenAPI document and MCP tools (the gateway still serves it)" },
  unhide: { change: { hidden: false }, done: "back in the docs" },
  disable: { change: { blocked: true }, done: "requests off: the gateway rejects calls to it within about a minute (it stays documented)" },
  enable: { change: { blocked: false }, done: "requests on" },
};

function endpointToggle(action) {
  return async (positional, flags) => {
    const { slug, args } = slugAndArgs(positional, flags, 2, `endpoints ${action} [slug] <METHOD> <path>`);
    const ref = endpointRef(...args);
    if (action === "disable") {
      const go = await confirmed(flags, { action: `turning requests off for ${ref.method} ${ref.url_path}`, details: "Consumers calling it get an error until you enable it again.", question: `Turn requests off for ${ref.method} ${ref.url_path}?` });
      if (!go) return 1;
    }
    const platform = api();
    const e = await loadEndpoint(platform, slug, ref);
    const res = await saveEndpoint(platform, slug, e, VISIBILITY[action].change);
    if (res.status !== "success") return refused(res, flags);
    if (flags.json) return printJson({ status: "success" });
    console.log(`${e.method} ${e.url_path} ${VISIBILITY[action].done}`);
    return 0;
  };
}

async function endpointDelete(positional, flags) {
  const { slug, args } = slugAndArgs(positional, flags, 2, "endpoints delete [slug] <METHOD> <path> [--yes]");
  const ref = endpointRef(...args);
  const go = await confirmed(flags, { action: `deleting ${ref.method} ${ref.url_path}`, details: "API consumers can no longer call it, and this cannot be undone. You can create an endpoint with the same method and path afterwards.", question: `Delete ${ref.method} ${ref.url_path} from ${slug}?` });
  if (!go) return 1;
  const res = await api().post("v2/provider/delete-endpoint", { slug, ...ref });
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson({ status: "success" });
  console.log(`${ref.method} ${ref.url_path} deleted`);
  return 0;
}

async function endpointDuplicate(positional, flags) {
  const { slug, args } = slugAndArgs(positional, flags, 4, "endpoints duplicate [slug] <METHOD> <path> <new METHOD> <new path>");
  const from = endpointRef(args[0], args[1]);
  const to = endpointRef(args[2], args[3]);
  const res = await api().post("v2/provider/duplicate-endpoint", { slug, source_method: from.method, source_url_path: from.url_path, method: to.method, url_path: to.url_path });
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson(res);
  console.log(`${to.method} ${to.url_path} created as a copy of ${from.method} ${from.url_path} (details, billing, parameters, responses, group)`);
  return 0;
}

// Moves the endpoint, then puts it last in its new group (the order is one
// list across all groups that must name every endpoint)
async function endpointMove(positional, flags) {
  const usage = "endpoints move [slug] <METHOD> <path> <group | --ungrouped>";
  const count = flags.ungrouped === true ? 2 : 3;
  const { slug, args } = slugAndArgs(positional, flags, count, usage);
  const ref = endpointRef(args[0], args[1]);
  const group = flags.ungrouped === true ? null : args[2];
  const platform = api();
  const res = await platform.post("v2/move-endpoint-to-group", { slug, ...ref, group_name: group ?? "Ungrouped Endpoints", ungrouped: group === null });
  if (res.status !== "success") return refused(res, flags);
  const a = await loadApi(platform, slug);
  const list = orderedEndpoints(a);
  const moved = list.find((e) => e.method === ref.method && e.url_path === ref.url_path);
  const rest = list.filter((e) => e !== moved);
  const lastOfGroup = rest.map((e) => e.group).lastIndexOf(group);
  const position = lastOfGroup === -1 ? (group === null ? 0 : rest.length) : lastOfGroup + 1;
  if (moved) rest.splice(position, 0, moved);
  const orders = await platform.post("v2/update-endpoint-orders", { slug, orders: rest.map((e) => ({ method: e.method, url_path: e.url_path })) });
  if (orders.status !== "success") return refused(orders, flags);
  if (flags.json) return printJson({ status: "success" });
  console.log(`${ref.method} ${ref.url_path} moved to ${group ?? "Ungrouped"}`);
  return 0;
}

async function endpointExample(positional, flags) {
  const usage = "endpoints example [slug] <METHOD> <path> <status> <name> --file example.json [--summary text] [--overwrite]";
  const { slug, args } = slugAndArgs(positional, flags, 4, usage);
  const file = text(flags, "file");
  if (!file) throw new Error(`usage: jojapi ${usage}`);
  const example = readFileSync(file, "utf8");
  JSON.parse(example);
  const ref = endpointRef(args[0], args[1]);
  const payload = { slug, ...ref, status: args[2], name: args[3], example };
  if (text(flags, "summary")) payload.summary = text(flags, "summary");
  if (text(flags, "description")) payload.example_description = text(flags, "description");
  if (flags.overwrite === true || flags.overwrite === "true") payload.overwrite = true;
  const res = await api().post("v2/upsert-endpoint-response", payload);
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson(res);
  console.log(`example "${args[3]}" stored on the ${args[2]} response of ${ref.method} ${ref.url_path}`);
  return 0;
}

const ENDPOINT_ACTIONS = {
  show: endpointShow,
  add: endpointAdd,
  update: endpointUpdate,
  hide: endpointToggle("hide"),
  unhide: endpointToggle("unhide"),
  disable: endpointToggle("disable"),
  enable: endpointToggle("enable"),
  delete: endpointDelete,
  duplicate: endpointDuplicate,
  move: endpointMove,
  example: endpointExample,
};

// ---------------------------------------------------------------------------
// Groups

async function groups(positional, flags) {
  const [action, ...rest] = positional;
  const platform = api();
  if (action === "add") {
    const { slug, args: [name] } = slugAndArgs(rest, flags, 1, "groups add [slug] <name> [--description text]");
    const res = await platform.post("v2/create-api-endpoint-group", { slug, name, description: text(flags, "description") ?? "" });
    if (res.status !== "success") return refused(res, flags);
    // A new group has no order yet: put it last, as the Studio does
    const a = await loadApi(platform, slug);
    const names = (a.endpoint_groups ?? []).filter((g) => !g.ungrouped && g.name !== name).sort((x, y) => (x.order ?? 0) - (y.order ?? 0)).map((g) => g.name);
    const ordered = await platform.post("v2/set-group-order", { slug, orders: [...names, name].map((n) => ({ name: n })) });
    if (ordered.status !== "success") return refused(ordered, flags);
    console.log(`group "${name}" added; move endpoints into it: jojapi endpoints move <METHOD> <path> "${name}"`);
    return 0;
  }
  if (action === "rename") {
    const { slug, args: [name, next] } = slugAndArgs(rest, flags, 2, "groups rename [slug] <name> <new name> [--description text]");
    const current = ((await loadApi(platform, slug)).endpoint_groups ?? []).find((g) => !g.ungrouped && g.name === name);
    if (!current) throw new Error(`${slug} has no group "${name}"`);
    const res = await platform.post("v2/update-endpoint-group", { slug, group_name: name, name: next, description: text(flags, "description") ?? current.description ?? "" });
    if (res.status !== "success") return refused(res, flags);
    console.log(`group "${name}" is now "${next}"`);
    return 0;
  }
  if (action === "delete") {
    const { slug, args: [name] } = slugAndArgs(rest, flags, 1, "groups delete [slug] <name> [--yes]");
    const go = await confirmed(flags, { action: `deleting group "${name}"`, details: "The endpoints in this group are not deleted; they move to Ungrouped.", question: `Delete group "${name}"?` });
    if (!go) return 1;
    const res = await platform.post("v2/delete-endpoint-group", { slug, group_name: name });
    if (res.status !== "success") return refused(res, flags);
    console.log(`group "${name}" deleted; its endpoints are ungrouped`);
    return 0;
  }
  if (action === "order") {
    // Every group, in the new order; the slug comes from jojapi.json or --slug
    const { slug } = slugAndArgs([], flags, 0, "groups order <group> <group> … [--slug slug]");
    if (!rest.length) throw new Error("usage: jojapi groups order <group> <group> … (every group, in the new order)");
    const res = await platform.post("v2/set-group-order", { slug, orders: rest.map((name) => ({ name })) });
    if (res.status !== "success") return refused(res, flags);
    console.log("groups reordered");
    return 0;
  }
  const { slug } = slugAndArgs(positional, flags, 0, "groups [slug]");
  const list = ((await loadApi(platform, slug)).endpoint_groups ?? []).filter((g) => !g.ungrouped).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  if (flags.json) return printJson({ groups: list.map((g) => ({ name: g.name, description: g.description, endpoints: g.endpoints.length })) });
  if (!list.length) console.log("no groups — add one: jojapi groups add <name>");
  else console.log(columns([["GROUP", "ENDPOINTS", "DESCRIPTION"], ...list.map((g) => [g.name, g.endpoints.length, g.description ?? ""])]));
  return 0;
}

// ---------------------------------------------------------------------------
// FAQs (addressed by their position in the list)

async function faqs(positional, flags) {
  const [action, ...rest] = positional;
  const platform = api();
  const load = async (slug) => ok(await platform.get("v2/studio/api-faqs", { api_slug: slug })).faqs ?? [];
  const pick = async (slug, position) => {
    const list = await load(slug);
    const faq = list[Number(position) - 1];
    if (!/^\d+$/.test(position) || !faq) throw new Error(`no FAQ #${position}: jojapi faqs lists them`);
    return faq;
  };
  if (action === "add") {
    const { slug } = slugAndArgs(rest, flags, 0, 'faqs add [slug] --question "…" --answer "…"');
    if (typeof flags.question !== "string" || typeof flags.answer !== "string") throw new Error('usage: jojapi faqs add [slug] --question "…" --answer "…"');
    const res = await platform.post("v2/studio/create-api-faq", { api_slug: slug, question: flags.question, answer: flags.answer });
    if (res.status !== "success") return refused(res, flags);
    console.log("FAQ added");
    return 0;
  }
  if (action === "update") {
    const { slug, args: [position] } = slugAndArgs(rest, flags, 1, 'faqs update [slug] <#> [--question "…"] [--answer "…"]');
    const faq = await pick(slug, position);
    const res = await platform.post("v2/studio/update-api-faq", { faq_id: faq.id, question: text(flags, "question") ?? faq.question, answer: text(flags, "answer") ?? faq.answer });
    if (res.status !== "success") return refused(res, flags);
    console.log(`FAQ #${position} updated`);
    return 0;
  }
  if (action === "delete") {
    const { slug, args: [position] } = slugAndArgs(rest, flags, 1, "faqs delete [slug] <#> [--yes]");
    const faq = await pick(slug, position);
    const go = await confirmed(flags, { action: `deleting FAQ #${position}`, details: `"${faq.question}" — this cannot be undone.`, question: `Delete FAQ #${position}?` });
    if (!go) return 1;
    const res = await platform.post("v2/studio/delete-api-faq", { faq_id: faq.id });
    if (res.status !== "success") return refused(res, flags);
    console.log(`FAQ #${position} deleted`);
    return 0;
  }
  const { slug } = slugAndArgs(positional, flags, 0, "faqs [slug]");
  const list = await load(slug);
  if (flags.json) return printJson({ faqs: list });
  if (!list.length) console.log('no FAQs — add one: jojapi faqs add --question "…" --answer "…" (the marketplace asks for at least 2)');
  if (list.length) console.log(list.map((faq, i) => `${i + 1}. ${faq.question}\n   ${faq.answer.replace(/\n/g, "\n   ")}`).join("\n\n"));
  return 0;
}

// ---------------------------------------------------------------------------
// Billable objects (addressed by their slug)

async function loadObjects(platform, slug) {
  return ok(await platform.get("v2/studio/api-objects", { slug })).objects ?? [];
}

export async function objectBySlug(platform, slug, objectSlug) {
  const object = (await loadObjects(platform, slug)).find((o) => o.slug === objectSlug);
  if (!object) throw new Error(`${slug} has no billable object "${objectSlug}": jojapi objects lists them`);
  return object;
}

async function objects(positional, flags) {
  const [action, ...rest] = positional;
  const platform = api();
  if (action === "add") {
    const usage = 'objects add [slug] <object slug> --name "Name" --dimension requests --formula 1';
    const { slug, args: [objectSlug] } = slugAndArgs(rest, flags, 1, usage);
    if (typeof flags.name !== "string" || typeof flags.formula !== "string") throw new Error(`usage: jojapi ${usage}`);
    const dimension = text(flags, "dimension") ?? "requests";
    if (!DIMENSIONS.includes(dimension)) throw new Error(`--dimension is one of ${DIMENSIONS.join(", ")}`);
    const res = await platform.post("v2/studio/create-object", { api_slug: slug, name: flags.name, slug: objectSlug, dimension, default_used_logic: flags.formula });
    if (res.status !== "success") return refused(res, flags);
    console.log(`object ${objectSlug} added; bill endpoints with it: jojapi billing ${objectSlug} --cost 1 --all`);
    return 0;
  }
  if (action === "update") {
    const { slug, args: [objectSlug] } = slugAndArgs(rest, flags, 1, "objects update [slug] <object slug> --formula <formula>");
    if (typeof flags.formula !== "string") throw new Error("usage: jojapi objects update [slug] <object slug> --formula <formula>");
    const object = await objectBySlug(platform, slug, objectSlug);
    const go = await confirmed(flags, { action: `changing the formula of ${objectSlug}`, details: `Endpoints that use the object's default (${object.endpoint_count} endpoint(s) bill ${objectSlug}) charge by the new formula from the next request:\n  ${object.default_used_logic || "(empty)"}\n→ ${flags.formula}`, question: `Change the default formula of ${objectSlug}?` });
    if (!go) return 1;
    const res = await platform.post("v2/studio/update-object", { api_slug: slug, id: object.id, default_used_logic: flags.formula });
    if (res.status !== "success") return refused(res, flags);
    console.log(`${objectSlug}: default formula updated`);
    return 0;
  }
  if (action === "delete") {
    const { slug, args: [objectSlug] } = slugAndArgs(rest, flags, 1, "objects delete [slug] <object slug> [--yes]");
    const object = await objectBySlug(platform, slug, objectSlug);
    const go = await confirmed(flags, { action: `deleting ${objectSlug}`, details: "This cannot be undone. An object still used by endpoints or plans cannot be deleted.", question: `Delete the billable object ${objectSlug}?` });
    if (!go) return 1;
    const res = await platform.post("v2/studio/delete-object", { api_slug: slug, id: object.id });
    if (res.status !== "success") {
      if (res.references) console.error(`used by ${res.references.endpoints ?? 0} endpoint(s) and ${res.references.plans ?? 0} plan(s)`);
      return refused(res, flags);
    }
    console.log(`${objectSlug} deleted`);
    return 0;
  }
  const { slug } = slugAndArgs(positional, flags, 0, "objects [slug]");
  const list = await loadObjects(platform, slug);
  if (flags.json) return printJson({ objects: list });
  if (!list.length) console.log('no billable objects — endpoints are free until you add one: jojapi objects add requests --name "Requests" --formula 1');
  else console.log(columns([["SLUG", "NAME", "DIMENSION", "DEFAULT FORMULA", "ENDPOINTS", "PLANS"], ...list.map((o) => [o.slug, o.name, o.dimension, o.default_used_logic || "—", o.endpoint_count, o.plan_count])]));
  return 0;
}

export default {
  title: "Listing",
  commands: {
    info: {
      usage: ["info [slug] [--json]"],
      summary: "the API's details, marketplace status and endpoint counts",
      run: info,
    },
    create: {
      usage: ['create [slug] --name "Name" [--description text]'],
      summary: "create an API (private until you list it)",
      run: create,
    },
    update: {
      usage: ["update [slug] [--name text] [--description text] [--logo file.png] [--requests on|off] [--marketplace private|unlisted|public] [--about-file about.md]"],
      summary: "change the API's details, visibility or about page",
      help: "--marketplace public submits the API for review (the listing checks run first and name what is missing); leaving public delists it and asks first. --requests off makes the gateway reject every call (asks first). The logo is a PNG up to 2 MB.",
      run: update,
    },
    resubmit: {
      usage: ["resubmit [slug]"],
      summary: "tell the reviewers a warned listing is fixed",
      run: resubmit,
    },
    endpoints: {
      usage: [
        "endpoints [slug] [--json]",
        "endpoints show [slug] <METHOD> <path> [--json]",
        'endpoints add [slug] <METHOD> <path> --name "Name" [--description text]',
        'endpoints update [slug] <METHOD> <path> [--name "Name"] [--description text]',
        "endpoints hide|unhide [slug] <METHOD> <path>",
        "endpoints disable|enable [slug] <METHOD> <path>",
        "endpoints delete [slug] <METHOD> <path> [--yes]",
        "endpoints duplicate [slug] <METHOD> <path> <new METHOD> <new path>",
        "endpoints move [slug] <METHOD> <path> <group | --ungrouped>",
        "endpoints example [slug] <METHOD> <path> <status> <name> --file example.json [--summary text] [--overwrite]",
      ],
      summary: "list, inspect and change the API's endpoints",
      help: "hide takes an endpoint out of the API page, the OpenAPI document and MCP tools; the gateway still serves it. disable makes the gateway reject calls to it; it stays documented. Parameters, bodies and responses are edited in bulk from an OpenAPI document: jojapi export, edit, jojapi import.",
      run: endpoints,
    },
    groups: {
      usage: ["groups [slug] [--json]", "groups add [slug] <name> [--description text]", "groups rename [slug] <name> <new name> [--description text]", "groups delete [slug] <name> [--yes]", "groups order <group> <group> … [--slug slug]"],
      summary: "endpoint groups on the API page",
      run: groups,
    },
    faqs: {
      usage: ["faqs [slug] [--json]", 'faqs add [slug] --question "…" --answer "…"', 'faqs update [slug] <#> [--question "…"] [--answer "…"]', "faqs delete [slug] <#> [--yes]"],
      summary: "the questions and answers on the API page",
      run: faqs,
    },
    objects: {
      usage: ["objects [slug] [--json]", 'objects add [slug] <object slug> --name "Name" [--dimension requests] --formula <formula>', "objects update [slug] <object slug> --formula <formula>", "objects delete [slug] <object slug> [--yes]"],
      summary: "billable objects: what endpoints count and plans include",
      help: `The formula is what one request uses by default ("1", a template reading the response, or on the edge gateway a usage source); "0" bills nothing. Dimensions: ${DIMENSIONS.join(", ")}.`,
      run: objects,
    },
  },
};
