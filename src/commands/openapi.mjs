// The API's documentation as a document: the marketplace page as consumers
// see it, an OpenAPI export, and imports that show every change they make
// before anything is applied.

import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { list, text } from "../args.mjs";
import { api, columns, confirmed, ok, printJson, refused, resolveSlugAndDir, slugAndArgs, when } from "../context.mjs";
import { loadPage, pageEndpoints } from "../page.mjs";
import { buildBundle, readSource } from "../openapi/bundle.mjs";
import { currentRecord, endpointDiff, incomingRecord, renderEndpointDiff, renderNewEndpoint } from "../openapi/diff.mjs";
import { buildSpec } from "../openapi/export.mjs";

const META_FIELDS = ["name", "description", "about"];

// ---------------------------------------------------------------------------
// The page

function planPrice(p) {
  if (p.type === "payasyougo") return "pay as you go";
  const amount = Number(p.pricing?.price ?? 0);
  const period = { "1 WEEK": "week", "1 MONTH": "month", "3 MONTH": "quarter", "1 YEAR": "year" }[p.period] ?? p.period;
  return amount === 0 ? "free" : `${amount.toFixed(2)} ${(p.currency ?? "usd").toUpperCase()}/${period}`;
}

function planIncludes(p) {
  return (p.objects ?? []).map((o) => (o.tiers ? `${o.name} ${o.tiers.map((t) => `$${t.unit_price}${t.start ? ` from ${t.start_text ?? t.start}` : ""}`).join(", ")}` : `${Number(o.quota ?? 0).toLocaleString("en-US")} ${o.name}`)).join(" · ");
}

async function page(positional, flags) {
  const { slug } = slugAndArgs(positional, flags, 0, "page [slug]");
  const { page: p, url } = await loadPage(api(), slug);
  const plans = [...(p.periodic_plans ?? []), ...(p.payasyougo_plans ?? [])].filter((plan) => !plan.blocked);
  const featureName = new Map((p.features ?? []).map((f) => [f.id, f.name]));
  const visible = pageEndpoints(p).filter(({ endpoint }) => !endpoint.hidden);
  const view = {
    url,
    title: p.title ?? p.name,
    description: p.description ?? "",
    provider: p.user ? { nick: p.user.nick, name: p.user.name, verified: p.user.verified === true } : null,
    plans: plans.map((plan) => ({ slug: plan.slug, name: plan.name, price: planPrice(plan), includes: planIncludes(plan), features: (plan.features ?? []).map((id) => featureName.get(id) ?? id) })),
    endpoints: visible.map(({ group, endpoint }) => ({ method: endpoint.method, url_path: endpoint.url_path, name: endpoint.name, group: group.ungrouped ? null : group.name, requests: !endpoint.blocked })),
    releases: (p.releases ?? []).slice(0, 10),
    last_updated: p.last_updated ?? null,
  };
  if (flags.json) return printJson(view);
  console.log(`${view.title}${view.provider ? ` by ${view.provider.name || view.provider.nick}${view.provider.verified ? " ✓ verified" : ""}` : ""}`);
  if (url) console.log(url);
  if (view.description) console.log(`\n${view.description}`);
  console.log(`\nplans${plans.length ? "" : ": none public — consumers cannot subscribe yet"}`);
  if (plans.length) console.log(columns(view.plans.map((plan) => [`  ${plan.name}`, plan.price, plan.includes, plan.features.length ? `✓ ${plan.features.join(", ")}` : ""])));
  const hidden = pageEndpoints(p).length - visible.length;
  console.log(`\n${visible.length} endpoint(s) in the docs${hidden ? ` (${hidden} hidden)` : ""}${visible.some((v) => v.endpoint.blocked) ? `, ${visible.filter((v) => v.endpoint.blocked).length} with requests off` : ""}`);
  if (view.releases.length) {
    console.log("\nreleases");
    console.log(columns(view.releases.slice(0, 5).map((r) => [`  ${when(r.date)}`, r.kind ?? "", r.note ?? ""])));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Export

async function exportSpec(positional, flags) {
  const { slug } = slugAndArgs(positional, flags, 0, "export [slug] [--output openapi.yaml] [--yaml]");
  const platform = api();
  const details = ok(await platform.get("v2/provider-api", { slug })).api;
  const { page: p } = await loadPage(platform, slug);
  const spec = buildSpec(details, p);
  const output = text(flags, "output");
  const yaml = flags.yaml === true || /\.ya?ml$/i.test(output ?? "");
  let content;
  if (yaml) {
    const { dump } = await import("js-yaml");
    content = dump(spec, { lineWidth: -1, noRefs: true });
  } else {
    content = `${JSON.stringify(spec, null, 2)}\n`;
  }
  const count = Object.values(spec.paths).reduce((n, item) => n + Object.keys(item).length, 0);
  if (!output) {
    process.stdout.write(content);
    return 0;
  }
  writeFileSync(output, content);
  console.error(`${count} endpoint(s) written to ${output}; edit it and run: jojapi import ${slug} ${output}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Import

function importOptions(flags) {
  const metadata = list(flags, "metadata").flatMap((value) => value.split(",")).map((v) => v.trim()).filter(Boolean);
  for (const field of metadata) if (!META_FIELDS.includes(field)) throw new Error(`--metadata takes ${META_FIELDS.join(", ")}`);
  return {
    overwrite_changed: flags["keep-changed"] !== true,
    hide_missing: flags["hide-missing"] === true,
    new_hidden: flags["new-hidden"] === true,
    update_meta: [...new Set(metadata)],
  };
}

function optionFlags(options) {
  return [
    options.overwrite_changed ? "" : "--keep-changed",
    options.hide_missing ? "--hide-missing" : "",
    options.new_hidden ? "--new-hidden" : "",
    options.update_meta.length ? `--metadata ${options.update_meta.join(",")}` : "",
  ].filter(Boolean).join(" ");
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Everything the reviewed preview depends on: the document as parsed, the
// options and the platform's answer. Applying checks it is still the same.
function digestOf(bundleText, options, preview) {
  return sha256(JSON.stringify({ bundle: sha256(bundleText), options, preview })).slice(0, 12);
}

async function preparePreview(platform, slug, source, options) {
  const loaded = await readSource(source);
  const { bundle, kind, warnings } = await buildBundle(loaded);
  const bundleText = JSON.stringify(bundle);
  const res = await platform.post("v2/import/preview", { slug, bundle: bundleText });
  if (res.status !== "success") return { refused: res };
  const preview = res.preview;

  // The stored documentation of the endpoints the document changes
  let current = new Map();
  if ((preview.endpoints?.changed ?? []).length) {
    const { page: p } = await loadPage(platform, slug);
    current = new Map(pageEndpoints(p).map(({ endpoint }) => [`${endpoint.method} ${endpoint.url_path}`, endpoint]));
  }
  const incoming = (method, path) => bundle.endpoints.find((e) => e.method === method && e.url_path === path);
  const changed = (preview.endpoints?.changed ?? []).map((c) => {
    const now = incoming(c.method, c.incoming_url_path ?? c.url_path);
    const was = current.get(`${c.method} ${c.url_path}`);
    return { ...c, changes: now && was ? endpointDiff(currentRecord(was), incomingRecord(now), c.aspects ?? []) : null };
  });
  const created = (preview.endpoints?.new ?? []).map((n) => ({ ...n, endpoint: incoming(n.method, n.url_path) ?? null }));

  return {
    loaded,
    bundle,
    bundleText,
    kind,
    digest: digestOf(bundleText, options, preview),
    preview,
    created,
    changed,
    warnings: [...warnings.map((w) => ({ code: "parser", ...w })), ...(preview.warnings ?? [])],
  };
}

function willChange(prepared, options) {
  const counts = prepared.preview.counts ?? {};
  const meta = Object.entries(prepared.preview.meta ?? {}).some(([field, m]) => m?.changed && options.update_meta.includes(field));
  return (counts.new ?? 0) > 0 || (options.overwrite_changed && (counts.changed ?? 0) > 0) || (options.hide_missing && (prepared.preview.endpoints?.missing ?? []).some((m) => !m.hidden)) || meta;
}

function renderPreview(slug, source, prepared, options) {
  const { preview, created, changed } = prepared;
  const counts = preview.counts ?? {};
  const missing = preview.endpoints?.missing ?? [];
  const out = [];
  out.push(`import into ${slug} from ${source} (${prepared.kind === "postman" ? "Postman Collection" : "OpenAPI"}, ${prepared.bundle.endpoints.length} endpoint(s))`);
  out.push(`  ${counts.new ?? 0} new · ${counts.changed ?? 0} changed · ${counts.unchanged ?? 0} unchanged · ${counts.missing ?? 0} missing`);

  if (created.length) {
    out.push("", `new — created${options.new_hidden ? ", hidden from the docs (--new-hidden)" : ", in the docs"}, requests on, not billed:`);
    for (const n of created) {
      out.push(`  + ${n.method} ${n.url_path} — ${n.name}${n.endpoint?.group ? `  [group ${n.endpoint.group}]` : ""}`);
      if (n.endpoint) out.push(...renderNewEndpoint(n.endpoint));
    }
  }
  if (changed.length) {
    out.push("", options.overwrite_changed ? "changed — overwritten with the document:" : "changed — kept as they are (--keep-changed):");
    for (const c of changed) {
      out.push(`  ~ ${c.method} ${c.url_path} — ${c.name}${c.incoming_url_path && c.incoming_url_path !== c.url_path ? `  (document: ${c.incoming_url_path})` : ""}`);
      if (!c.changes) {
        out.push("      (the stored documentation could not be loaded to show the values)");
        continue;
      }
      const lines = renderEndpointDiff(c.changes);
      out.push(...lines);
      // A section the platform compares differently (e.g. empty documentation stored as rows)
      for (const aspect of c.aspects ?? []) if (!(c.changes[aspect]?.length)) out.push(`      ${aspect.replace("_", " ")}: differs only in how empty documentation is stored`);
    }
  }
  const renamed = (preview.endpoints?.unchanged ?? []).filter((u) => u.renamed);
  if (renamed.length) {
    out.push("", "same endpoints, path variables named differently in the document (nothing changes):");
    for (const u of renamed) out.push(`  = ${u.method} ${u.url_path}  (document: ${u.incoming_url_path})`);
  }
  if (missing.length) {
    out.push("", options.hide_missing ? "missing from the document — hidden from the docs (--hide-missing; never deleted, still served):" : "missing from the document — kept as they are (--hide-missing hides them from the docs):");
    for (const m of missing) out.push(`  ? ${m.method} ${m.url_path} — ${m.name}${m.hidden ? "  (already hidden)" : ""}${m.blocked ? "  (requests off)" : ""}`);
  }
  const meta = Object.entries(preview.meta ?? {}).filter(([, m]) => m?.changed);
  if (meta.length) {
    out.push("", "API details in the document:");
    for (const [field, m] of meta) {
      const applied = options.update_meta.includes(field);
      const value = (v) => (field === "about" ? `${String(v ?? "").length} characters` : JSON.stringify(v ?? ""));
      out.push(`  ${applied ? "~" : " "} ${field}: ${value(m.current)} → ${value(m.incoming)}  ${applied ? "(applied)" : `(not applied; --metadata ${field} applies it)`}`);
    }
  }
  if (prepared.warnings.length) {
    out.push("", "notes:");
    for (const w of prepared.warnings) out.push(`  ! ${w.context ? `${w.context}: ` : ""}${w.message}`);
  }
  out.push("", "An import never changes billing, requests on/off, the groups and order of existing endpoints, or deletes an endpoint.");
  return out.join("\n");
}

function previewJson(slug, source, prepared, options) {
  return {
    status: "preview",
    api: slug,
    source,
    digest: prepared.digest,
    options,
    counts: prepared.preview.counts,
    new: prepared.created.map((n) => n.endpoint ?? n),
    changed: prepared.changed,
    unchanged: prepared.preview.endpoints?.unchanged ?? [],
    missing: prepared.preview.endpoints?.missing ?? [],
    meta: prepared.preview.meta ?? {},
    warnings: prepared.warnings,
    will_change: willChange(prepared, options),
    apply: `jojapi import ${slug} ${source} ${optionFlags(options)} --apply --expect ${prepared.digest}`.replace(/\s+/g, " "),
  };
}

function renderReport(report) {
  const out = [`import applied: ${report.created?.length ?? 0} created, ${report.updated?.length ?? 0} updated, ${report.skipped?.length ?? 0} kept, ${report.unchanged ?? 0} unchanged, ${report.hidden?.length ?? 0} hidden`];
  for (const e of report.created ?? []) out.push(`  + ${e.method} ${e.url_path}`);
  for (const e of report.updated ?? []) out.push(`  ~ ${e.method} ${e.url_path} (${(e.aspects ?? []).join(", ")})`);
  for (const e of report.hidden ?? []) out.push(`  - ${e.method} ${e.url_path} hidden from the docs`);
  if (report.meta_updated?.length) out.push(`  API details updated: ${report.meta_updated.join(", ")}`);
  for (const w of report.warnings ?? []) out.push(`  ! ${w.message}`);
  return out.join("\n");
}

async function importDoc(positional, flags) {
  const usage = "import [slug] [file | URL] [--keep-changed] [--hide-missing] [--new-hidden] [--metadata name,description,about] [--apply [--expect digest]] [--json]";
  if (positional.length > 2) throw new Error(`usage: jojapi ${usage}`);
  // `import <source>` in a project directory, `import <slug> <source>`, or
  // `import [slug]` again from the URL the last import came from
  const isSource = (value) => /^https?:\/\//i.test(value) || existsSync(value);
  let slugArg;
  let source;
  if (positional.length === 2) [slugArg, source] = positional;
  else if (positional.length === 1 && isSource(positional[0])) source = positional[0];
  else slugArg = positional[0];
  const { slug } = resolveSlugAndDir(slugArg ? [slugArg] : [], flags);
  const platform = api();
  if (!source) {
    const recorded = ok(await platform.get("v2/provider-api", { slug })).api.import_source;
    if (!recorded?.url || !/_url$/.test(recorded.type ?? "")) throw new Error(`pass a file or URL to import${recorded ? ` (${slug} was last imported from ${recorded.type}, which the Studio re-imports)` : ""}`);
    source = recorded.url;
  }
  const options = importOptions(flags);
  const prepared = await preparePreview(platform, slug, source, options);
  if (prepared.refused) return refused(prepared.refused, flags);

  if (flags.apply !== true) {
    if (flags.json) return printJson(previewJson(slug, source, prepared, options));
    console.log(renderPreview(slug, source, prepared, options));
    if (!willChange(prepared, options)) {
      console.log("\nnothing to import: the API already matches the document with these options");
      return 0;
    }
    console.log(`\ndigest ${prepared.digest}\napply exactly this: ${previewJson(slug, source, prepared, options).apply}`);
    return 0;
  }

  const expect = text(flags, "expect");
  if (expect !== undefined && expect !== prepared.digest) {
    if (flags.json) printJson({ ...previewJson(slug, source, prepared, options), status: "changed_since_review" });
    else console.log(renderPreview(slug, source, prepared, options));
    console.error(`\nnot applied: the changes are no longer the reviewed ones (digest ${expect}, now ${prepared.digest}). Review them and apply with --expect ${prepared.digest}`);
    return 1;
  }
  if (!willChange(prepared, options)) {
    if (flags.json) return printJson({ status: "unchanged" });
    console.log("nothing to import: the API already matches the document with these options");
    return 0;
  }
  if (expect === undefined) {
    if (!process.stdin.isTTY) throw new Error("applying an import needs the digest of the reviewed preview: run it without --apply, review the changes, then pass --expect <digest>");
    if (!flags.json) console.log(renderPreview(slug, source, prepared, options));
    if (!(await confirmed(flags, { action: "applying the import", question: `Apply these changes to ${slug}?` }))) return 1;
  }

  // A file is kept with the import as its source (best effort, as in the Studio)
  let snapshot = "";
  if (/_file$/.test(prepared.bundle.source.type)) {
    const upload = await platform.post("v2/import/upload", { content: prepared.loaded.content, source_type: prepared.bundle.source.type });
    if (upload.status === "success" && typeof upload.snapshot === "string") snapshot = upload.snapshot;
  }
  const res = await platform.post("v2/import/apply", {
    slug,
    bundle: prepared.bundleText,
    new_hidden: options.new_hidden,
    overwrite_changed: options.overwrite_changed,
    hide_missing: options.hide_missing,
    update_meta: options.update_meta,
    import_plans: false,
    publish_plans: false,
    use_groups: true,
    snapshot,
  });
  if (res.status !== "success") return refused(res, flags);
  if (flags.json) return printJson({ status: "applied", digest: prepared.digest, report: res.report });
  console.log(renderReport(res.report ?? {}));
  return 0;
}

export default {
  title: "Documentation",
  commands: {
    page: {
      usage: ["page [slug] [--json]"],
      summary: "the marketplace page as consumers see it: plans, endpoints, releases",
      run: page,
    },
    export: {
      usage: ["export [slug] [--output openapi.yaml] [--yaml]"],
      summary: "the API as an OpenAPI document (hidden endpoints included)",
      help: "Prints JSON (or YAML with --yaml or a .yaml/.yml --output). Importing the document again changes nothing, so it can live in a repository: export, edit, import.",
      run: exportSpec,
    },
    import: {
      usage: [
        "import [slug] <file | URL> [--keep-changed] [--hide-missing] [--new-hidden] [--metadata name,description,about] [--json]",
        "import [slug] <file | URL> [same options] --apply --expect <digest>",
        "import [slug] [same options]",
      ],
      summary: "update endpoints from an OpenAPI document or Postman Collection, after a full preview",
      help: "Without --apply nothing changes: it prints every change field by field — new endpoints with their parameters and responses, the values that change in existing ones, endpoints missing from the document, API details — and a digest. --apply --expect <digest> applies exactly that preview and refuses when anything differs (the document, the options or the API); in a terminal --apply without --expect shows the preview and asks first, without one it is refused. Changed endpoints are overwritten unless --keep-changed; missing ones are kept unless --hide-missing (hidden from the docs, never deleted); the API's name, description and about text change only with --metadata. Billing, requests on/off and the groups and order of existing endpoints never change. Without a source it re-imports from the URL the last import came from. RapidAPI and Apify imports run in the Studio.",
      run: importDoc,
    },
  },
};
