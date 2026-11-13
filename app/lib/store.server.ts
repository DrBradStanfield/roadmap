/**
 * The one Shopify store this Fly app serves.
 *
 * Two Fly apps run this same image (docs/deploy-runbook.md): health-tool-app
 * serves the brand store (microvitamin.com) and health-tool-edu serves the
 * education store (drstanfield.com). Each names its shop in
 * SHOPIFY_SHOP_DOMAIN; unset means the brand store.
 *
 * On Fly the two facts must agree (untangle S-17): FLY_APP_NAME, which Fly
 * sets on every machine, against the store the domain names. If they do not,
 * the process acts as no store: its store-specific crons stay off and one
 * Sentry error names the app and the store kinds, never the domain. Off Fly
 * (local dev, tests, CI) the domain alone decides, as before.
 *
 * This is the app's own store, fixed at boot. A request's shop (a session, an
 * app-proxy query) is a different question and is never read from here.
 */
import * as Sentry from '@sentry/react-router';

export const BRAND_SHOP_DOMAIN = 'microvitamin.myshopify.com';
export const EDU_SHOP_DOMAIN = 'sz5utw-1r.myshopify.com';

export type StoreKind = 'brand' | 'edu';

/** Which store a shop domain is. Anything but the edu shop is the brand store. */
export function storeKind(shopDomain: string): StoreKind {
  return shopDomain === EDU_SHOP_DOMAIN ? 'edu' : 'brand';
}

/** The store each Fly app serves: the `app` names in fly.toml and fly.edu.toml. */
const FLY_APP_STORE: Record<string, StoreKind> = {
  'health-tool-app': 'brand',
  'health-tool-edu': 'edu',
};

const PLAIN_MYSHOPIFY_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export type StoreIdentity =
  | { ok: true; kind: StoreKind; shopDomain: string }
  | { ok: false; reason: 'unknown-app'; flyAppName: string }
  | { ok: false; reason: 'malformed-domain' | 'unknown-shop'; flyAppName: string; expected: StoreKind }
  | { ok: false; reason: 'mismatch'; flyAppName: string; expected: StoreKind; named: StoreKind };

/** The store this process serves, from the Fly app name and the shop domain
 *  (trimmed; blank means the brand store). Pure. */
export function storeIdentity(env: { flyAppName?: string; shopDomain?: string }): StoreIdentity {
  const shopDomain = env.shopDomain?.trim() || BRAND_SHOP_DOMAIN;
  const flyAppName = env.flyAppName;
  if (!flyAppName) return { ok: true, kind: storeKind(shopDomain), shopDomain };
  const expected = FLY_APP_STORE[flyAppName];
  if (!expected) return { ok: false, reason: 'unknown-app', flyAppName };
  if (!PLAIN_MYSHOPIFY_HOST.test(shopDomain)) return { ok: false, reason: 'malformed-domain', flyAppName, expected };
  if (shopDomain !== BRAND_SHOP_DOMAIN && shopDomain !== EDU_SHOP_DOMAIN) {
    return { ok: false, reason: 'unknown-shop', flyAppName, expected };
  }
  const named = storeKind(shopDomain);
  if (named !== expected) return { ok: false, reason: 'mismatch', flyAppName, expected, named };
  return { ok: true, kind: named, shopDomain };
}

/** The failure in words: the app name and store kinds only, never the domain. */
function describeFailure(id: Exclude<StoreIdentity, { ok: true }>): string {
  const head = `Store identity check failed on Fly app ${id.flyAppName}`;
  const tail = 'Store-specific crons (trending) are off.';
  switch (id.reason) {
    case 'unknown-app': return `${head}: no known store for this app. ${tail}`;
    case 'malformed-domain': return `${head}: SHOPIFY_SHOP_DOMAIN is not a plain *.myshopify.com host (this app serves the ${id.expected} store). ${tail}`;
    case 'unknown-shop': return `${head}: SHOPIFY_SHOP_DOMAIN is neither known shop (this app serves the ${id.expected} store). ${tail}`;
    case 'mismatch': return `${head}: SHOPIFY_SHOP_DOMAIN names the ${id.named} store, this app serves the ${id.expected} store. ${tail}`;
  }
}

const STORE_IDENTITY = storeIdentity({
  flyAppName: process.env.FLY_APP_NAME,
  shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
});

let failureReported = false;

/** The store this process serves, or null when the identity check failed: then
 *  it must act as no store. The first null call logs and reports the failure. */
export function ownStore(): { kind: StoreKind; shopDomain: string } | null {
  if (STORE_IDENTITY.ok) return STORE_IDENTITY;
  if (!failureReported) {
    failureReported = true;
    const message = describeFailure(STORE_IDENTITY);
    console.error(message);
    Sentry.captureException(new Error(message), {
      tags: { feature: 'store_identity', fly_app: STORE_IDENTITY.flyAppName, reason: STORE_IDENTITY.reason },
    });
  }
  return null;
}
