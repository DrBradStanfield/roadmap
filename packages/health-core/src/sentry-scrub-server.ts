/**
 * The server's Sentry scrub (beforeSend and beforeSendTransaction), moved
 * verbatim from instrument-scrub.mjs with types added and nothing else (audit
 * A2-6/A3-1). A later change generates instrument-scrub.mjs from this file;
 * until then sentry-scrub-server-parity.test.ts holds the two to the same output.
 *
 * Helpers whose .mjs code matches sentry-scrub.ts are imported from there.
 * The three whose .mjs code differs in form (isSensitiveKey, scrubSensitiveData,
 * scrubContexts) are copied from the .mjs, with scrubEventText that calls
 * scrubContexts, so the generated file keeps the code the server runs today.
 */

import { REDACTED, SENSITIVE_EXACT_KEYS, SENSITIVE_SUBSTRINGS } from './scrub-vocabulary';
import { dropLongStrings, scrubBreadcrumbData, scrubStrings, scrubText, scrubUrl } from './sentry-scrub';

/** A Sentry event, span or context: SDK data of any shape, read as the .mjs reads it. */
type Loose = any;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_EXACT_KEYS.has(lower) || SENSITIVE_SUBSTRINGS.some((sub) => lower.includes(sub));
}

export function scrubSensitiveData(input: unknown, maxDepth = 10, currentDepth = 0): unknown {
  if (input === null || input === undefined) return input;
  if (currentDepth >= maxDepth) return REDACTED;
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((item) => scrubSensitiveData(item, maxDepth, currentDepth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    result[key] = isSensitiveKey(key) ? REDACTED
      : typeof value === 'object' && value !== null ? scrubSensitiveData(value, maxDepth, currentDepth + 1) : value;
  }
  return result;
}

// The SDK's trace and span ids, each in the one shape it takes: kept at these
// paths only, any other value scrubbed (mirror of sentry-scrub.ts, US-09 AC7h).
const ID_SHAPE: Record<string, RegExp> = { trace_id: /^[0-9a-f]{32}$/, span_id: /^[0-9a-f]{16}$/, parent_span_id: /^[0-9a-f]{16}$/ };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
function keepIds(raw: unknown, out: unknown, keys: string[]): void {
  if (!isObject(raw) || !isObject(out)) return;
  for (const key of keys) {
    const id = raw[key];
    if (typeof id === 'string' && typeof out[key] === 'string' && ID_SHAPE[key].test(id)) out[key] = id;
  }
}
function scrubContexts(contexts: Loose): unknown {
  const out: Loose = scrubStrings(contexts);
  keepIds(contexts?.trace, out?.trace, ['trace_id', 'span_id', 'parent_span_id']);
  const links = contexts?.trace?.links, outLinks = out?.trace?.links;
  if (Array.isArray(links) && Array.isArray(outLinks)) links.forEach((link, i) => keepIds(link, outLinks[i], ['trace_id', 'span_id']));
  return out;
}

export function scrubEventText(event: Loose): void {
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
    if (typeof event.request.query_string === 'string') event.request.query_string = scrubText(event.request.query_string);
  }
}

// Headers are an allowlist too, server side: what a request was, never who
// sent it or what it carried. Host and user-agent place it; content-type,
// content-length and accept describe a body without holding it. Cookies,
// Authorization, a Referer (a page URL with its query), forwarding IPs and any
// header nobody anticipated all go.
const KEPT_HEADERS = ['host', 'user-agent', 'content-type', 'content-length', 'accept'];
const KEPT_HEADER_ATTRIBUTES = new Set(KEPT_HEADERS.flatMap((h) =>
  ['request', 'response'].map((side) => `http.${side}.header.${h.replace(/-/g, '_')}`)));

function keepHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => KEPT_HEADERS.includes(k.toLowerCase())));
}

// A transaction repeats the request as span attributes. The query goes whole,
// as in `request` below; a header attribute obeys the allowlist; the other end
// of the connection goes (the SDK's `http.client_ip` is the first
// X-Forwarded-For hop, the visitor's own address; OTel names the rest
// `client.address`, `net.peer.*`, `network.peer.*`, `user.ip_address`); a
// URL-valued attribute (a path, or anything with a scheme) goes through
// `urlRule`, and is dropped when that returns undefined.
const CLIENT_ADDRESS_KEY = /client_ip|client\.address|(^|\.)peer\.|ip_address/i;

function scrubSpanData(data: Loose, urlRule: (url: string) => string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries<unknown>(data ?? {})) {
    if (/query$/i.test(key) || CLIENT_ADDRESS_KEY.test(key)) continue;
    if (/^http\.(request|response)\.header\./.test(key) && !KEPT_HEADER_ATTRIBUTES.has(key)) continue;
    const isUrl = /url|target/i.test(key) && typeof value === 'string' && (value.startsWith('/') || value.includes('://'));
    const kept = isUrl ? urlRule(value) : value;
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

// An outgoing call gets the breadcrumb rule, origin only, whether it is a
// child span or a root transaction of its own (a call that outlives its
// request). The SDK names it "METHOD <full URL>", and the path can name a
// document, so that name keeps the method and origin too.
function originOf(url: string): string | undefined {
  try { return new URL(url).origin; } catch { return undefined; }
}

function methodAndOrigin(name: string): string {
  const [method, url] = name.split(' ');
  return [method, originOf(url)].filter(Boolean).join(' ');
}

const scrubOutgoingData = (data: Loose): unknown => scrubStrings(scrubSensitiveData(scrubSpanData(data, originOf)));

function scrubChildSpan(span: Loose): void {
  span.data = scrubOutgoingData(span.data);
  if (span.op === 'http.client' && typeof span.description === 'string') {
    span.description = methodAndOrigin(span.description);
  }
}

/**
 * The server's whole beforeSend (and beforeSendTransaction) scrub, in one
 * place so the parity test can run an event through it (instrument.server.mjs
 * cannot be imported — it calls Sentry.init on load). The browser's
 * `scrubEvent` runs the same steps in the same order after its browser-only
 * drops. Three steps are server-only: the header allowlist, the span-data
 * pass on a transaction's root span (the outgoing-call rule when the root is
 * itself an outgoing call), and the child-span pass. The browser sends no
 * transactions and keeps its header denylist.
 */
export function scrubServerEvent(event: Loose): Loose {
  // An incoming request's transaction name is left alone: under
  // react-router-serve it is a route pattern (`GET *`), and the SDK has
  // already cut its query.
  const trace = event.contexts?.trace;
  const outgoing = trace?.op === 'http.client';
  if (trace?.data) trace.data = outgoing ? scrubOutgoingData(trace.data) : scrubSpanData(trace.data, scrubUrl);
  if (outgoing && typeof event.transaction === 'string') event.transaction = methodAndOrigin(event.transaction);
  for (const span of event.spans ?? []) scrubChildSpan(span);
  if (event.extra) event.extra = scrubSensitiveData(event.extra);
  if (event.contexts) event.contexts = scrubSensitiveData(event.contexts);
  if (event.request) {
    // Request body contains health data — remove entirely
    delete event.request.data;
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    // The query goes whole — see scrubUrl.
    delete event.request.query_string;
    delete event.request.cookies;
    // The hosted MCP server's bearer token (US-32) seals a live Dropbox
    // refresh token: the allowlist keeps it, like every credential, out.
    if (event.request.headers) event.request.headers = keepHeaders(event.request.headers);
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .filter((b: Loose) => b.category !== "console")
      .map((b: Loose) =>
        (b.category === "fetch" || b.category === "xhr" || b.category === "http") && b.data
          ? { ...b, data: scrubBreadcrumbData(b.data) }
          : b,
      );
  }
  // Free text is the gap the key scrub cannot see: a value in an exception
  // message, an `extra` string, a breadcrumb. Runs last, over everything.
  scrubEventText(event);
  // A long string is a paste of something (a body, a prompt, a record) that
  // no rule reads reliably — keep none of it.
  if (event.extra) event.extra = dropLongStrings(event.extra);
  return event;
}
