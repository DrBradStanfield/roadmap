// Sentry PII/PHI scrubbing — SELF-CONTAINED plain-ESM copy for instrument.server.mjs.
//
// WHY THIS DUPLICATES packages/health-core/src/sentry-scrub.ts:
// instrument.server.mjs is loaded by Node via `node --import` BEFORE (and outside) the
// react-router server bundle. In the production Docker image `node_modules/` and
// `packages/health-core/dist/` are both .dockerignored and never rebuilt, so a runtime
// `import '@roadmap/health-core'` from this pre-bundle context would fail to resolve and
// crash the server on startup (taking the HIPAA scrubbing down with it). This file lives at
// the repo root (copied into the image by `COPY . .`) and is imported by a plain relative
// path, so it resolves with zero workspace/dist dependency.
//
// DRIFT GUARD: packages/health-core/src/instrument-scrub-parity.test.ts asserts these functions
// behave identically to the health-core source. If you change the scrub logic or the
// sensitive-key lists in EITHER file, update BOTH — the parity test fails otherwise.

const REDACTED = '[Filtered]';

const SENSITIVE_EXACT_KEYS = new Set([
  // Health measurements
  'weightkg', 'weight_kg', 'weight',
  'waistcm', 'waist_cm', 'waist',
  'heightcm', 'height_cm', 'height',
  'hba1c',
  'ldlc', 'ldl_c', 'ldl',
  'totalcholesterol', 'total_cholesterol',
  'hdlc', 'hdl_c', 'hdl',
  'triglycerides',
  'apob', 'apo_b',
  'creatinine',
  'psa',
  'lpa',
  'systolicbp', 'systolic_bp',
  'diastolicbp', 'diastolic_bp',
  // Metric type identifier (reveals what someone tracks)
  'metrictype', 'metric_type',
  // Calculated results
  'idealbodyweight', 'ideal_body_weight',
  'proteintarget', 'protein_target',
  'bmi',
  'waisttoheightratio', 'waist_to_height_ratio',
  'nonhdlcholesterol', 'non_hdl_cholesterol',
  'egfr',
  // Medications
  'drugname', 'drug_name',
  'dosevalue', 'dose_value',
  'doseunit', 'dose_unit',
  // Demographics
  'firstname', 'first_name',
  'lastname', 'last_name',
  'email',
  'birthyear', 'birth_year',
  'birthmonth', 'birth_month',
  'sex', 'gender',
  'dob', 'dateofbirth', 'date_of_birth', 'birthdate',
  'patientname', 'patient_name',
  // Identifiers
  'shopify_customer_id', 'customerid',
  'userid', 'user_id',
  // Patient identifiers a lab report or an import carries
  'nhi', 'mrn',
  // Generic carriers: whatever a row, a lab result or an extraction is called,
  // this is the field its number or its text sits in.
  'value', 'values', 'result', 'results',
  'title', 'note', 'notes', 'summary',
  // Screening-specific
  'prostatepsavalue', 'prostate_psa_value',
  'lungpackyears', 'lung_pack_years',
]);

const SENSITIVE_SUBSTRINGS = [
  'password', 'secret', 'credential',
  // Every credential family, by the word it is named after: `token` covers
  // unsubscribe_token, refreshToken and access_token in one rule.
  'token', 'auth', 'bearer', 'apikey', 'api_key',
  // A cookie is a session: the SDK copies each one into span data by name.
  'cookie',
  // A clinical document is named by its file: "Brad Stanfield lipids Mar 2026.pdf".
  'filename', 'sourcefilename',
  'screening', 'followup',
  'medication', 'statin', 'ezetimibe', 'pcsk9', 'glp1', 'sglt2', 'metformin',
];

function isSensitiveKey(key) {
  const lower = key.toLowerCase();
  if (SENSITIVE_EXACT_KEYS.has(lower)) return true;
  return SENSITIVE_SUBSTRINGS.some((sub) => lower.includes(sub));
}

export function scrubSensitiveData(input, maxDepth = 10, currentDepth = 0) {
  if (input === null || input === undefined) return input;
  if (currentDepth >= maxDepth) return REDACTED;
  if (typeof input !== 'object') return input;

  if (Array.isArray(input)) {
    return input.map((item) => scrubSensitiveData(item, maxDepth, currentDepth + 1));
  }

  const result = {};
  for (const [key, value] of Object.entries(input)) {
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

function decodePath(path) {
  try { return decodeURIComponent(path); } catch { return path; }
}

// Origin + path, query dropped whole, path through the free-text scrub —
// mirror of sentry-scrub.ts. A query names a clinical document as readily as it
// carries a token, and no param allowlist survives the next provider.
export function scrubUrl(url) {
  try {
    const parsed = new URL(url, 'https://placeholder.invalid');
    const path = scrubText(decodePath(parsed.pathname));
    return url.startsWith('http') ? parsed.origin + path : path;
  } catch {
    return REDACTED;
  }
}

// The URL keeps its origin and nothing else: an arbitrary WebDAV/GitHub path
// or a Drive lookup query names a clinical document, and no param list catches
// that. Host, method and status — what a breadcrumb is read for — survive.
export function scrubBreadcrumbData(data) {
  if (!data) return data;

  // Allowlist, not denylist — mirror of sentry-scrub.ts. Method, host, status.
  const kept = {};
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

// --- Free-text scrub (2026-09-10 audit) — mirror of sentry-scrub.ts. ---------
// Key-based redaction cannot see a value written in a sentence. Keep these
// lists and rules identical in both files; the parity test fails otherwise, and
// it also checks the lists against UNIT_DEFS / METRIC_LABELS.

// The two vocabularies below are DERIVED in sentry-scrub.ts (from UNIT_DEFS,
// METRIC_LABELS and the lab catalogue) and literal here, because this file
// imports nothing. When the catalogue moves, the parity test fails and prints
// the arrays to paste back in.
export const SCRUB_UNITS = [
  '%', 'L/L', 'U/L', 'cm', 'fL', 'g/L', 'in', 'kg', 'lbs', 'mIU/L', 'mL/min/1.73m²',
  'mg/L', 'mg/dL', 'mg/mmol', 'mm/hr', 'mmHg', 'mmol/L', 'mmol/mol', 'ng/mL', 'nmol/L',
  'pg', 'pmol/L', 'µg/L', 'µmol/L', '×10¹²/L', '×10⁹/L', 'mm Hg', 'umol/L', 'micromol/L',
  'ug/L', 'lb', 'mcg', 'µg', 'mg', 'g', 'IU', 'mL', 'ml', 'units', '"',
];

export const SCRUB_METRIC_WORDS = [
  'acr', 'alanine', 'albumin', 'alkaline', 'alp', 'alt', 'aminotransferase', 'apob',
  'aspartate', 'ast', 'b12', 'basophil', 'basophils', 'bicarbonate', 'bilirubin', 'bun',
  'calcium', 'chloride', 'cholesterol', 'co2', 'cobalamin', 'concentration', 'cortisol',
  'creatinine', 'crp', 'diastolic', 'egfr', 'eosinophil', 'eosinophils', 'erythrocyte',
  'erythrocytes', 'esr', 'estradiol', 'ferritin', 'filtration', 'folate', 'folic', 'ft3',
  'ft4', 'gamma', 'gfr', 'ggt', 'ggtp', 'globulin', 'glomerular', 'glutamyl',
  'haematocrit', 'haemoglobin', 'hba1c', 'hco3', 'hct', 'hdl', 'hematocrit', 'hemoglobin',
  'hgb', 'hscrp', 'hydroxyvitamin', 'iron', 'ldl', 'leucocytes', 'leukocytes', 'lpa',
  'lymphocyte', 'lymphocytes', 'magnesium', 'mch', 'mchc', 'mcv', 'microalbumin',
  'monocyte', 'monocytes', 'neut', 'neutrophil', 'neutrophils', 'nitrogen', 'oestradiol',
  'pcv', 'phosphatase', 'platelet', 'platelets', 'plt', 'potassium', 'prolactin', 'psa',
  'rbc', 'rdw', 'reactive', 'sedimentation', 'sgot', 'sgpt', 'shbg', 'sodium', 'systolic',
  'testosterone', 'thyroid', 'thyrotropin', 'thyroxine', 'transferase', 'transferrin',
  'triglycerides', 'triiodothyronine', 'tsat', 'tsh', 'urate', 'urea', 'uric', 'urine',
  'vitamin', 'waist', 'wbc', 'weight', 'zinc', 'blood pressure', 'apo b', 'lp(a)', 'a1c',
  'bp', 'bmi', 'height', 'glucose',
];

const NUMBER = '\\d+(?:[.,]\\d+)?(?:/\\d+(?:[.,]\\d+)?)?';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = (words) =>
  [...words].sort((a, b) => b.length - a.length).map(escapeRe).join('|');

const INCH_UNIT = '(?:in(?=\\s*(?:[^A-Za-z0-9\\s]|$))|")';
const PLAIN_UNITS = SCRUB_UNITS.filter(u => u !== 'in' && u !== '"');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UNIT_VALUE_RE = new RegExp(
  `\\b${NUMBER}\\s*(?:(?:${alternation(PLAIN_UNITS)})(?![A-Za-z])|${INCH_UNIT})`, 'gi');
const METRIC_THEN_VALUE_RE = new RegExp(
  `\\b(${alternation(SCRUB_METRIC_WORDS)})(?![a-z0-9])([^\\d\\n]{0,20}?)(${NUMBER})`, 'gi');
const VALUE_THEN_METRIC_RE = new RegExp(
  `(${NUMBER})([^\\d\\n]{0,20}?)\\b(${alternation(SCRUB_METRIC_WORDS)})\\b`, 'gi');

export function scrubText(text) {
  return text
    .replace(EMAIL_RE, '[email]')
    .replace(UNIT_VALUE_RE, '[value]')
    .replace(METRIC_THEN_VALUE_RE, '$1$2[value]')
    .replace(VALUE_THEN_METRIC_RE, '[value]$2$3');
}

export function scrubStrings(input, maxDepth = 10, currentDepth = 0) {
  if (typeof input === 'string') return scrubText(input);
  if (input === null || typeof input !== 'object') return input;
  if (currentDepth >= maxDepth) return input;
  if (Array.isArray(input)) return input.map((v) => scrubStrings(v, maxDepth, currentDepth + 1));
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = scrubStrings(v, maxDepth, currentDepth + 1);
  }
  return out;
}

export function scrubEventText(event) {
  if (event.message) event.message = scrubStrings(event.message);
  if (event.logentry) event.logentry = scrubStrings(event.logentry);
  for (const value of event.exception?.values ?? []) {
    if (typeof value.value === 'string') value.value = scrubText(value.value);
  }
  if (event.extra) event.extra = scrubStrings(event.extra);
  if (event.contexts) event.contexts = scrubStrings(event.contexts);
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

export function dropLongStrings(input, max = 200) {
  if (Array.isArray(input)) {
    return input.map((v) => (typeof v === 'string' && v.length > max ? REDACTED : dropLongStrings(v, max)));
  }
  if (input === null || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > max) continue;
    out[k] = v !== null && typeof v === 'object' ? dropLongStrings(v, max) : v;
  }
  return out;
}

// Headers are an allowlist too, server side: what a request was, never who
// sent it or what it carried. Host and user-agent place it; content-type,
// content-length and accept describe a body without holding it. Cookies,
// Authorization, a Referer (a page URL with its query), forwarding IPs and any
// header nobody anticipated all go.
const KEPT_HEADERS = ['host', 'user-agent', 'content-type', 'content-length', 'accept'];
const KEPT_HEADER_ATTRIBUTES = new Set(KEPT_HEADERS.flatMap((h) =>
  ['request', 'response'].map((side) => `http.${side}.header.${h.replace(/-/g, '_')}`)));

function keepHeaders(headers) {
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

function scrubSpanData(data, urlRule) {
  const out = {};
  for (const [key, value] of Object.entries(data ?? {})) {
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
function originOf(url) {
  try { return new URL(url).origin; } catch { return undefined; }
}

function methodAndOrigin(name) {
  const [method, url] = name.split(' ');
  return [method, originOf(url)].filter(Boolean).join(' ');
}

const scrubOutgoingData = (data) => scrubStrings(scrubSensitiveData(scrubSpanData(data, originOf)));

function scrubChildSpan(span) {
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
export function scrubServerEvent(event) {
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
      .filter((b) => b.category !== "console")
      .map((b) =>
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
