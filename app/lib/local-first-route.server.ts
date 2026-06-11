/**
 * Shared plumbing for the LOCAL-FIRST public routes (api.google-token,
 * api.reminders-v2, future Phase-4 AI endpoints): the cross-origin allow-list,
 * CORS headers, client IP, and the text/plain simple-request body parse.
 *
 * Deliberately ZERO dependencies — unlike route-helpers.server.ts this never
 * drags in the Shopify session stack, so these routes stay decoupled from it.
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
 * would drag the Shopify session stack into this zero-dep module. Shopify
 * signs proxied requests by sorting the query params (minus `signature`),
 * joining the `key=value` pairs with no separator (multi-values
 * comma-joined), and HMAC-SHA256ing with the app secret. A ±10-minute
 * timestamp window bounds replay.
 */
export function verifyAppProxySignature(request: Request, nowSeconds = Date.now() / 1000): boolean {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return false;
  const url = new URL(request.url);
  const signature = url.searchParams.get('signature');
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;

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
  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))) return false;

  const ts = Number(url.searchParams.get('timestamp') || 0);
  return Math.abs(nowSeconds - ts) < 600;
}

/**
 * The public standalone app (GitHub Pages is the only public front door until
 * Phase 5 — switch to the drstanfield.com page at the Shopify port). Used for
 * email CTAs and anywhere the server must name the app's URL.
 */
export const PAGES_APP_URL = 'https://drbradstanfield.github.io/roadmap/';

/** First hop of x-forwarded-for (Fly sets it). */
export function getClientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export function corsHeaders(request: Request, origins: Set<string> = ALLOWED_ORIGINS): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  if (!origins.has(origin)) return { Vary: 'Origin' };
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
