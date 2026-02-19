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
      // Third-party fetch interceptors (Appstle Bundles) create unhandled rejections
      // from our fetch calls. Our api.ts already catches and handles these.
      /Failed to fetch/,
    ],
    allowUrls: [
      // Only capture errors originating from our own widget bundles
      /health-tool\.js/,
      /health-history\.js/,
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
