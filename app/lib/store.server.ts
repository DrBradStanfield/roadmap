/**
 * The one Shopify store this Fly app serves.
 *
 * Two Fly apps run this same image (docs/deploy-runbook.md): health-tool-app
 * serves the brand store (microvitamin.com) and health-tool-edu serves the
 * education store (drstanfield.com). Each names its shop in
 * SHOPIFY_SHOP_DOMAIN; unset means the brand store.
 *
 * This is the app's own store, fixed at boot. A request's shop (a session, an
 * app-proxy query) is a different question and is never read from here.
 */
export const BRAND_SHOP_DOMAIN = 'microvitamin.myshopify.com';
export const EDU_SHOP_DOMAIN = 'sz5utw-1r.myshopify.com';

export type StoreKind = 'brand' | 'edu';

/** Which store a shop domain is. Anything but the edu shop is the brand store. */
export function storeKind(shopDomain: string): StoreKind {
  return shopDomain === EDU_SHOP_DOMAIN ? 'edu' : 'brand';
}

export const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN || BRAND_SHOP_DOMAIN;
export const STORE_KIND: StoreKind = storeKind(SHOP_DOMAIN);
