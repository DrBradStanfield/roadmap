/**
 * Sentry PII/PHI scrubbing utilities.
 *
 * Pure functions (no Sentry dependency) that strip sensitive health data,
 * demographics, and identifiers from objects before they leave the app
 * via Sentry error reports.
 */

import {
  EMAIL_RE, METRIC_THEN_VALUE_RE, REDACTED, SENSITIVE_EXACT_KEYS, SENSITIVE_SUBSTRINGS, UNIT_VALUE_RE,
  VALUE_THEN_METRIC_RE,
} from './scrub-vocabulary';

// The word lists and regexes live in scrub-vocabulary.ts, shared with the
// server scrubber (sentry-scrub-server.ts); importers keep reading them here.
export { EMAIL_SOURCE, SCRUB_METRIC_WORDS, SCRUB_UNIT_PATTERN, SCRUB_UNITS, SENSITIVE_EXACT_KEYS } from './scrub-vocabulary';

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_EXACT_KEYS.has(lower)) return true;
  return SENSITIVE_SUBSTRINGS.some(sub => lower.includes(sub));
}

/**
 * Recursively scrub sensitive fields from an object.
 * Returns a new object with sensitive values replaced by '[Filtered]'.
 */
export function scrubSensitiveData(
  input: unknown,
  maxDepth = 10,
  currentDepth = 0,
): unknown {
  if (input === null || input === undefined) return input;
  if (currentDepth >= maxDepth) return REDACTED;
  if (typeof input !== 'object') return input;

  if (Array.isArray(input)) {
    return input.map(item => scrubSensitiveData(item, maxDepth, currentDepth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
    } else if (typeof value === 'object' && value !== null) {
      result[key] = scrubSensitiveData(value, maxDepth, currentDepth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function decodePath(path: string): string {
  try { return decodeURIComponent(path); } catch { return path; }
}

/**
 * Reduce a request URL to origin + path, dropping the query whole and running
 * the path through the free-text scrub.
 *
 * An allowlist of param names (2026-09-10) loses to the next provider: a query
 * carries a clinical filename (`?path=/Apps/roadmap/Jane Roe lipids.pdf`), a
 * search term or a token just as readily as it carries `code`. An accepted
 * residual: an attack payload carried in a query string is no longer visible
 * (the 2026-08-23 sentry-fix diagnosis of JAVASCRIPT-REMIX-62 read the
 * `exitIframe` query); the path and the exception text still are. The path is scrubbed too — a REST route can spell a
 * document or a value into its segments. Breadcrumbs keep only the origin.
 */
export function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url, 'https://placeholder.invalid');
    // Decoded first: a percent-encoded path hides both the value scrub's
    // spacing ("ldl%203.2") and the filename a reader would recognise.
    const path = scrubText(decodePath(parsed.pathname));
    return url.startsWith('http') ? parsed.origin + path : path;
  } catch {
    return REDACTED;
  }
}

/**
 * Scrub fetch/xhr/http breadcrumb data.
 *
 * An ALLOWLIST, not a denylist (2026-09-10): a breadcrumb's `data` is whatever
 * the SDK, an integration, or our own `addBreadcrumb` call put there, so naming
 * the fields to delete loses to the next field nobody listed. Three fields are
 * what a breadcrumb is read for — method, host, status — and everything else
 * goes, bodies and sizes included.
 *
 * The URL is reduced to its origin: an arbitrary WebDAV/GitHub path or a Drive
 * lookup query names a clinical document, and no param list catches that.
 */
export function scrubBreadcrumbData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return data;

  const kept: Record<string, unknown> = {};
  if (typeof data.method === 'string') kept.method = data.method;
  if (typeof data.url === 'string') {
    try { kept.url = new URL(data.url).origin; }
    catch { kept.url = REDACTED; }
  }
  if (typeof data.status_code === 'number' || typeof data.status_code === 'string') {
    kept.status_code = data.status_code;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Free-text scrub (added 2026-09-10 after a ChatGPT audit of the server hook)
// ---------------------------------------------------------------------------
// The vocabulary these rules read is in scrub-vocabulary.ts.

/** Redact health values and emails written into free text. */
export function scrubText(text: string): string {
  return text
    .replace(EMAIL_RE, '[email]')
    .replace(UNIT_VALUE_RE, '[value]')
    .replace(METRIC_THEN_VALUE_RE, '$1$2[value]')
    .replace(VALUE_THEN_METRIC_RE, '[value]$2$3');
}

/** Apply `scrubText` to every string anywhere in a value. */
export function scrubStrings(input: unknown, maxDepth = 10, currentDepth = 0): unknown {
  if (typeof input === 'string') return scrubText(input);
  if (input === null || typeof input !== 'object') return input;
  if (currentDepth >= maxDepth) return input;
  if (Array.isArray(input)) return input.map(v => scrubStrings(v, maxDepth, currentDepth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = scrubStrings(v, maxDepth, currentDepth + 1);
  }
  return out;
}

// The SDK's trace and span ids, each in the one shape it takes (US-09 AC7h). A
// hex lab name and digits ("e2" then "123") sit inside a random id, and the
// name-then-value rule would put "[value]" inside it.
const ID_SHAPE: Record<string, RegExp> = { trace_id: /^[0-9a-f]{32}$/, span_id: /^[0-9a-f]{16}$/, parent_span_id: /^[0-9a-f]{16}$/ };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Put back each id `raw` holds at `keys` in its exact shape; any other value stays scrubbed. */
function keepIds(raw: unknown, out: unknown, keys: string[]): void {
  if (!isObject(raw) || !isObject(out)) return;
  for (const key of keys) {
    const id = raw[key];
    if (typeof id === 'string' && typeof out[key] === 'string' && ID_SHAPE[key].test(id)) out[key] = id;
  }
}

/** `contexts` through the text scrub, keeping only `trace.trace_id`, `trace.span_id`,
 *  `trace.parent_span_id` and each `trace.links[]` entry's `trace_id` and `span_id`. */
function scrubContexts(contexts: unknown): unknown {
  const out = scrubStrings(contexts);
  const trace = isObject(contexts) ? contexts.trace : undefined;
  const outTrace = isObject(out) ? out.trace : undefined;
  keepIds(trace, outTrace, ['trace_id', 'span_id', 'parent_span_id']);
  const links = isObject(trace) ? trace.links : undefined;
  const outLinks = isObject(outTrace) ? outTrace.links : undefined;
  if (Array.isArray(links) && Array.isArray(outLinks)) links.forEach((link, i) => keepIds(link, outLinks[i], ['trace_id', 'span_id']));
  return out;
}

/** The free-text fields of a Sentry event, structurally (no SDK dependency). */
export interface TextScrubbableEvent {
  message?: unknown;
  logentry?: unknown;
  exception?: { values?: Array<{ value?: unknown }> };
  extra?: unknown;
  contexts?: unknown;
  tags?: unknown;
  breadcrumbs?: Array<{ message?: unknown; data?: unknown }>;
  request?: { url?: unknown; query_string?: unknown };
}

/** Scrub every free-text field of an event in place. Stack frames untouched. */
export function scrubEventText(event: TextScrubbableEvent): void {
  if (event.message) event.message = scrubStrings(event.message);
  if (event.logentry) event.logentry = scrubStrings(event.logentry);
  for (const value of event.exception?.values ?? []) {
    if (typeof value.value === 'string') value.value = scrubText(value.value);
  }
  if (event.extra) event.extra = scrubStrings(event.extra);
  if (event.contexts) event.contexts = scrubContexts(event.contexts);
  if (event.tags) event.tags = scrubStrings(event.tags);
  for (const crumb of event.breadcrumbs ?? []) {
    if (typeof crumb.message === 'string') crumb.message = scrubText(crumb.message);
    if (crumb.data) crumb.data = scrubStrings(crumb.data);
  }
  if (event.request) {
    if (typeof event.request.url === 'string') event.request.url = scrubText(event.request.url);
    if (typeof event.request.query_string === 'string') {
      event.request.query_string = scrubText(event.request.query_string);
    }
  }
}

/**
 * Drop string values longer than `max` entirely (the key goes with them).
 * A long free-text blob is a paste of something — a prompt, a response body,
 * a record — and no rule reads it reliably, so the server keeps none of it.
 */
export function dropLongStrings(input: unknown, max = 200): unknown {
  if (Array.isArray(input)) {
    return input.map(v => (typeof v === 'string' && v.length > max ? REDACTED : dropLongStrings(v, max)));
  }
  if (input === null || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > max) continue;
    out[k] = v !== null && typeof v === 'object' ? dropLongStrings(v, max) : v;
  }
  return out;
}
