// Pricing: plans and what they include, plan features, what endpoints bill,
// what AI agents pay per request, and one-off free quota. Every write shows
// what changes and asks first (--yes for scripts); none is retried on its own.

import { list, text } from "../args.mjs";
import { api, columns, confirmed, ok, printJson, refused, slugAndArgs } from "../context.mjs";
import { objectBySlug } from "./listing.mjs";

const PERIODS = { week: "1 WEEK", month: "1 MONTH", quarter: "3 MONTH", year: "1 YEAR" };
const PERIOD_NAMES = Object.fromEntries(Object.entries(PERIODS).map(([name, value]) => [value, name]));
const WINDOWS = { 1: "1", s: "1", second: "1", 60: "60", m: "60", min: "60", minute: "60", 3600: "3600", h: "3600", hour: "3600" };
const WINDOW_NAMES = { 1: "second", 60: "minute", 3600: "hour" };

const number = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 8 });

async function loadPlans(platform, slug) {
  const { api: a } = ok(await platform.get("v2/studio/api-plans", { slug }));
  return { features: a.features ?? [], plans: [...(a.plans?.periodic ?? []), ...(a.plans?.payasyougo ?? [])] };
}

async function planBySlug(platform, slug, planSlug) {
  const loaded = await loadPlans(platform, slug);
  const plan = loaded.plans.find((p) => p.slug === planSlug);
  if (!plan) throw new Error(`${slug} has no plan ${planSlug}: jojapi plans lists them`);
  return { ...loaded, plan };
}

function includes(p) {
  return (p.objects ?? []).map((o) => (o.tiers ? `${o.slug} ${o.tiers.map((t) => `$${number(t.unit_price)}${t.start ? ` from ${number(t.start)}` : ""}`).join(", ")}` : `${number(o.quota ?? 0)} ${o.slug}`)).join(" · ");
}

function priceText(p) {
  if (p.type === "payasyougo") return "pay as you go";
  const amount = Number(p.pricing?.price ?? 0);
  return amount === 0 ? "free" : `${amount.toFixed(2)} ${(p.price?.currency ?? "usd").toUpperCase()}/${PERIOD_NAMES[p.period] ?? p.period}`;
}

function rateText(r) {
  return r?.enabled && r.max_requests ? `${r.max_requests}/${WINDOW_NAMES[r.time_window] ?? `${r.time_window}s`}` : "";
}

// "10/60", "10/min" → {max_requests, time_window}; "off" → disabled
function parseRate(value) {
  if (value === "off") return { enabled: false, max_requests: null, time_window: null };
  const match = /^(\d+)\/(\w+)$/.exec(value ?? "");
  if (!match || !WINDOWS[match[2]] || Number(match[1]) < 1) throw new Error("a rate limit is requests per second, minute or hour: 10/s, 600/min, 10000/h (or off)");
  return { enabled: true, max_requests: Number(match[1]), time_window: WINDOWS[match[2]] };
}

// "requests=0:0.001,10000:0.0008" → [object slug, [{from, price}]]
function parseTiers(value) {
  const [objectSlug, ladder] = value.split("=");
  const tiers = (ladder ?? "").split(",").map((step) => {
    const [from, price] = step.split(":");
    if (!/^\d+$/.test(from ?? "") || !/^\d+(\.\d+)?$/.test(price ?? "")) throw new Error(`--tiers ${value}: steps are from:price, e.g. requests=0:0.001,10000:0.0008`);
    return { from: Number(from), price: Number(price) };
  });
  if (!objectSlug || !tiers.length || tiers[0].from !== 0 || tiers.some((t, i) => i > 0 && t.from <= tiers[i - 1].from) || tiers.length > 5) {
    throw new Error(`--tiers ${value}: up to 5 steps, the first from 0, each starting above the one before`);
  }
  return [objectSlug, tiers];
}

function parseQuota(value) {
  const [objectSlug, quota] = value.split("=");
  if (!objectSlug || !/^\d+$/.test(quota ?? "")) throw new Error(`--quota ${value}: object=amount, e.g. requests=10000`);
  return [objectSlug, Number(quota)];
}

// The two public-plan limits the platform keeps (10 public plans, 1 public pay-as-you-go)
function publicLimitError(plans, type, except) {
  const open = plans.filter((p) => !p.blocked && p.slug !== except);
  if (open.length >= 10) return "an API can have at most 10 public plans: make another one private first";
  if (type === "payasyougo" && open.some((p) => p.type === "payasyougo")) return "an API can have one public pay-as-you-go plan: make the other one private first";
  return null;
}

// ---------------------------------------------------------------------------
// Plans

async function plans(positional, flags) {
  const [action, ...rest] = positional;
  const handler = PLAN_ACTIONS[action];
  if (handler) return handler(rest, flags);
  const { slug } = slugAndArgs(positional, flags, 0, "plans [slug]");
  const { features, plans: all } = await loadPlans(api(), slug);
  if (flags.json) return printJson({ plans: all, features });
  if (!all.length) {
    console.log("no plans — create one: jojapi plans create --price 9.99 --quota requests=10000");
    return 0;
  }
  const featureName = new Map(features.map((f) => [f.id, f.name]));
  console.log(columns([
    ["PLAN", "NAME", "PRICE", "INCLUDES", "RATE", "VISIBILITY", "SUBSCRIBERS"],
    ...all.map((p) => [p.slug, p.name, priceText(p), includes(p), rateText(p.rate_limit), p.blocked ? `private${p.custom_users?.length ? ` (+${p.custom_users.filter((u) => !u.blocked).length} allowed)` : ""}` : "public", p.subscriptions_count ?? 0]),
  ]));
  const withFeatures = all.filter((p) => p.features?.length);
  if (withFeatures.length) console.log("\nfeatures:\n" + columns(withFeatures.map((p) => [`  ${p.slug}`, p.features.map((id) => featureName.get(id) ?? id).join(", ")])));
  return 0;
}

async function planCreate(positional, flags) {
  const usage = "plans create [slug] (--price 9.99 [--currency usd|eur] [--period week|month|quarter|year] --quota object=N … | --payg --tiers object=0:0.001,10000:0.0008 …) [--rate 600/min] [--public] [--name text] [--features a,b] [--yes]";
  const { slug } = slugAndArgs(positional, flags, 0, usage);
  const payg = flags.payg === true;
  const platform = api();
  const { features, plans: existing } = await loadPlans(platform, slug);
  const objects = ok(await platform.get("v2/studio/api-objects", { slug })).objects ?? [];
  const objectId = (objectSlug) => {
    const object = objects.find((o) => o.slug === objectSlug);
    if (!object) throw new Error(`${slug} has no billable object "${objectSlug}": jojapi objects lists them`);
    return object.id;
  };

  const plan = { type: payg ? "payasyougo" : "periodic", blocked: flags.public !== true };
  const period = text(flags, "period") ?? "month";
  if (!PERIODS[period]) throw new Error(`--period is one of ${Object.keys(PERIODS).join(", ")}`);
  plan.period = PERIODS[period];
  const included = [];
  if (payg) {
    const ladders = list(flags, "tiers").map(parseTiers);
    if (!ladders.length) throw new Error(`a pay-as-you-go plan prices at least one object: --tiers object=0:0.001\nusage: jojapi ${usage}`);
    plan.currency = "usd";
    plan.objects = ladders.map(([objectSlug, tiers]) => ({ id: objectId(objectSlug), pricing: tiers }));
    for (const [objectSlug, tiers] of ladders) included.push(`${objectSlug}: ${tiers.map((t) => `$${number(t.price)} each${t.from ? ` from ${number(t.from)}` : ""}`).join(", ")}`);
  } else {
    const price = text(flags, "price");
    if (price === undefined || !/^\d+(\.\d{1,2})?$/.test(price)) throw new Error(`a periodic plan needs --price (0 for free, up to 2 decimals)\nusage: jojapi ${usage}`);
    const quotas = list(flags, "quota").map(parseQuota);
    if (!quotas.length) throw new Error(`a periodic plan includes at least one object: --quota object=N\nusage: jojapi ${usage}`);
    plan.currency = text(flags, "currency") ?? "usd";
    if (!["usd", "eur"].includes(plan.currency)) throw new Error("--currency is usd or eur");
    plan.price = { amount: Number(price) };
    plan.objects = quotas.map(([objectSlug, quota]) => ({ id: objectId(objectSlug), quota }));
    for (const [objectSlug, quota] of quotas) included.push(`${number(quota)} ${objectSlug} per ${period}`);
  }
  if (typeof flags.rate === "string") {
    const rate = parseRate(flags.rate);
    if (rate.enabled) Object.assign(plan, { rate_limit_enabled: true, rate_limit: rate.max_requests, rate_limit_window: rate.time_window });
  }
  if (text(flags, "name") !== undefined) plan.name = text(flags, "name");
  if (text(flags, "features")) plan.features = featureIds(features, text(flags, "features"));
  if (!plan.blocked) {
    const limit = publicLimitError(existing, plan.type);
    if (limit) throw new Error(limit);
  }

  // Objects endpoints bill that this plan leaves out: its subscribers get 402 there
  const leftOut = objects.filter((o) => o.endpoint_count > 0 && !plan.objects.some((x) => x.id === o.id)).map((o) => o.slug);
  const details = [
    `${plan.blocked ? "private" : "public"} ${payg ? "pay-as-you-go plan" : `plan at ${Number(plan.price.amount).toFixed(2)} ${plan.currency.toUpperCase()} per ${period}`}${plan.name ? ` "${plan.name}"` : ""}`,
    ...included.map((line) => `  ${line}`),
    ...(plan.rate_limit_enabled ? [`  rate limit ${plan.rate_limit}/${WINDOW_NAMES[plan.rate_limit_window]}`] : []),
    leftOut.length ? `Endpoints that bill ${leftOut.join(", ")} refuse this plan's subscribers (402): the plan does not include ${leftOut.length > 1 ? "them" : "it"}.` : "",
    "Price, currency, period and what the plan includes can never change; a new price is a new plan (transfer subscribers in the Studio).",
    !plan.blocked && !payg && plan.currency === "usd" && plan.price.amount > 0 ? "A public, priced USD plan can also be bought by AI agents." : "",
  ].filter(Boolean).join("\n");
  if (!(await confirmed(flags, { action: "creating a plan", details, question: `Create this plan on ${slug}?` }))) return 1;

  const res = await platform.post("v2/studio/create-api-plan", { api_slug: slug, plan });
  if (res.status !== "success") return refused(res, flags);
  // The answer names the plan; an older platform does not, and then it is the
  // one that was not there before
  const plans = (await loadPlans(platform, slug)).plans;
  const before = new Set(existing.map((p) => p.slug));
  const created = plans.find((p) => p.slug === res.plan?.slug) ?? plans.find((p) => !before.has(p.slug));
  if (flags.json) return printJson({ status: "success", plan: created ?? null });
  if (!created) console.log(`plan created (${plan.blocked ? "private" : "public"}); jojapi plans lists it`);
  else console.log(`plan ${created.slug} created — ${plan.blocked ? `private; open it with jojapi plans public ${created.slug}` : "public"}`);
  return 0;
}

function featureIds(features, names) {
  return names.split(",").map((name) => name.trim()).filter(Boolean).map((name) => {
    const feature = features.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (!feature) throw new Error(`no feature "${name}": jojapi features lists them (jojapi features add "${name}")`);
    return feature.id;
  });
}

// update-api-plan replaces both the rate limit and the visibility: the one
// not being changed is sent as it is
async function savePlan(platform, plan, change) {
  const r = plan.rate_limit ?? {};
  return platform.post("v2/update-api-plan", {
    slug: plan.slug,
    rate_limit: { enabled: r.enabled === true, max_requests: r.max_requests === null || r.max_requests === undefined ? null : Number(r.max_requests), time_window: r.time_window ?? null },
    blocked: plan.blocked === true,
    ...change,
  });
}

function planVisibility(makePublic) {
  return async (positional, flags) => {
    const { slug, args: [planSlug] } = slugAndArgs(positional, flags, 1, `plans ${makePublic ? "public" : "private"} [slug] <plan> [--yes]`);
    const platform = api();
    const { plan, plans: all } = await planBySlug(platform, slug, planSlug);
    if (plan.blocked !== makePublic) {
      console.log(`${planSlug} is already ${makePublic ? "public" : "private"}`);
      return 0;
    }
    if (makePublic) {
      const limit = publicLimitError(all, plan.type, plan.slug);
      if (limit) throw new Error(limit);
    }
    const details = makePublic
      ? `${plan.name} (${priceText(plan)}) appears on the pricing page and anyone can subscribe.${plan.type === "periodic" && plan.price?.currency !== "eur" && Number(plan.pricing?.price ?? 0) > 0 ? " AI agents can buy it too." : ""}`
      : `New sign-ups stop; its ${plan.subscriptions_count ?? 0} current subscriber(s) keep it and renew as before.`;
    if (!(await confirmed(flags, { action: `making ${planSlug} ${makePublic ? "public" : "private"}`, details, question: `Make ${planSlug} ${makePublic ? "public" : "private"}?` }))) return 1;
    const res = await savePlan(platform, plan, { blocked: !makePublic });
    if (res.status !== "success") return refused(res, flags);
    console.log(`${planSlug} is ${makePublic ? "public" : "private"}`);
    return 0;
  };
}

async function planRate(positional, flags) {
  const { slug, args: [planSlug, value] } = slugAndArgs(positional, flags, 2, "plans rate [slug] <plan> <600/min | off> [--yes]");
  const rate = parseRate(value);
  const platform = api();
  const { plan } = await planBySlug(platform, slug, planSlug);
  const details = `${rateText(plan.rate_limit) || "no limit"} → ${rate.enabled ? `${rate.max_requests}/${WINDOW_NAMES[rate.time_window]}` : "no limit"}, for its ${plan.subscriptions_count ?? 0} current subscriber(s) from the next request.`;
  if (!(await confirmed(flags, { action: `changing the rate limit of ${planSlug}`, details, question: `Change the rate limit of ${planSlug}?` }))) return 1;
  const res = await savePlan(platform, plan, { rate_limit: rate });
  if (res.status !== "success") return refused(res, flags);
  console.log(`${planSlug}: rate limit ${rate.enabled ? `${rate.max_requests}/${WINDOW_NAMES[rate.time_window]}` : "off"}`);
  return 0;
}

// update-plan-display replaces the name and the feature list: what is not
// given is sent as it is ("--name ''" goes back to the derived name)
async function planDisplay(positional, flags) {
  const { slug, args: [planSlug] } = slugAndArgs(positional, flags, 1, 'plans display [slug] <plan> [--name "Pro"] [--features "A,B"]');
  if (flags.name === undefined && flags.features === undefined) throw new Error('nothing to change: pass --name "…" or --features "A,B" (--features "" clears them)');
  const platform = api();
  const { plan, features } = await planBySlug(platform, slug, planSlug);
  const res = await platform.post("v2/update-plan-display", {
    slug: plan.slug,
    name: text(flags, "name") ?? plan.display_name ?? "",
    features: flags.features === undefined ? plan.features ?? [] : featureIds(features, text(flags, "features") ?? ""),
  });
  if (res.status !== "success") return refused(res, flags);
  console.log(`${planSlug}: display updated`);
  return 0;
}

async function planAddObject(positional, flags) {
  const usage = "plans add-object [slug] <plan> <object> (--quota N | --tiers 0:0.001,10000:0.0008) [--yes]";
  const { slug, args: [planSlug, objectSlug] } = slugAndArgs(positional, flags, 2, usage);
  const platform = api();
  const { plan } = await planBySlug(platform, slug, planSlug);
  const object = await objectBySlug(platform, slug, objectSlug);
  let entry;
  let what;
  if (plan.type === "payasyougo") {
    if (typeof flags.tiers !== "string") throw new Error(`a pay-as-you-go plan prices the object: --tiers 0:0.001,…\nusage: jojapi ${usage}`);
    const [, tiers] = parseTiers(`${objectSlug}=${flags.tiers}`);
    entry = { id: object.id, pricing: tiers };
    what = tiers.map((t) => `$${number(t.price)} each${t.from ? ` from ${number(t.from)}` : ""}`).join(", ");
  } else {
    if (typeof flags.quota !== "string" || !/^\d+$/.test(flags.quota)) throw new Error(`a periodic plan includes a quota of the object: --quota N\nusage: jojapi ${usage}`);
    entry = { id: object.id, quota: Number(flags.quota) };
    what = `${number(flags.quota)} per period`;
  }
  const details = `${objectSlug}: ${what}. It takes effect for all ${plan.subscriptions_count ?? 0} current subscriber(s) at once, cannot be changed or removed later, and every subscriber of this plan is notified by email.`;
  if (!(await confirmed(flags, { action: `adding ${objectSlug} to ${planSlug}`, details, question: `Add ${objectSlug} to ${planSlug} and notify its subscribers?` }))) return 1;
  const res = await platform.post("v2/add-api-plan-object", { plan_slug: plan.slug, object: entry });
  if (res.status !== "success") return refused(res, flags);
  console.log(`${objectSlug} added to ${planSlug}; ${res.notified_subscribers ?? 0} subscriber(s) notified`);
  return 0;
}

async function planDelete(positional, flags) {
  const { slug, args: [planSlug] } = slugAndArgs(positional, flags, 1, "plans delete [slug] <plan> [--yes]");
  const platform = api();
  const { plan } = await planBySlug(platform, slug, planSlug);
  if ((plan.subscriptions_count ?? 0) > 0) throw new Error(`${planSlug} has ${plan.subscriptions_count} active subscriber(s): transfer them to another plan in the Studio first, or make it private (jojapi plans private ${planSlug})`);
  if (plan.custom_users?.length) throw new Error(`${planSlug} has custom access for ${plan.custom_users.map((u) => u.nick).join(", ")}: remove it first (jojapi plans access ${planSlug} <nick> remove)`);
  if (!(await confirmed(flags, { action: `deleting ${planSlug}`, details: `${plan.name} (${priceText(plan)}) — this cannot be undone.`, question: `Delete plan ${planSlug}?` }))) return 1;
  const res = await platform.post("v2/delete-api-plan", { slug: plan.slug });
  if (res.status !== "success") return refused(res, flags);
  console.log(`${planSlug} deleted`);
  return 0;
}

const ACCESS = {
  allow: { block: false, delete: false, done: "can see and subscribe to it even while it is private" },
  block: { block: true, delete: false, done: "can no longer see or subscribe to it (a current subscription stays)" },
  remove: { block: false, delete: true, done: "follows the plan's visibility again" },
};

async function planAccess(positional, flags) {
  const { slug, args: [planSlug, nick, mode] } = slugAndArgs(positional, flags, 3, "plans access [slug] <plan> <user nick> allow|block|remove");
  if (!ACCESS[mode]) throw new Error("usage: jojapi plans access [slug] <plan> <user nick> allow|block|remove");
  const platform = api();
  await planBySlug(platform, slug, planSlug);
  const res = await platform.post("v2/set-user-custom-api-plan", { user_nick: nick, plan_slug: planSlug, block: ACCESS[mode].block, delete: ACCESS[mode].delete });
  if (res.status !== "success") return refused(res, flags);
  console.log(`@${nick} ${ACCESS[mode].done}`);
  return 0;
}

const PLAN_ACTIONS = {
  create: planCreate,
  public: planVisibility(true),
  private: planVisibility(false),
  rate: planRate,
  display: planDisplay,
  "add-object": planAddObject,
  delete: planDelete,
  access: planAccess,
};

// ---------------------------------------------------------------------------
// Plan features: one ordered list per API

async function features(positional, flags) {
  const [action, ...rest] = positional;
  const platform = api();
  const save = async (slug, next) => {
    const res = await platform.post("v2/studio/set-api-features", { api_slug: slug, features: next });
    if (res.status !== "success") return refused(res, flags);
    return 0;
  };
  const find = (all, name) => {
    const feature = all.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (!feature) throw new Error(`no feature "${name}": jojapi features lists them`);
    return feature;
  };
  if (action === "add") {
    const { slug, args: [name] } = slugAndArgs(rest, flags, 1, 'features add [slug] "Name" [--description text]');
    const { features: all } = await loadPlans(platform, slug);
    if ((await save(slug, [...all, { name, description: text(flags, "description") ?? "" }])) !== 0) return 1;
    console.log(`feature "${name}" added; show it on a plan: jojapi plans display <plan> --features "${name}"`);
    return 0;
  }
  if (action === "rename") {
    const { slug, args: [name, next] } = slugAndArgs(rest, flags, 2, 'features rename [slug] "Name" "New name" [--description text]');
    const { features: all } = await loadPlans(platform, slug);
    const feature = find(all, name);
    const updated = all.map((f) => (f.id === feature.id ? { ...f, name: next, description: text(flags, "description") ?? f.description ?? "" } : f));
    if ((await save(slug, updated)) !== 0) return 1;
    console.log(`feature "${name}" is now "${next}"`);
    return 0;
  }
  if (action === "remove") {
    const { slug, args: [name] } = slugAndArgs(rest, flags, 1, 'features remove [slug] "Name" [--yes]');
    const { features: all, plans: allPlans } = await loadPlans(platform, slug);
    const feature = find(all, name);
    const on = allPlans.filter((p) => p.features?.includes(feature.id)).map((p) => p.slug);
    if (!(await confirmed(flags, { action: `removing feature "${name}"`, details: on.length ? `It disappears from ${on.length} plan(s): ${on.join(", ")}.` : "No plan shows it.", question: `Remove feature "${name}"?` }))) return 1;
    if ((await save(slug, all.filter((f) => f.id !== feature.id))) !== 0) return 1;
    console.log(`feature "${name}" removed`);
    return 0;
  }
  const { slug } = slugAndArgs(positional, flags, 0, "features [slug]");
  const { features: all } = await loadPlans(platform, slug);
  if (flags.json) return printJson({ features: all });
  if (!all.length) console.log('no features — add one: jojapi features add "Priority support"');
  else console.log(columns(all.map((f) => [f.name, f.description ?? ""])));
  return 0;
}

// ---------------------------------------------------------------------------
// What endpoints bill, what agents pay

async function endpointList(platform, slug, flags) {
  const a = ok(await platform.get("v2/provider-api", { slug })).api;
  if (flags.all === true) return { a, endpoints: (a.endpoints ?? []).map((e) => ({ method: e.method, url_path: e.url_path })) };
  const given = list(flags, "endpoint").map((ref) => {
    const [method, path] = ref.trim().split(/\s+/);
    return { method: (method ?? "").toUpperCase(), url_path: path ?? "" };
  });
  if (!given.length) throw new Error('name the endpoints: --endpoint "GET /users/{id}" (repeatable) or --all');
  return { a, endpoints: given };
}

async function billing(positional, flags) {
  const usage = 'billing [slug] <object> --cost <amount | formula | ""> [--label text] (--endpoint "GET /path" … | --all) [--yes]';
  const { slug, args: [objectSlug] } = slugAndArgs(positional, flags, 1, usage);
  if (typeof flags.cost !== "string") throw new Error(`usage: jojapi ${usage}`);
  const platform = api();
  const object = await objectBySlug(platform, slug, objectSlug);
  const { endpoints } = await endpointList(platform, slug, flags);
  const { plans: all } = await loadPlans(platform, slug);
  const without = all.filter((p) => !(p.objects ?? []).some((o) => o.id === object.id)).map((p) => p.slug);
  const cost = flags.cost === "" ? `the object's default (${object.default_used_logic || "nothing"})` : /^\d{1,7}$/.test(flags.cost) ? `${flags.cost} ${objectSlug} per request` : `the formula ${flags.cost}`;
  const details = [
    `${endpoints.length} endpoint(s) bill ${cost}, from the next request; subscribers are not notified. Other objects on these endpoints stay as they are.`,
    without.length ? `Plans without ${objectSlug} (${without.join(", ")}) refuse these endpoints with 402.` : "",
  ].filter(Boolean).join("\n");
  if (!(await confirmed(flags, { action: `changing what ${endpoints.length} endpoint(s) bill`, details, question: `Bill ${objectSlug} on ${endpoints.length} endpoint(s)?` }))) return 1;
  let updated = 0;
  const failed = [];
  for (let i = 0; i < endpoints.length; i += 100) {
    const payload = { slug, endpoints: endpoints.slice(i, i + 100), object_id: object.id, cost: flags.cost };
    if (text(flags, "label") !== undefined) payload.label = text(flags, "label");
    const res = await platform.post("v2/provider/bulk-update-endpoint-billing", payload);
    if (res.status !== "success") return refused(res, flags);
    updated += res.updated ?? 0;
    failed.push(...(res.failed ?? []));
  }
  if (flags.json) return printJson({ status: "success", updated, failed });
  console.log(`${updated} endpoint(s) bill ${objectSlug}`);
  for (const f of failed) console.error(`  ✗ ${f.method} ${f.url_path}: ${f.message ?? f.reason}`);
  return failed.length ? 1 : 0;
}

async function agents(positional, flags) {
  const [action, ...rest] = positional;
  const platform = api();
  if (action === "on" || action === "off") {
    const { slug } = slugAndArgs(rest, flags, 0, "agents on|off [slug]");
    const details = action === "on" ? "AI agents can pay per request (x402/MPP) on endpoints with an agent price; private APIs are never sold." : "Agents can no longer pay per request; the prices stay saved.";
    if (!(await confirmed(flags, { action: `switching agent payments ${action}`, details, question: `Switch agent payments ${action} for ${slug}?` }))) return 1;
    const res = await platform.post("v2/provider/set-api-agent-payments", { slug, request_enabled: action === "on" });
    if (res.status !== "success") return refused(res, flags);
    console.log(`agent payments ${res.request_enabled ? "on" : "off"} · ${res.priced_endpoints ?? 0} priced endpoint(s)`);
    return 0;
  }
  if (action === "price") {
    const usage = 'agents price [slug] <USD | off> (--endpoint "GET /path" … | --all) [--yes]';
    const { slug, args: [value] } = slugAndArgs(rest, flags, 1, usage);
    const { a, endpoints } = await endpointList(platform, slug, flags);
    const limits = a.agent_price_limits ?? {};
    if (value !== "off") {
      if (!/^\d{1,6}(\.\d{1,6})?$/.test(value)) throw new Error(`usage: jojapi ${usage}`);
      if ((limits.min_usd !== undefined && Number(value) < limits.min_usd) || (limits.max_usd !== undefined && Number(value) > limits.max_usd)) throw new Error(`an agent price is between $${limits.min_usd} and $${limits.max_usd} per request`);
    }
    const details = value === "off" ? `${endpoints.length} endpoint(s) are no longer sold per request to AI agents.` : `AI agents pay $${value} per successful request on ${endpoints.length} endpoint(s)${a.agent_request_enabled ? "" : " (agent payments are off: jojapi agents on)"}. Plan billing is unchanged.`;
    if (!(await confirmed(flags, { action: "changing agent prices", details, question: "Change the agent price?" }))) return 1;
    let updated = 0;
    const failed = [];
    for (let i = 0; i < endpoints.length; i += 100) {
      const res = await platform.post("v2/provider/bulk-update-endpoint-agent-price", { slug, endpoints: endpoints.slice(i, i + 100), price: value === "off" ? null : value });
      if (res.status !== "success") return refused(res, flags);
      updated += res.updated ?? 0;
      failed.push(...(res.failed ?? []));
    }
    console.log(`${updated} endpoint(s) ${value === "off" ? "no longer sold to agents" : `at $${value} per request for agents`}`);
    for (const f of failed) console.error(`  ✗ ${f.method} ${f.url_path}: ${f.reason ?? f.message}`);
    return failed.length ? 1 : 0;
  }
  const { slug } = slugAndArgs(positional, flags, 0, "agents [slug]");
  const a = ok(await platform.get("v2/provider-api", { slug })).api;
  const priced = (a.endpoints ?? []).filter((e) => e.agent_price !== null && e.agent_price !== undefined);
  if (flags.json) return printJson({ request_enabled: a.agent_request_enabled === true, limits: a.agent_price_limits ?? null, priced: priced.map((e) => ({ method: e.method, url_path: e.url_path, price: e.agent_price })) });
  console.log(`agent payments ${a.agent_request_enabled ? "on" : "off"} · prices between $${a.agent_price_limits?.min_usd} and $${a.agent_price_limits?.max_usd} per request`);
  if (priced.length) console.log(columns(priced.map((e) => [`  ${e.method}`, e.url_path, `$${e.agent_price}`])));
  else console.log("no endpoint has an agent price — set one: jojapi agents price 0.05 --all");
  return 0;
}

// ---------------------------------------------------------------------------
// One-off free quota

async function grant(positional, flags) {
  const usage = "grant [slug] <user nick> <object> <units> [--plan plan] [--note text] [--yes]";
  const { slug, args: [nick, objectSlug, units] } = slugAndArgs(positional, flags, 3, usage);
  if (!/^\d+$/.test(units) || Number(units) < 1 || Number(units) > 1e9) throw new Error("units is a whole number from 1 to 1,000,000,000");
  const platform = api();
  // The subscription is found by its subscriber; its id goes back to the
  // platform as returned (a public id, or a row number on an older platform)
  // and is never shown
  const candidates = (ok(await platform.get("v2/ProviderSubscriptions")).subscriptions ?? []).filter((s) => s.api?.slug === slug && s.user?.nick === nick && (!text(flags, "plan") || s.plan?.slug === text(flags, "plan")));
  if (!candidates.length) throw new Error(`@${nick} has no active subscription to ${slug}`);
  if (candidates.length > 1) throw new Error(`@${nick} holds ${candidates.length} subscriptions to ${slug}: pass --plan (${candidates.map((s) => s.plan.slug).join(", ")})`);
  const [subscription] = candidates;
  if (subscription.plan?.type !== "periodic") throw new Error("free quota goes to subscriptions of periodic plans");
  const object = (subscription.subscription?.current_period?.objects ?? []).find((o) => o.slug === objectSlug);
  if (!object) throw new Error(`${subscription.plan.name} has no ${objectSlug} quota`);
  const details = `Adds ${number(units)} ${object.name} to @${nick}'s current period on ${subscription.plan.name} (used ${number(object.used ?? 0)} of ${number(object.quota ?? 0)}). It is not a charge, expires when the period renews, and @${nick} is emailed${text(flags, "note") ? " with your note" : ""}. Running it again adds again.`;
  if (!(await confirmed(flags, { action: "granting free quota", details, question: `Grant ${number(units)} ${objectSlug} to @${nick}?` }))) return 1;
  const payload = { subscription_id: subscription.subscription.id, object_id: object.id, units: Number(units) };
  if (text(flags, "note")) payload.note = text(flags, "note");
  const res = await platform.post("v2/studio/grant-quota", payload);
  if (res.status !== "success") return refused(res, flags);
  console.log(res.message);
  return 0;
}

export default {
  title: "Pricing",
  commands: {
    plans: {
      usage: [
        "plans [slug] [--json]",
        "plans create [slug] --price 9.99 [--currency usd|eur] [--period week|month|quarter|year] --quota object=N … [--rate 600/min] [--public] [--name text] [--features \"A,B\"]",
        "plans create [slug] --payg --tiers object=0:0.001,10000:0.0008 … [--rate 600/min] [--public] [--name text]",
        "plans public|private [slug] <plan>",
        "plans rate [slug] <plan> <600/min | off>",
        'plans display [slug] <plan> [--name "Pro"] [--features "A,B"]',
        "plans add-object [slug] <plan> <object> (--quota N | --tiers 0:0.001,…)",
        "plans delete [slug] <plan>",
        "plans access [slug] <plan> <user nick> allow|block|remove",
      ],
      summary: "plans: what they cost, include and who can subscribe",
      help: "New plans are private until --public or `plans public`. Price, currency, period and what a plan includes never change; a new price is a new plan, and subscribers move to it with a transfer in the Studio. add-object is permanent and emails every subscriber. access lets one user see a private plan (allow) or keeps them off a public one (block). Every change asks first; --yes answers for scripts.",
      run: plans,
    },
    features: {
      usage: ["features [slug] [--json]", 'features add [slug] "Name" [--description text]', 'features rename [slug] "Name" "New name"', 'features remove [slug] "Name" [--yes]'],
      summary: "the feature list plans show on the pricing page",
      run: features,
    },
    billing: {
      usage: ['billing [slug] <object> --cost <amount | formula | ""> [--label text] (--endpoint "GET /path" … | --all) [--yes]'],
      summary: "what endpoints count of a billable object per request",
      help: 'A whole number is a fixed amount per request; anything else is a formula; "" uses the object\'s default formula. On the edge gateway the cost can also be a usage source, e.g. {"source":"header","name":"x-units","default":1}. Charges change from the next request without notice; plans that do not include the object refuse those endpoints (402).',
      run: billing,
    },
    agents: {
      usage: ["agents [slug] [--json]", 'agents price [slug] <USD | off> (--endpoint "GET /path" … | --all)', "agents on|off [slug]"],
      summary: "what AI agents pay per request without a subscription",
      run: agents,
    },
    grant: {
      usage: ["grant [slug] <user nick> <object> <units> [--plan plan] [--note text] [--yes]"],
      summary: "add free quota to a subscriber's current period",
      help: "Needs the plans:write and subscriptions:read scopes. Not a charge; it expires when the period renews and the subscriber gets an email. It is never retried: running it again adds again.",
      run: grant,
    },
  },
};
