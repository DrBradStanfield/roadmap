import type { LoaderFunctionArgs } from 'react-router';
import { recordServerEvent } from '../lib/product-events.server';

/**
 * "Open my Health Roadmap" — the CTA target of the plan-ready email (US-22 AC5).
 *
 * Counts the click first-party, then redirects to the storefront where the
 * widget lives. Deliberately records nothing but the bare counter: no address,
 * no hash of one, no query echo. We want "how many people came back", never
 * "who opened their email" — product_events stays anonymous (see
 * SERVER_VISITOR_ID).
 *
 * The destination is a server-side constant, never anything from the request,
 * so this can't be turned into an open redirect.
 */
export async function loader(_args: LoaderFunctionArgs) {
  await recordServerEvent('report_email_clicked');
  const destination = process.env.SHOPIFY_STORE_URL || 'https://drstanfield.com';
  return new Response(null, {
    status: 302,
    headers: {
      Location: destination,
      // Mail scanners prefetch links; don't let a proxy cache the redirect and
      // hide later clicks from the counter.
      'Cache-Control': 'no-store',
    },
  });
}
