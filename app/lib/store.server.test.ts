import { describe, it, expect } from 'vitest';
import { storeIdentity, BRAND_SHOP_DOMAIN, EDU_SHOP_DOMAIN } from './store.server';

// US-28 (daily crons) + untangle S-17: the app's own store is two facts that
// must agree on Fly, the Fly app name (fly.toml: health-tool-app, fly.edu.toml:
// health-tool-edu) and SHOPIFY_SHOP_DOMAIN. Off Fly the domain alone decides,
// as before.
const BRAND = BRAND_SHOP_DOMAIN;
const EDU = EDU_SHOP_DOMAIN;

describe('storeIdentity (S-17)', () => {
  it.each([
    // Off Fly (local dev, tests, CI): unchanged, the domain alone decides.
    [undefined, undefined, { ok: true, kind: 'brand', shopDomain: BRAND }],
    ['', '', { ok: true, kind: 'brand', shopDomain: BRAND }],
    [undefined, BRAND, { ok: true, kind: 'brand', shopDomain: BRAND }],
    [undefined, EDU, { ok: true, kind: 'edu', shopDomain: EDU }],
    [undefined, `${EDU}\n`, { ok: true, kind: 'edu', shopDomain: EDU }],
    [undefined, 'other.myshopify.com', { ok: true, kind: 'brand', shopDomain: 'other.myshopify.com' }],
    // health-tool-app serves the brand store; unset means the brand store.
    ['health-tool-app', undefined, { ok: true, kind: 'brand', shopDomain: BRAND }],
    ['health-tool-app', '', { ok: true, kind: 'brand', shopDomain: BRAND }],
    ['health-tool-app', BRAND, { ok: true, kind: 'brand', shopDomain: BRAND }],
    ['health-tool-app', ` ${BRAND}\n`, { ok: true, kind: 'brand', shopDomain: BRAND }],
    ['health-tool-app', EDU, { ok: false, reason: 'mismatch', flyAppName: 'health-tool-app', expected: 'brand', named: 'edu' }],
    // health-tool-edu serves the edu store; unset is the brand default, so a mismatch.
    ['health-tool-edu', EDU, { ok: true, kind: 'edu', shopDomain: EDU }],
    ['health-tool-edu', `${EDU}\n`, { ok: true, kind: 'edu', shopDomain: EDU }],
    ['health-tool-edu', `\t${EDU} `, { ok: true, kind: 'edu', shopDomain: EDU }],
    ['health-tool-edu', undefined, { ok: false, reason: 'mismatch', flyAppName: 'health-tool-edu', expected: 'edu', named: 'brand' }],
    ['health-tool-edu', '   ', { ok: false, reason: 'mismatch', flyAppName: 'health-tool-edu', expected: 'edu', named: 'brand' }],
    ['health-tool-edu', BRAND, { ok: false, reason: 'mismatch', flyAppName: 'health-tool-edu', expected: 'edu', named: 'brand' }],
    // Not a plain *.myshopify.com host: refused, never read as the brand store.
    ['health-tool-app', 'microvitamin.com', { ok: false, reason: 'malformed-domain', flyAppName: 'health-tool-app', expected: 'brand' }],
    ['health-tool-edu', `https://${EDU}`, { ok: false, reason: 'malformed-domain', flyAppName: 'health-tool-edu', expected: 'edu' }],
    ['health-tool-edu', `${EDU}/admin`, { ok: false, reason: 'malformed-domain', flyAppName: 'health-tool-edu', expected: 'edu' }],
    ['health-tool-edu', `sz5utw-1r .myshopify.com`, { ok: false, reason: 'malformed-domain', flyAppName: 'health-tool-edu', expected: 'edu' }],
    ['health-tool-edu', `${EDU}\nx`, { ok: false, reason: 'malformed-domain', flyAppName: 'health-tool-edu', expected: 'edu' }],
    ['health-tool-app', 'MICROVITAMIN.myshopify.com', { ok: false, reason: 'malformed-domain', flyAppName: 'health-tool-app', expected: 'brand' }],
    // A plain myshopify host that is neither known shop: refused.
    ['health-tool-app', 'other.myshopify.com', { ok: false, reason: 'unknown-shop', flyAppName: 'health-tool-app', expected: 'brand' }],
    ['health-tool-edu', 'other.myshopify.com', { ok: false, reason: 'unknown-shop', flyAppName: 'health-tool-edu', expected: 'edu' }],
    // A Fly app this repo does not deploy: no store to check against.
    ['health-tool-staging', BRAND, { ok: false, reason: 'unknown-app', flyAppName: 'health-tool-staging' }],
    ['health-tool-staging', undefined, { ok: false, reason: 'unknown-app', flyAppName: 'health-tool-staging' }],
  ])('app %j, domain %j', (flyAppName, shopDomain, expected) => {
    expect(storeIdentity({ flyAppName, shopDomain })).toEqual(expected);
  });
});
