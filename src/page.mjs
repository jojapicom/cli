// The API page payload (GET v2/api-page) as the owner sees it: every endpoint,
// hidden and requests-off ones included, with its stored documentation; plans
// and releases. For a signed-in viewer the page adds auth header rows holding
// the viewer's own API keys (is_auth); they are dropped here, before any other
// code sees the payload, and the raw payload is never printed.

import { ok } from "./context.mjs";

function scrub(endpoint) {
  if (Array.isArray(endpoint?.parameters?.header)) endpoint.parameters.header = endpoint.parameters.header.filter((p) => !p.is_auth);
  return endpoint;
}

export async function loadPage(platform, slug) {
  const res = ok(await platform.get("v2/api-page", { slug }));
  const page = res.api ?? {};
  for (const endpoint of page.endpoints ?? []) scrub(endpoint);
  for (const group of page.endpoint_groups ?? []) for (const endpoint of group.endpoints ?? []) scrub(endpoint);
  return { page, url: res.seo?.canonical ?? null };
}

// Every endpoint of the page with its group, in the order the page shows them
export function pageEndpoints(page) {
  return (page.endpoint_groups ?? []).flatMap((group) =>
    [...(group.endpoints ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((endpoint) => ({ group, endpoint })),
  );
}
