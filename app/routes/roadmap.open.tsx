import type { LoaderFunctionArgs } from 'react-router';
import { recordServerEvent } from '../lib/product-events.server';

/**
 * "Open my Health Roadmap" — the CTA target of the plan-ready email (US-22 AC5).
 *
 * Counts the click first-party, then redirects to the tool. Records nothing but
 * the bare counter: no address, no hash of one, no query echo. We want "how
 * many people came back", never "who opened their email" — product_events stays
 * anonymous (SERVER_VISITOR_ID).
 *
 * ONE hardcoded destination, for both Fly apps (Brad, 2026-08-12). This is the
 * only page that hosts the widget, and hardcoding it deletes a whole class of
 * bug that shipped once already: the first version derived the URL from
 * `SHOPIFY_STORE_URL`, which is a bare myshopify host with no scheme on the edu
 * app — so the Location header came out RELATIVE and sent readers to a 404 on
 * our own domain. `microvitamin.com/pages/roadmap` also 404s, so no per-app
 * value was safe either. A literal absolute URL cannot fail those ways.
 *
 * The destination never comes from the request, so this cannot become an open
 * redirect.
 */
export const ROADMAP_URL = 'https://drstanfield.com/pages/roadmap';

export async function loader(_args: LoaderFunctionArgs) {
  await recordServerEvent('report_email_clicked');
  return new Response(null, {
    status: 302,
    headers: {
      Location: ROADMAP_URL,
      // Mail scanners prefetch links; don't let a proxy cache the redirect and
      // hide later clicks from the counter.
      'Cache-Control': 'no-store',
    },
  });
}
