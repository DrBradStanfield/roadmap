/**
 * Shared plumbing for the LOCAL-FIRST public routes: the cross-origin
 * allow-list + CORS headers (api.google-token, api.reminders-v2 — called
 * cross-origin from github.io), the app-proxy signature check (the AI
 * lab-import endpoint — called same-origin through the Shopify proxy), client
 * IP, and the text/plain simple-request body parse.
 *
 * Deliberately ZERO *application* dependencies — unlike route-helpers.server.ts
 * this never drags in the Shopify session stack, so these routes stay decoupled
 * from it. Node built-ins (node:crypto for the HMAC verify) are fine.
 *
 * HARD RULE (Brad, 2026-06-10): localhost is NEVER an approved origin — not
 * here, not in the Google OAuth client, not in Dropbox redirect URIs, not in
 * any future allow-list. This module is the ONE place the rule is enforced
 * for Fly routes; OAuth-flow testing happens on the github.io surfaces.
 */

/** Every front door that may call the local-first Fly routes cross-origin. */
export const ALLOWED_ORIGINS = new Set([
  'https://drbradstanfield.github.io',
  'https://drstanfield.com',
]);

import crypto from 'node:crypto';

/** Proxied requests older than this are rejected as replay (Shopify standard). */
const PROXY_TIMESTAMP_WINDOW_SECONDS = 10 * 60;

/**
 * AI endpoints (lab extraction) — app-proxy HMAC ONLY since the Phase-5
 * hardening (2026-06-11; supersedes the drstanfield.com Origin allow-list,
 * which any non-browser client could forge). Brad pays per Claude call, so
 * the Brad-funded AI path is reserved for the storefront page, which reaches
 * these routes THROUGH the Shopify app proxy — every request carries
 * Shopify's un-forgeable signature. The GitHub Pages / self-host build runs
 * uploads + chat with the USER's own Anthropic key (byok-upload.ts /
 * byok-chat.ts) and never calls these routes. The non-AI plumbing
 * (google-token, reminders-v2) stays on ALLOWED_ORIGINS — Drive connect and
 * email reminders work cross-origin from every front door.
 *
 * Standalone verifier — deliberately NOT authenticate.public.appProxy, which
 * would drag the Shopify session stack into this module. Shopify signs
 * proxied requests by sorting the query params (minus `signature`), joining
 * the `key=value` pairs with no separator (multi-values comma-joined), and
 * HMAC-SHA256ing with the app secret.
 *
 * Shopify sends each of its own params once, so a second copy is a forgery
 * (US-09 AC24): Shopify's library verifies the LAST copy and
 * `searchParams.get` reads the FIRST, so the two disagree about who is asking.
 */
const SHOPIFY_PROXY_PARAMS = ['logged_in_customer_id', 'path_prefix', 'shop', 'signature', 'timestamp'];

export function verifyAppProxySignature(request: Request, nowSeconds = Date.now() / 1000): boolean {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return false;
  const url = new URL(request.url);
  if (SHOPIFY_PROXY_PARAMS.some((k) => url.searchParams.getAll(k).length > 1)) return false;
  const signature = url.searchParams.get('signature');
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;

  // Freshness first: stale/garbage timestamps are rejected before paying for
  // the HMAC. The timestamp is itself signed, so check order can't widen the
  // accept set.
  const ts = Number(url.searchParams.get('timestamp') || 0);
  if (!(Math.abs(nowSeconds - ts) < PROXY_TIMESTAMP_WINDOW_SECONDS)) return false;

  const params = new Map<string, string[]>();
  for (const [k, v] of url.searchParams) {
    if (k === 'signature') continue;
    const list = params.get(k) ?? [];
    list.push(v);
    params.set(k, list);
  }
  const message = [...params.keys()]
    .sort()
    .map((k) => `${k}=${params.get(k)!.join(',')}`)
    .join('');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

/**
 * Refuse an app-proxy request (it carries `signature`) on a route that is not
 * for one: the index and the admin routes (US-09 AC24). The proxy maps the
 * whole app root, and both the index's old redirect and `authenticate.admin`'s
 * bounce page copy the query, `signature` included, into a Location header,
 * handing anyone a freshly signed query. The admin launch signs with `hmac`
 * and never carries `signature`, so it passes.
 */
export function refuseAppProxyRequest(request: Request): void {
  if (new URL(request.url).searchParams.has('signature')) {
    throw new Response('Not Found', { status: 404 });
  }
}

/**
 * The caller's IP, as far as anything here can know it. Every rate limiter in
 * the app keys on this one reader (2026-09-02) — a second copy would silently
 * reopen a bypass — so the caller must name which of THREE trust models its
 * route lives under, because they disagree about who the client is.
 *
 * 1. `'fly'` — the browser reaches Fly directly (mcp, google-token,
 *    reminders-v2). `Fly-Client-IP` is "the IP address of the client from the
 *    perspective of Fly Proxy" (https://fly.io/docs/networking/request-headers/):
 *    Fly's own TCP peer, so unforgeable, and here the peer IS the client.
 * 2. `'shopify'` — the browser reaches Fly THROUGH the HMAC-verified Shopify
 *    app proxy (chat, feedback, lab-import, measurements). Fly's peer is now
 *    Shopify's egress, so `Fly-Client-IP` names Shopify — every shopper
 *    collapses into one shared bucket. The shopper is the hop SHOPIFY added
 *    to `X-Forwarded-For`, which sits immediately to the left of the entry
 *    Fly saw. Anchor on `Fly-Client-IP` and step one left: that survives Fly
 *    also appending its app's own address ("the last address (rightmost) in
 *    this list will be a shared or dedicated IP address assigned to your
 *    app") and any number of forged leading hops. Fly is not documented to
 *    append its peer at all; when its address is absent from the list, the
 *    LAST hop is Shopify's own append — the shopper — so use that.
 * 3. Local dev — no proxy at all. No `Fly-Client-IP`, and a single-entry XFF
 *    is the caller. Forgeable, and that is fine off Fly: nothing of value sits
 *    behind these limiters there. Production always runs on Fly.
 *
 * The FIRST `X-Forwarded-For` entry is never trusted in any model: a request
 * that arrives carrying its own XFF keeps it, so the left of the list is
 * whatever the caller typed. Only entries a proxy we trust appended count.
 * If XFF yields no hop at all (missing, blank, or holding only Fly's own
 * address), `'shopify'` falls back to `Fly-Client-IP` — one shared bucket
 * beats none.
 *
 * Residual (US-09 AC24): the HMAC check proves Shopify signed the QUERY, not
 * that the request came through Shopify. Anyone holding a valid signed query
 * can send it straight to *.fly.dev with an XFF they wrote. Fly's peer is then
 * the caller, and the hop read as the shopper (one left of the caller's own
 * address if Fly appended it, else the last) is one the caller typed, so a
 * direct hit can steer its bucket. `Fly-Client-IP` cannot be the key instead: behind the proxy it is
 * Shopify's egress, every shopper's (docs/reference.md, the Fly-Client-IP
 * gotcha). The mitigation is closing the leaks that hand out signed queries
 * (the index and admin routes refuse `signature`, `refuseAppProxyRequest`).
 */
export function getClientIp(request: Request, trust: 'fly' | 'shopify'): string {
  const flyIp = request.headers.get('fly-client-ip')?.trim() || '';
  if (trust === 'shopify') {
    const hops = (request.headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    if (flyIp) {
      // Read from the RIGHT, the only end a forger cannot reach.
      const anchor = hops.lastIndexOf(flyIp);
      const shopper = anchor >= 0 ? hops[anchor - 1] : hops[hops.length - 1];
      if (shopper) return shopper;
    } else if (hops.length === 1) {
      return hops[0]; // local dev: nobody added a hop
    }
  }
  return flyIp || 'unknown';
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  if (!ALLOWED_ORIGINS.has(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Parse the body as JSON regardless of Content-Type: clients send text/plain
 * so the POST stays a CORS "simple request" — remix-serve answers OPTIONS
 * with 405 before route handlers run, so a preflight would always fail.
 * Returns null on malformed input (caller turns that into a 400).
 */
export async function parseSimpleRequestJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.text());
  } catch {
    return null;
  }
}
