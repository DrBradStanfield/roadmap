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
import { scrubBreadcrumbData, scrubServerEvent } from "./instrument-scrub.mjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // Console arguments are raw application text — a logged sentence carries a
  // health value past every key-based rule (found by audit, 2026-09-10). The
  // server keeps no console breadcrumbs at all; an error still arrives as its
  // own message and class.
  integrations: (defaults) => defaults.filter((i) => i.name !== "Console"),
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

    // Scrub PII/PHI from event data before it leaves the server (shared with
    // the parity test, which runs this exact pipeline against the browser's).
    scrubServerEvent(event);
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
    // Belt and braces for the disabled Console integration: any console
    // breadcrumb from anywhere else is dropped, not filtered.
    if (breadcrumb.category === "console") return null;
    return breadcrumb;
  },
});
