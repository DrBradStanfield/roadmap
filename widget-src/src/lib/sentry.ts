import * as Sentry from '@sentry/react';

// Replace with your actual Sentry DSN after creating a project at https://sentry.io
const SENTRY_DSN = 'https://d7664c1590ec997ebf0126ed5917fea4@o4510813459709952.ingest.us.sentry.io/4510813465280512';

let initialized = false;

export function initSentry() {
  if (initialized || SENTRY_DSN === 'YOUR_SENTRY_DSN') return;
  initialized = true;

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: window.location.hostname.includes('myshopify.com') ? 'production' : 'development',
    // Only send 20% of transactions for performance monitoring
    tracesSampleRate: 0.2,
    // Don't send in development
    enabled: !window.location.hostname.includes('localhost'),
    // Limit serialization depth to avoid circular refs from React fiber on DOM elements
    normalizeDepth: 5,
    ignoreErrors: [
      // Shopify's privacy banner failing to reach their own analytics endpoint
      /monorail-edge\.shopifysvc\.com/,
      // UpPromote affiliate app: URIError from their getCookie on malformed cookie values
      /getCookie.*uppromote/,
    ],
    denyUrls: [
      // Shopify's privacy/cookie consent banner: URIError from decodeURIComponent on malformed cookies
      /cdn\/shopifycloud\/privacy-banner/,
    ],
    beforeBreadcrumb(breadcrumb) {
      // Strip DOM element data from UI breadcrumbs to prevent circular refs
      if (breadcrumb.category === 'ui.click' && breadcrumb.data) {
        delete breadcrumb.data.target;
      }
      return breadcrumb;
    },
  });
}

export { Sentry };
