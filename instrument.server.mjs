// Server-side Sentry init for React Router 7. Loaded via `node --import ./instrument.server.mjs`
// (set in package.json `start`, shopify.web.toml `dev`, and the Dockerfile CMD) so the SDK
// instruments the runtime BEFORE the app bundle loads — the RR7 replacement for the old
// `Sentry.init()` that lived at the top of app/entry.server.tsx.
//
// CRITICAL (HIPAA): the beforeSend / beforeBreadcrumb scrubbing below removes PII/PHI before
// any event leaves the server. This logic is moved verbatim from the old entry.server.tsx —
// do not weaken it. The scrub helpers come from ./instrument-scrub.mjs (a self-contained,
// plain-ESM copy) rather than @roadmap/health-core: this file is `node --import`-ed before the
// server bundle, and in the production Docker image node_modules/ and health-core/dist/ are
// .dockerignored and never rebuilt, so importing the workspace package here would fail to
// resolve and crash startup. A parity test keeps the copy in sync with the health-core source.
import * as Sentry from "@sentry/react-router";
import {
  scrubSensitiveData,
  scrubBreadcrumbData,
  scrubUrl,
} from "./instrument-scrub.mjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.2,
  enabled: !!process.env.SENTRY_DSN,
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
  beforeSend(event, hint) {
    // Benign body-stream cancel on client abort: fires when a user closes the tab while
    // request.json() still holds a reader on the body stream. The PRIMARY suppression is the
    // `request.signal.aborted` guard in entry.server.tsx's handleError (it skips capture for
    // aborted requests). This is a secondary net for the same condition reaching beforeSend.
    // NOTE: pre-RR7 this also matched on an `@remix-run/web-fetch` stack frame; that package
    // is gone in RR7, so we match on the message alone — acceptably narrow because the abort
    // guard upstream already filters the real-user-gone case, and this exact message only
    // arises from cancelling a body-stream reader.
    const err = hint?.originalException;
    if (
      err instanceof TypeError &&
      err.message.includes("Cannot cancel a stream that already has a reader")
    ) {
      return null;
    }

    // Scrub PII/PHI from event data before it leaves the server
    if (event.extra) {
      event.extra = scrubSensitiveData(event.extra);
    }
    if (event.contexts) {
      event.contexts = scrubSensitiveData(event.contexts);
    }
    if (event.request) {
      // Request body contains health data — remove entirely
      delete event.request.data;
      if (event.request.url) {
        event.request.url = scrubUrl(event.request.url);
      }
      if (event.request.query_string) {
        event.request.query_string = scrubUrl("?" + event.request.query_string).slice(1);
      }
      delete event.request.cookies;
      if (event.request.headers) {
        delete event.request.headers.cookie;
      }
    }
    if (event.breadcrumbs) {
      event.breadcrumbs = event.breadcrumbs.map((b) => {
        if ((b.category === "fetch" || b.category === "xhr" || b.category === "http") && b.data) {
          return { ...b, data: scrubBreadcrumbData(b.data) };
        }
        if (b.category === "console") {
          return {
            ...b,
            message: b.message ? "[Filtered]" : b.message,
            data: b.data ? scrubSensitiveData(b.data) : b.data,
          };
        }
        return b;
      });
    }
    return event;
  },
  beforeBreadcrumb(breadcrumb) {
    if (
      (breadcrumb.category === "fetch" ||
        breadcrumb.category === "xhr" ||
        breadcrumb.category === "http") &&
      breadcrumb.data
    ) {
      breadcrumb.data = scrubBreadcrumbData(breadcrumb.data);
    }
    if (breadcrumb.category === "console") {
      if (breadcrumb.message) breadcrumb.message = "[Filtered]";
      if (breadcrumb.data) {
        breadcrumb.data = scrubSensitiveData(breadcrumb.data);
      }
    }
    return breadcrumb;
  },
});
