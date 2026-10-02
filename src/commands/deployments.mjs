// Deployments: every save is an immutable deployment on its own URL; one of
// them serves production.

import { text } from "../args.mjs";
import { api, columns, confirmed, ok, printJson, refused, resolveSlugAndDir, slugAndArgs, when } from "../context.mjs";

const DEPLOYMENT_ID = /^[a-z0-9]{8}$/;

// What a change of one deployment sends, and whether it asks first
const DEPLOYMENT_ACTIONS = {
  keep: { body: { keep: true }, done: "kept active (never archived automatically)" },
  unkeep: { body: { keep: false }, done: "may be archived automatically again" },
  public: { body: { access: "everyone" }, done: "answers any subscriber's key (billed as usual)" },
  private: { body: { access: "owner" }, done: "answers only your own keys" },
  activate: { body: { active: true }, done: "active again (kept active)" },
  archive: { body: { active: false }, done: "archived; its URL answers 410" },
};

async function deployments(positional, flags) {
  if (DEPLOYMENT_ACTIONS[positional[0]]) return changeDeployment(positional[0], positional.slice(1), flags);
  const { slug } = resolveSlugAndDir(positional.slice(0, 1), flags);
  const res = ok(await api().get("v2/provider-api-edge-deployments", { slug }));
  if (flags.json) return printJson(res);
  console.log(`${res.active} active · ${res.included} included · latest: ${res.preview_url}`);
  const rows = [];
  for (const d of res.deployments) {
    const state = [d.production && "production", d.previous_production && "previous", d.latest && !d.production && "latest", d.access === "everyone" && "public", d.keep && "kept", d.status !== "active" && d.status].filter(Boolean).join(", ");
    const commit = d.git?.commit ? `${d.git.commit.slice(0, 7)}${d.git.pr ? ` #${d.git.pr}` : ""}` : "";
    rows.push([`#${d.number}`, d.id, when(d.created_ts), `${d.source}/${d.mode}`, commit, state, d.message ?? ""]);
    if (d.status === "failed" && d.error) rows.push(["", "", "", "", "", "", `! ${d.error}`]);
  }
  console.log(columns(rows));
  return 0;
}

async function changeDeployment(action, positional, flags) {
  const { slug, args: [id] } = slugAndArgs(positional, flags, 1, `deployments ${action} [slug] <deployment id>`);
  if (!DEPLOYMENT_ID.test(id)) throw new Error(`usage: jojapi deployments ${action} [slug] <deployment id>`);
  const platform = api();
  if (action === "archive") {
    const view = ok(await platform.get("v2/provider-api-edge-deployments", { slug }));
    const target = view.deployments.find((d) => d.id === id);
    if (!target) throw new Error(`${slug} has no deployment ${id}`);
    const role = target.previous_production ? " It is what production served before, the target of jojapi rollback." : target.latest ? " It is the latest preview." : "";
    const details = `Its URL answers 410 and storage only it binds is deleted; the snapshot stays and can be activated again.${role}`;
    if (!(await confirmed(flags, { action: `archiving ${id}`, details, question: `Archive #${target.number} ${id}?` }))) return 1;
  }
  const res = await platform.post("v2/update-api-edge-deployment", { slug, deployment: id, ...DEPLOYMENT_ACTIONS[action].body });
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson(res);
  console.log(`${id} ${DEPLOYMENT_ACTIONS[action].done}`);
  // Giving up keep can archive it at once when it is beyond the allowance
  const after = (res.deployments ?? []).find((d) => d.id === id);
  if (action === "unkeep" && after?.status === "archived") console.log(`${id} was beyond the included active deployments and is archived now`);
  return 0;
}

// The saved changes production does not run yet: the working copy's
// variables, bindings, template, mode and files against production's snapshot
async function changes(positional, flags) {
  const [action, ...rest] = positional;
  if (action === "deploy") return deployChanges(rest, flags);
  if (action === "discard") return discardChanges(rest, flags);
  const { slug } = slugAndArgs(positional, flags, 0, "changes [slug]");
  const { pending } = ok(await api().get("v2/provider-api-edge-deployments", { slug }));
  if (flags.json) return printJson({ pending });
  printPending(slug, pending);
  return 0;
}

function printPending(slug, pending) {
  if (!pending?.production) {
    console.log(`${slug} has no production deployment yet`);
    return;
  }
  if (!pending.changes.length) {
    console.log(`production (#${pending.production.number} ${pending.production.id}) runs everything saved`);
    return;
  }
  console.log(`production (#${pending.production.number} ${pending.production.id}) is ${pending.changes.length} change(s) behind:`);
  console.log(columns(pending.changes.map((c) => [`  ${c.change}`, c.type, c.type === "template" ? "" : c.name])));
  const d = pending.deployment;
  if (d) console.log(`latest preview: #${d.number} ${d.id} (${d.status}${d.current ? "" : ", older than the saved changes"})${d.error ? `: ${d.error}` : ""}\n  ${d.url}`);
}

async function deployChanges(positional, flags) {
  const { slug } = slugAndArgs(positional, flags, 0, "changes deploy [slug] [--note text] [--yes]");
  const platform = api();
  const { pending } = ok(await platform.get("v2/provider-api-edge-deployments", { slug }));
  if (pending?.production && !pending.changes.length) {
    console.log("nothing to deploy: production runs everything saved");
    return 0;
  }
  const preview = pending?.deployment;
  if (flags.yes !== true) printPending(slug, pending);
  const question = preview?.current ? `Deploy preview #${preview.number} to production?` : "Build a preview of the saved changes first?";
  const details = preview?.current
    ? `Your production hosts serve it within seconds.${text(flags, "note") ? " The release note is public on the API page." : ""}`
    : "No deployment holds the saved changes yet: a preview is built, and you deploy it after testing it.";
  if (!(await confirmed(flags, { action: "deploying the saved changes", details, question }))) return 1;
  const res = await platform.post("v2/deploy-api-edge-changes", { slug, deployment: preview?.current ? preview.id : undefined, note: text(flags, "note") });
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson({ status: "success", promoted: res.promoted, message: res.message, pending: res.pending ?? null });
  console.log(res.message);
  if (!res.promoted && res.preview_url) console.log(`  ${res.preview_url}`);
  return 0;
}

async function discardChanges(positional, flags) {
  const { slug } = slugAndArgs(positional, flags, 0, "changes discard [slug] [--yes]");
  const platform = api();
  const { pending } = ok(await platform.get("v2/provider-api-edge-deployments", { slug }));
  if (!pending?.production) throw new Error(`${slug} has no production deployment to return to`);
  if (!pending.changes.length) {
    console.log("nothing to discard: production runs everything saved");
    return 0;
  }
  if (flags.yes !== true) printPending(slug, pending);
  const added = pending.changes.filter((c) => c.type === "resource" && c.change === "added").map((c) => c.name);
  const details = [
    `Template, code, variables (secrets too) and bindings return to what production (#${pending.production.number}) runs; the previews made since are archived (their snapshots stay).`,
    added.length ? `Storage added since production (${added.join(", ")}) is removed and its data deleted, unless a kept or public deployment still binds it or another API uses it.` : "",
  ].filter(Boolean).join("\n");
  if (!(await confirmed(flags, { action: "discarding the saved changes", details, question: `Discard these ${pending.changes.length} change(s)?` }))) return 1;
  const res = await platform.post("v2/discard-api-edge-changes", { slug });
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson({ status: "success", message: res.message, archived: res.archived ?? [], kept: res.kept ?? [] });
  console.log(res.message);
  if (res.archived?.length) console.log(`archived: ${res.archived.join(", ")}`);
  return 0;
}

async function promote(positional, flags) {
  const { slug, args: [id] } = slugAndArgs(positional, flags, 1, "promote [slug] <deployment id> [--note text]");
  if (!DEPLOYMENT_ID.test(id)) throw new Error("usage: jojapi promote [slug] <deployment id> [--note text]");
  const res = await api().post("v2/promote-api-edge-deployment", { slug, deployment: id, note: text(flags, "note") });
  if (res.status !== "success") return refused(res);
  console.log(`${id} is in production`);
  return 0;
}

async function rollback(positional, flags) {
  const { slug } = resolveSlugAndDir(positional.slice(0, 1), flags);
  const res = await api().post("v2/rollback-api-edge", { slug, note: text(flags, "note") });
  if (res.status !== "success") return refused(res);
  console.log(`rolled back: ${res.deployment} is in production`);
  return 0;
}

export default {
  title: "Deployments",
  commands: {
    deployments: {
      usage: [
        "deployments [slug] [--json]",
        "deployments keep|unkeep [slug] <deployment id>",
        "deployments public|private [slug] <deployment id>",
        "deployments archive|activate [slug] <deployment id> [--yes]",
      ],
      summary: "the API's deployments, newest first",
      help: "keep: never archived automatically (beyond the included active deployments it counts toward compute usage). public: its URL answers any subscriber's key, billed as usual — a pinned version you can share; private: only your own keys. archive: its URL answers 410 (asks first); activate brings an archived one back, kept active.",
      run: deployments,
    },
    changes: {
      usage: ["changes [slug] [--json]", "changes deploy [slug] [--note text] [--yes]", "changes discard [slug] [--yes]"],
      summary: "saved changes production does not run yet; deploy or discard them",
      help: "deploy promotes the preview that holds the saved changes (the note is a public release note); when no preview holds them yet, it builds one to test first. discard returns the working copy to what production runs and archives the previews made since; storage added since production is deleted. Both ask first (--yes skips the question).",
      run: changes,
    },
    promote: {
      usage: ["promote [slug] <deployment id> [--note text]"],
      summary: "serve a deployment in production (the note is public)",
      run: promote,
    },
    rollback: {
      usage: ["rollback [slug] [--note text]"],
      summary: "back to the deployment production served before",
      run: rollback,
    },
  },
};
