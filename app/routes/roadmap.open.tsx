import type { LoaderFunctionArgs } from 'react-router';
import { recordServerEvent } from '../lib/product-events.server';

/**
 * The button target of both emails: "Open the Health Roadmap" in the plan-ready
 * email (US-22 AC5) and in every reminder (US-23 AC10, `?src=reminder`).
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
 * redirect. The query only picks which counter moves, by exact equality.
 */
export const ROADMAP_URL = 'https://drstanfield.com/pages/roadmap';

/** Where the redirect lands: its own constant, because ROADMAP_URL is also
 *  shown as text in calendar events (US-24 AC2). Built from the literal above,
 *  so the two cannot point at different pages. `from=email` tells the widget
 *  this reader came from an email, so an empty tool can say why (US-22 AC13). */
export const EMAIL_LANDING_URL = `${ROADMAP_URL}?from=email`;

export async function loader({ request }: LoaderFunctionArgs) {
  const reminder = new URL(request.url).searchParams.get('src') === 'reminder';
  // Not awaited: the reader should not wait on a Supabase insert (the client
  // has no fetch timeout), and recordServerEvent never throws.
  void recordServerEvent(reminder ? 'reminder_email_clicked' : 'report_email_clicked');
  return new Response(null, {
    status: 302,
    headers: {
      Location: EMAIL_LANDING_URL,
      // Mail scanners prefetch links; don't let a proxy cache the redirect and
      // hide later clicks from the counter.
      'Cache-Control': 'no-store',
    },
  });
}
