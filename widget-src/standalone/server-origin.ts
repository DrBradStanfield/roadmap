/** Brad's Fly server, called directly for the Google token exchange and the
 *  reminders API. A build constant: never read it from page data or the URL.
 *  The local Shopify-like dev build rewrites this string to its stub prefix
 *  (localiseBradServer in shopify-dev/storefront.ts), so localhost never calls
 *  production; shopify-dev/dev-transports.test.ts (US-20 AC5) proves it. */
export const BRAD_SERVER_ORIGIN = 'https://health-tool-app.fly.dev';
