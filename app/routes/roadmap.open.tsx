import type { LoaderFunctionArgs } from 'react-router';
import { recordServerEvent } from '../lib/product-events.server';

/**
 * "Open my Health Roadmap" — the CTA target of the plan-ready email (US-22 AC5).
 *
 * Counts the click first-party, then redirects to the page the widget is
 * actually mounted on. Records nothing but the bare counter: no address, no
 * hash of one, no query echo. We want "how many people came back", never "who
 * opened their email" — product_events stays anonymous (SERVER_VISITOR_ID).
 *
 * The destination never comes from the request, so this cannot become an open
 * redirect.
 */

/** Verified live (200). The only page known to host the widget. */
const DEFAULT_ROADMAP_URL = 'https://drstanfield.com/pages/roadmap';

/**
 * Resolve the destination.
 *
 * Deliberately NOT derived from `SHOPIFY_STORE_URL`, which two live incidents
 * showed is unsafe to build a link from:
 *  - on the edu app it is a bare myshopify host with no scheme, so a naive
 *    `${base}/path` produced a RELATIVE Location and sent readers to a 404 on
 *    our own domain;
 *  - `microvitamin.com/pages/roadmap` 404s, so appending the path blindly
 *    breaks the commerce store.
 * `ROADMAP_URL` is therefore explicit per app, and anything without a scheme
 * is repaired rather than trusted.
 */
export function resolveRoadmapUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ROADMAP_URL?.trim();
  if (!configured) return DEFAULT_ROADMAP_URL;
  const trimmed = configured.replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export async function loader(_args: LoaderFunctionArgs) {
  await recordServerEvent('report_email_clicked');
  return new Response(null, {
    status: 302,
    headers: {
      Location: resolveRoadmapUrl(),
      // Mail scanners prefetch links; don't let a proxy cache the redirect and
      // hide later clicks from the counter.
      'Cache-Control': 'no-store',
    },
  });
}
