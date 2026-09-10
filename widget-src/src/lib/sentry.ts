import * as Sentry from '@sentry/react';
import { EXPECTED_NETWORK_ERRORS } from './error-diagnostics';
import { scrubSensitiveData, scrubBreadcrumbData, scrubUrl, scrubEventText, dropLongStrings } from '@roadmap/health-core';

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
    // Bodies go, and the URL keeps its origin only — arbitrary WebDAV/GitHub
    // paths and Drive lookup queries name clinical documents.
    breadcrumb.data = scrubBreadcrumbData(breadcrumb.data as Record<string, unknown>);
  }
  // Scrub console breadcrumbs (may contain emails, health data in log output)
  if (breadcrumb.category === 'console') {
    if (breadcrumb.message) breadcrumb.message = '[Filtered]';
    // Console argument arrays bypass field-name redaction and may quote files
    // or results. Keep the occurrence/level, never the argument values.
    delete breadcrumb.data;
  }
  return breadcrumb;
}

/** Scrub PII/PHI from Sentry events before they leave the browser. */
export function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  // Record errors can quote clinical filenames in messages, causes and fetch
  // breadcrumbs. These captures carry only closed operation/provider tags.
  if (event.tags?.area === 'cloud-sync' || event.tags?.area === 'upload-save' || event.tags?.feature === 'upload') {
    const { area, op, backend, branch, uploadErrorCode } = event.tags;
    event.tags = {
      ...(area === 'cloud-sync' || area === 'upload-save' ? { area } : { feature: 'upload' }),
      ...(['write-document', 'read-document', 'persist', 'log-off', 'copy-down'].includes(String(op)) ? { op } : {}),
      ...(['google-drive', 'dropbox', 'github', 'self-host', 'local', 'file', 'memory'].includes(String(backend)) ? { backend } : {}),
      ...(['measurements', 'documents', 'labValues'].includes(String(branch)) ? { branch } : {}),
      ...(['rate_limit', 'timeout', 'server_restart', 'no_files', 'server_error', 'network', 'unknown'].includes(String(uploadErrorCode)) ? { uploadErrorCode } : {}),
    };
    if (event.message) event.message = 'Health record operation failed';
    if (event.exception?.values) event.exception.values = event.exception.values.map(value => ({
      type: 'Error', value: 'Health record operation failed',
      stacktrace: value.stacktrace, mechanism: value.mechanism,
    }));
    delete event.breadcrumbs;
    delete event.request;
    delete event.extra;
    delete event.contexts;
    delete event.fingerprint;
  }
  // Drop the SDK's own internal log object when it gets re-captured: after our
  // processors drop a third-party error (e.g. the Horizon theme's
  // "@shopify/events" TypeError), the SDK's "An event processor returned
  // `null`, will not send event." message can escape as a rejected plain
  // object and come back as "Object captured as exception with keys: message".
  // Pure self-noise (Sentry 7620498452, 7645126135).
  const serializedMessage = (event.extra?.__serialized__ as { message?: unknown } | undefined)?.message;
  if (typeof serializedMessage === 'string' && serializedMessage.startsWith('An event processor returned')) {
    return null;
  }

  if (event.extra) {
    event.extra = scrubSensitiveData(event.extra) as Record<string, unknown>;
  }
  if (event.contexts) {
    event.contexts = scrubSensitiveData(event.contexts) as Record<string, Record<string, unknown>>;
  }
  // Drop unhandled rejections of non-Error objects — always third-party noise.
  // allowUrls can't filter these because plain-object rejections have no stack trace.
  // Our code wraps all promises in apiCall() which catches errors properly.
  if (event.exception?.values?.some(v =>
    v.mechanism?.type?.endsWith('onunhandledrejection') && !v.stacktrace?.frames?.length
  )) {
    return null;
  }

  // Drop errors thrown inside third-party Shopify apps that monkey-patch window.fetch
  // (UpCart, Appstle Subscriptions). Firefox 150 throws a spurious
  // "url with embedded credentials" TypeError from their wrappers on plain relative URLs.
  // Our api.ts already catches the resulting fetch failures.
  if (event.exception?.values?.some(v =>
    v.stacktrace?.frames?.some(f =>
      typeof f.filename === 'string' &&
      (f.filename.includes('upcart-bundle') || f.filename.includes('appstle-bundles-interceptor'))
    )
  )) {
    return null;
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
  // Free text is what the key scrub cannot see — a health value written into a
  // sentence survives in an exception message or an `extra` string. Same rules
  // as the server (one shared implementation). Stack frames stay intact.
  scrubEventText(event);
  // A long string is a paste of something (a body, a prompt, a record) that no
  // rule reads reliably — keep none of it. Same last step as the server.
  if (event.extra) event.extra = dropLongStrings(event.extra) as Record<string, unknown>;
  return event;
}

export function initSentry() {
  if (initialized) return;
  initialized = true;

  Sentry.init({
    dsn: SENTRY_DSN,
    release: typeof __SENTRY_RELEASE__ !== 'undefined' ? __SENTRY_RELEASE__ : undefined,
    environment: window.location.hostname.includes('localhost')
      ? 'development'
      : window.location.hostname === 'drbradstanfield.github.io'
        ? 'standalone' // the GitHub Pages front door — separable from the website in Sentry
        : 'production',
    // Don't send in development
    enabled: !window.location.hostname.includes('localhost'),
    // Limit serialization depth for Sentry event payloads
    normalizeDepth: 5,
    ignoreErrors: [
      ...EXPECTED_NETWORK_ERRORS,
      // iOS WebKit DOMException SYNTAX_ERR (code 12) — browser-level DOM noise
      // observed on iPad/Chrome Mobile iOS. Not caused by our code.
      /The string did not match the expected pattern/,
      // DuckDuckGo Privacy Browser injects feature registry code into pages;
      // these errors are from their content scripts, not our code.
      /feature named `.+` was not found/,
      // Judge.me review widget errors — third-party script, but attributed to our
      // bundle because Sentry's setTimeout instrumentation wraps their callbacks.
      /jdgm\./,
      // Facebook/Instagram in-app browser's native Java bridge failures.
      // Only occurs in Android WebViews — our app never uses Java bridges.
      /Java bridge method invocation error/,
      // Raty star rating plugin (third-party, e.g. Judge.me) — attributed to our
      // bundle because Sentry's setTimeout instrumentation wraps their callbacks.
      /\.raty\b/,
      // Shopify Horizon theme ships native ES modules with bare "@theme/*" import
      // specifiers (an import-map feature). Old iOS Safari / in-app browsers lack
      // import-map support and throw this TypeError. The stack is all [native code]
      // (no URL), so allowUrls can't filter it — match on the message. We never ship
      // "@theme/" specifiers, so this can't swallow a real error from our bundles.
      /Module specifier, .*@theme\/.* does not start with/,
      // Same Horizon theme on old WebKit: the engine can't parse the theme's modern
      // "#private" class fields/methods, so module parsing fails with this SyntaxError
      // (also "[native code]", no URL). Both variants ("Cannot parse class method with
      // private name." / "Expected a ';' following a class field.") share this prefix.
      // Our bundles are transpiled (no "#private" fields), so this is theme-only noise.
      /Unexpected private name #/,
    ],
    allowUrls: [
      // Current extension entry points and lazy chunks. Match the CDN origin
      // and complete filename so unrelated scripts and lookalike URLs stay out.
      /^https:\/\/cdn\.shopify\.com\/extensions\/[^?#]+\/assets\/(?:health-plan-v2(?:-[\w-]+)?|health-site-chat|health-chatbot-embed|health-upload)\.js(?:[?#].*)?$/,
      // Pages emits hashed chunks under assets/, but its lazy upload IIFE
      // lives beside index.html. Rehosted copies do not report to our project.
      /^https:\/\/drbradstanfield\.github\.io\/roadmap\/(?:assets\/[^/?#]+\.js|health-upload\.js)(?:[?#].*)?$/,
    ],
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}

export { Sentry };
