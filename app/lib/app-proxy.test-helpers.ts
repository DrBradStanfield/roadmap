/**
 * Sign a query the way Shopify's app proxy does, so a suite can build a real
 * proxied request (US-09 AC24): sort the keys, join `key=value` with no
 * separator (a repeated key's values comma-joined), HMAC-SHA256 with the app
 * secret. Pairs keep their order in the returned query string.
 */
import crypto from 'node:crypto';

export const TEST_PROXY_SECRET = 'test-shopify-secret';

export function proxySignature(pairs: [string, string][], secret = TEST_PROXY_SECRET): string {
  const values = new Map<string, string[]>();
  for (const [k, v] of pairs) values.set(k, [...(values.get(k) ?? []), v]);
  const message = [...values.keys()].sort().map((k) => `${k}=${values.get(k)!.join(',')}`).join('');
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/** `?a=1&b=2&signature=…` over exactly these pairs. */
export function signedQuery(pairs: [string, string][], secret = TEST_PROXY_SECRET): string {
  const qs = new URLSearchParams(pairs);
  qs.append('signature', proxySignature(pairs, secret));
  return `?${qs}`;
}

/** The params Shopify adds to every proxied request, for `customer`. */
export function proxyPairs(customer: string, nowSeconds = Math.floor(Date.now() / 1000)): [string, string][] {
  return [
    ['logged_in_customer_id', customer],
    ['path_prefix', '/apps/health-tool-1'],
    ['shop', 'microvitamin.myshopify.com'],
    ['timestamp', String(nowSeconds)],
  ];
}

/**
 * The duplicate-parameter forgery: a query Shopify really signed for `own` (a
 * guest when empty) with a second `logged_in_customer_id` naming `victim` put
 * in front. A verifier that keeps the LAST copy passes it; a reader that takes
 * the FIRST copy sees the victim.
 */
export function forgedQuery(victim: string, own: string, nowSeconds?: number): string {
  return `?logged_in_customer_id=${victim}&${signedQuery(proxyPairs(own, nowSeconds)).slice(1)}`;
}
