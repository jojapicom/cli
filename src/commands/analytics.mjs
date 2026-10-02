// Reading what happens on your APIs: the API list with recent traffic, usage
// over time, request logs, transactions and subscribers.

import { ApiError } from "../api.mjs";
import { api, columns, ok, printJson, resolveSlugAndDir, when } from "../context.mjs";

const PERIODS = ["hour", "day", "month", "year"];

async function apis(positional, flags) {
  const platform = api();
  const list = ok(await platform.get("v2/ProviderApis")).apis ?? [];
  // Traffic needs analytics:read; without it the list still prints
  let traffic = null;
  try {
    const res = await platform.get("v2/provider-apis-traffic");
    if (res.status === "success") traffic = res.apis ?? {};
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
  }
  if (flags.json) return printJson({ apis: list.map((a) => ({ ...a, traffic_7d: traffic ? { requests: traffic[a.slug]?.total ?? 0, errors: traffic[a.slug]?.errors_total ?? 0 } : null })) });
  if (!list.length) {
    console.log("no APIs yet — create one: jojapi create <slug> --name \"…\"");
    return 0;
  }
  const header = ["SLUG", "NAME", "GATEWAY", "ENDPOINTS", "MARKETPLACE", ...(traffic ? ["REQUESTS 7D", "5XX 7D"] : [])];
  const rows = list.map((a) => [
    a.slug,
    a.name,
    a.gateway,
    a.endpoints,
    [a.marketplace_status ?? "private", a.blocked && "blocked"].filter(Boolean).join(", "),
    ...(traffic ? [traffic[a.slug]?.total ?? 0, traffic[a.slug]?.errors_total ?? 0] : []),
  ]);
  console.log(columns([header, ...rows]));
  return 0;
}

async function dashboard(positional, flags) {
  const platform = api();
  const { dashboard: d } = ok(await platform.get("v2/studio/dashboard"));
  const uptime = ok(await platform.get("v2/studio-low-uptime-endpoints", { limit: 5 })).low_uptime_endpoints ?? [];
  if (flags.json) return printJson({ dashboard: d, low_uptime_endpoints: uptime });
  const money = (byCurrency) => Object.entries(byCurrency ?? {}).map(([currency, amount]) => `${Number(amount).toFixed(2)} ${currency.toUpperCase()}`).join(", ") || "0";
  const s = d.subscriptions ?? {};
  console.log(columns([
    ["APIs", d.api_count],
    ["subscriptions", `${s.paid ?? 0} paid · ${s.free ?? 0} free · ${s.payasyougo ?? 0} pay as you go · ${s.per_request ?? 0} per request`],
    ["revenue", `this month ${money(d.transactions_total?.this_month)} · last 30 days ${money(d.transactions_total?.last_month)}`],
    ["requests", d.total_requests_readable ?? d.total_requests],
  ]));
  const codes = Object.entries(d.usage_stats ?? {}).sort(([a], [b]) => Number(a) - Number(b));
  if (codes.length) {
    console.log("\n" + columns([["STATUS", "REQUESTS", "AVG MS"], ...codes.map(([code, u]) => [code, u.requests, u.requests ? Math.round((u.latency / u.requests) * 1000) : ""])]));
  }
  if (uptime.length) {
    console.log("\nlowest uptime (30 days):\n" + columns(uptime.map((u) => [`${u.uptime_ratio}%`, u.api.slug, `${u.endpoint.method} ${u.endpoint.url_path}`, u.endpoint.name])));
  }
  return 0;
}

async function traffic(positional, flags) {
  const { slug } = resolveSlugAndDir(positional.slice(0, 1), flags, false);
  const period = typeof flags.period === "string" ? flags.period : "day";
  if (!PERIODS.includes(period)) throw new Error(`--period is one of ${PERIODS.join(", ")}`);
  const params = { type: "usage", period, api: slug, username: typeof flags.user === "string" ? flags.user : undefined };
  if (typeof flags.from === "string") {
    params.start_date = flags.from;
    if (typeof flags.to === "string") params.end_date = flags.to;
  } else {
    params.range = typeof flags.range === "string" ? flags.range : { hour: 24, day: 30, month: 12, year: 3 }[period];
  }
  if (params.username && !slug) throw new Error("--user needs an API: pass its slug");
  const res = await api().get("v2/studio-analytics-api", params);
  if (res.status === "no_usage_data") {
    if (flags.json) return printJson({ chart: {} });
    console.log("no usage in this period");
    return 0;
  }
  const data = ok(res).data;
  if (flags.json) return printJson(data);
  const objects = data.objects ?? [];
  const rows = Object.entries(data.chart ?? {}).map(([label, codes]) => {
    const sum = { r: 0, ok: 0, c4: 0, c5: 0, l: 0, o: {} };
    for (const [code, v] of Object.entries(codes)) {
      sum.r += v.r ?? 0;
      sum.l += v.l ?? 0;
      if (Number(code) >= 500) sum.c5 += v.r ?? 0;
      else if (Number(code) >= 400) sum.c4 += v.r ?? 0;
      else sum.ok += v.r ?? 0;
      for (const [object, units] of Object.entries(v.o ?? {})) sum.o[object] = (sum.o[object] ?? 0) + Number(units);
    }
    return [label, sum.r, sum.ok, sum.c4, sum.c5, sum.r ? Math.round((sum.l / sum.r) * 1000) : "", ...objects.map((o) => sum.o[o.slug] ?? 0)];
  });
  console.log(`${slug ?? "all APIs"} · ${data.start_date} → ${data.end_date} (server time)`);
  console.log(columns([["PERIOD", "REQUESTS", "2XX/3XX", "4XX", "5XX", "AVG MS", ...objects.map((o) => `${o.name.toUpperCase()} USED`)], ...rows]));
  return 0;
}

// Never printed as they are: the consumer's credentials and cookies. A jk_ key
// can also hide in another header (a request carrying it twice), so every
// value is scrubbed.
const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-jojapi-key", "x-api-key"]);

function redact(value) {
  if (typeof value === "string") return value.replace(/jk_[A-Za-z0-9_-]+/g, (key) => `jk_…${key.slice(-4)}`);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_HEADERS.has(k.toLowerCase()) ? "[redacted]" : redact(v)]));
  return value;
}

async function requests(positional, flags) {
  const { slug } = resolveSlugAndDir(positional.slice(0, 1), flags);
  const params = {
    api: slug,
    limit: typeof flags.limit === "string" ? flags.limit : 50,
    offset: typeof flags.offset === "string" ? flags.offset : undefined,
    status: typeof flags.status === "string" ? flags.status : undefined,
    username: typeof flags.user === "string" ? flags.user : undefined,
  };
  const res = ok(await api().get("v2/request-logs-studio", params));
  const logs = (res.logs ?? []).map((log) => redact(log));
  if (flags.json) return printJson({ logs });
  if (!logs.length) {
    console.log("no requests found");
    return 0;
  }
  const usage = (log) => (log.used_objects?.length ? log.used_objects.map((o) => `${o.amount} ${o.slug}`).join(", ") : log.used_credits ? `${log.used_credits} credits` : "");
  if (!flags.details) {
    console.log(columns([
      ["DATE", "STATUS", "ENDPOINT", "MS", "USAGE", "USER", "COUNTRY", "DEPLOYMENT"],
      ...logs.map((log) => [when(log.date), log.response?.code, `${log.endpoint?.method ?? ""} ${log.request?.path ?? log.endpoint?.base_url ?? ""}`, log.latency === null || log.latency === undefined ? "" : Math.round(log.latency * 1000), usage(log), log.user?.username, log.client?.country, log.deployment ?? ""]),
    ]));
    return 0;
  }
  for (const log of logs) {
    console.log(`${when(log.date)}  ${log.response?.code}  ${log.endpoint?.method ?? ""} ${log.request?.path ?? ""}${log.request?.url_query ? `?${typeof log.request.url_query === "string" ? log.request.url_query : new URLSearchParams(log.request.url_query).toString()}` : ""}`);
    console.log(`  endpoint ${log.endpoint?.name ?? "—"} · user ${log.user?.username ?? "—"} · ${log.client?.country ?? ""} ${log.client?.ip ?? ""} · ${log.latency === undefined ? "" : `${Math.round(log.latency * 1000)} ms`}${usage(log) ? ` · ${usage(log)}` : ""}${log.deployment ? ` · deployment ${log.deployment}` : ""}`);
    console.log(`  request headers ${JSON.stringify(log.request?.headers ?? {})}`);
    console.log(`  response headers ${JSON.stringify(log.response?.headers ?? {})}`);
    if (log.response?.body !== null && log.response?.body !== undefined) console.log(`  response body ${typeof log.response.body === "string" ? log.response.body : JSON.stringify(log.response.body)}`);
    console.log("");
  }
  return 0;
}

const PERIOD_NAMES = { "1 WEEK": "week", "1 MONTH": "month", "3 MONTH": "quarter", "1 YEAR": "year" };

function price(plan) {
  if (!plan) return "";
  if (plan.type === "payasyougo") return "pay as you go";
  const amount = Number(plan.pricing?.price ?? 0);
  return amount === 0 ? "free" : `${amount.toFixed(2)} ${(plan.price?.currency ?? "usd").toUpperCase()}/${PERIOD_NAMES[plan.period] ?? plan.period ?? "month"}`;
}

async function transactions(positional, flags) {
  const { slug } = resolveSlugAndDir(positional.slice(0, 1), flags, false);
  const limit = Number(typeof flags.limit === "string" ? flags.limit : 50);
  const all = ok(await api().get("v2/ProviderTransactions")).transactions ?? [];
  const list = all.filter((t) => !slug || t.api?.slug === slug).slice(0, limit);
  if (flags.json) return printJson({ transactions: list });
  if (!list.length) {
    console.log("no transactions");
    return 0;
  }
  console.log(columns([
    ["DATE", "API", "USER", "TYPE", "AMOUNT", "STATUS", "REFUNDED"],
    ...list.map((t) => {
      const x = t.transaction ?? {};
      const amount = x.amount ?? t.plan?.pricing?.price;
      return [when(x.created_at), t.api?.slug, `${t.user?.nick ?? ""}${t.user?.kind === "agent" ? " (agent)" : ""}`, x.type, amount === null || amount === undefined ? "" : `${Number(amount).toFixed(2)} ${(x.currency ?? "usd").toUpperCase()}`, x.status, x.refunded?.amount ? Number(x.refunded.amount).toFixed(2) : ""];
    }),
  ]));
  return 0;
}

async function subscribers(positional, flags) {
  const { slug } = resolveSlugAndDir(positional.slice(0, 1), flags, false);
  const all = ok(await api().get("v2/ProviderSubscriptions")).subscriptions ?? [];
  // Raw subscription and transfer ids are left out of every output
  const list = all.filter((s) => !slug || s.api?.slug === slug).map(({ subscription, pending_transfer, ...rest }) => ({
    ...rest,
    subscription: subscription ? { ...subscription, id: undefined } : subscription,
    pending_transfer: pending_transfer ? { ...pending_transfer, id: undefined } : null,
  }));
  if (flags.json) return printJson({ subscriptions: list });
  if (!list.length) {
    console.log("no active subscriptions");
    return 0;
  }
  const usage = (s) => (s.subscription?.current_period?.objects ?? []).map((o) => (o.quota !== undefined && o.quota !== null ? `${o.used}/${o.quota} ${o.slug}` : `${o.used} ${o.slug}`)).join(", ");
  console.log(columns([
    ["USER", "API", "PLAN", "STATUS", "SINCE", "PERIOD ENDS", "USAGE", "TRANSFER"],
    ...list.map((s) => [
      `${s.user?.nick ?? ""}${s.user?.kind === "agent" ? " (agent)" : ""}`,
      s.api?.slug,
      `${s.plan?.name ?? s.plan?.slug ?? ""} (${price(s.plan)})`,
      [s.subscription?.status, s.subscription?.cancel_next && "cancels at period end"].filter(Boolean).join(", "),
      when(s.subscription?.created_at).slice(0, 10),
      when(s.subscription?.current_period?.end_at).slice(0, 10),
      usage(s),
      s.pending_transfer ? `→ ${s.pending_transfer.target_plan?.name ?? s.pending_transfer.target_plan?.slug} (${s.pending_transfer.status})` : "",
    ]),
  ]));
  return 0;
}

export default {
  title: "Analytics",
  commands: {
    apis: {
      usage: ["apis [--json]"],
      summary: "your APIs with gateway, endpoints, marketplace status and 7-day traffic",
      help: "Traffic needs the analytics:read scope; without it the list prints without those columns.",
      run: apis,
    },
    dashboard: {
      usage: ["dashboard [--json]"],
      summary: "subscriptions, revenue, requests by status and the lowest-uptime endpoints",
      run: dashboard,
    },
    traffic: {
      usage: ["traffic [slug] [--period hour|day|month|year] [--range N | --from YYYY-MM-DD [--to YYYY-MM-DD]] [--user nick] [--json]"],
      summary: "requests, status classes, latency and billable units over time",
      help: "Without a slug (and outside a project directory) it covers all your APIs. The default range is the last 24 hours, 30 days, 12 months or 3 years. Dates are the platform's server time.",
      run: traffic,
    },
    requests: {
      usage: ["requests [slug] [--status 502] [--user nick] [--limit 50] [--offset 0] [--details] [--json]"],
      summary: "the request log, newest first",
      help: "--details adds the request path and query, headers, the consumer's IP and the response headers and body. Credentials and cookies are always redacted, also in --json. Request bodies are never logged.",
      run: requests,
    },
    transactions: {
      usage: ["transactions [slug] [--limit 50] [--json]"],
      summary: "payments, renewals and refunds on your APIs, newest first",
      run: transactions,
    },
    subscribers: {
      usage: ["subscribers [slug] [--json]"],
      summary: "active and past-due subscriptions with their usage and pending plan transfers",
      run: subscribers,
    },
  },
};
