import * as Sentry from '@sentry/react';
import { scrubSensitiveData, scrubBreadcrumbData, scrubUrl } from '@roadmap/health-core';

declare const __SENTRY_RELEASE__: string;

const SENTRY_DSN = 'https://d7664c1590ec997ebf0126ed5917fea4@o4510813459709952.ingest.us.sentry.io/4510813465280512';

let initialized = false;

/** Scrub fetch/xhr and console breadcrumbs of PII/PHI. */
function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  // Strip ALL non-primitive values from UI breadcrumbs — DOM element refs
  // contain React fiber circular references (__reactFiber$ → stateNode → element)
  if ((breadcrumb.category === 'ui.click' || breadcrumb.category === 'ui.input') && breadcrumb.data) {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(breadcrumb.data)) {
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        safe[k] = v;
      }
    }
    breadcrumb.data = safe;
  }
  // Scrub fetch/xhr breadcrumbs (request bodies contain health data)
  if ((breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr') && breadcrumb.data) {
    breadcrumb.data = scrubBreadcrumbData(breadcrumb.data as Record<string, unknown>);
  }
  // Scrub console breadcrumbs (may contain emails, health data in log output)
  if (breadcrumb.category === 'console') {
    if (breadcrumb.message) breadcrumb.message = '[Filtered]';
    if (breadcrumb.data) {
      breadcrumb.data = scrubSensitiveData(breadcrumb.data) as Record<string, unknown>;
    }
  }
  return breadcrumb;
}

/** Scrub PII/PHI from Sentry events before they leave the browser. */
function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  if (event.extra) {
    event.extra = scrubSensitiveData(event.extra) as Record<string, unknown>;
  }
  if (event.contexts) {
    event.contexts = scrubSensitiveData(event.contexts) as Record<string, Record<string, unknown>>;
  }
  if (event.request) {
    // Request body always contains health data in this app — remove entirely
    delete event.request.data;
    if (event.request.url) {
      event.request.url = scrubUrl(event.request.url);
    }
    if (event.request.query_string) {
      event.request.query_string = scrubUrl('?' + event.request.query_string).slice(1);
    }
    delete event.request.cookies;
    if (event.request.headers) {
      delete event.request.headers.cookie;
    }
  }
  // Scrub breadcrumbs embedded in the event
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map(b => scrubBreadcrumb({ ...b }))
      .filter((b): b is Sentry.Breadcrumb => b !== null);
  }
  return event;
}

export function initSentry() {
  if (initialized || SENTRY_DSN === 'YOUR_SENTRY_DSN') return;
  initialized = true;

  Sentry.init({
    dsn: SENTRY_DSN,
    release: typeof __SENTRY_RELEASE__ !== 'undefined' ? __SENTRY_RELEASE__ : undefined,
    environment: window.location.hostname.includes('myshopify.com') ? 'production' : 'development',
    // Only send 20% of transactions for performance monitoring
    tracesSampleRate: 0.2,
    // Don't send in development
    enabled: !window.location.hostname.includes('localhost'),
    // Limit serialization depth for Sentry event payloads
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
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}

export { Sentry };
