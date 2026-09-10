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
  'sex',
  // Identifiers
  'shopify_customer_id', 'customerid',
  'userid', 'user_id',
  'unsubscribe_token',
  // Screening-specific
  'prostatepsavalue', 'prostate_psa_value',
  'lungpackyears', 'lung_pack_years',
]);

const SENSITIVE_SUBSTRINGS = [
  'password', 'secret', 'credential',
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

const SENSITIVE_PARAMS = [
  'token', 'logged_in_customer_id', 'email',
  // OAuth / PKCE (cloud-provider connect flows land on URLs carrying these)
  'code', 'state', 'code_verifier', 'code_challenge',
  'client_secret', 'refresh_token', 'access_token', 'id_token', 'assertion',
];

export function scrubUrl(url) {
  try {
    const isRelative = !url.startsWith('http');
    const parsed = new URL(url, 'https://placeholder.invalid');
    let changed = false;
    for (const param of SENSITIVE_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, REDACTED);
        changed = true;
      }
    }
    if (!changed) return url;
    if (isRelative) return parsed.pathname + parsed.search;
    return parsed.toString();
  } catch {
    return url;
  }
}

export function scrubBreadcrumbData(data) {
  if (!data) return data;

  const scrubbed = { ...data };

  if (typeof scrubbed.url === 'string') {
    scrubbed.url = scrubUrl(scrubbed.url);
  }

  delete scrubbed.body;
  delete scrubbed.request_body;
  delete scrubbed.request_body_size;
  delete scrubbed.response_body_size;

  return scrubbed;
}

// --- Free-text scrub (2026-09-10 audit) — mirror of sentry-scrub.ts. ---------
// Key-based redaction cannot see a value written in a sentence. Keep these
// lists and rules identical in both files; the parity test fails otherwise, and
// it also checks the lists against UNIT_DEFS / METRIC_LABELS.

export const SCRUB_UNITS = [
  'mmol/L', 'mmol/mol', 'mg/dL', 'µmol/L', 'umol/L', 'micromol/L', 'nmol/L',
  'ng/mL', 'µg/L', 'ug/L', 'mg/L', 'g/L', 'mmHg', 'mm Hg',
  'kg', 'lbs', 'lb', 'cm', '%',
  // Dose units
  'mcg', 'µg', 'mg', 'g', 'IU', 'mL', 'ml', 'units',
  // Inches: matched by a stricter rule (see INCH_UNIT) — "5 in the morning"
  // is English, not a height.
  'in', '"',
];

export const SCRUB_METRIC_WORDS = [
  'total cholesterol', 'ldl cholesterol', 'hdl cholesterol', 'non-hdl',
  'cholesterol', 'triglycerides', 'hba1c', 'a1c', 'apob', 'apo b', 'lp(a)',
  'lpa', 'ldl', 'hdl', 'psa', 'creatinine', 'egfr', 'blood pressure',
  'systolic', 'diastolic', 'bp', 'bmi', 'weight', 'waist', 'height',
  'glucose', 'testosterone', 'vitamin d', 'ferritin', 'tsh',
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
  `\\b(${alternation(SCRUB_METRIC_WORDS)})([^\\d\\n]{0,20}?)(${NUMBER})`, 'gi');
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
