/**
 * Sentry PII/PHI scrubbing utilities.
 *
 * Pure functions (no Sentry dependency) that strip sensitive health data,
 * demographics, and identifiers from objects before they leave the app
 * via Sentry error reports.
 */

const REDACTED = '[Filtered]';

/**
 * Exact-match sensitive keys (compared lowercase).
 * Covers both camelCase (widget/API) and snake_case (database) variants.
 */
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

/**
 * If a key contains any of these substrings (lowercase), scrub it.
 * Catches compound fields like "colorectal_last_date", "statinDrug", etc.
 */
const SENSITIVE_SUBSTRINGS = [
  'password', 'secret', 'credential',
  'screening', 'followup',
  'medication', 'statin', 'ezetimibe', 'pcsk9', 'glp1', 'sglt2', 'metformin',
];

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

/** Query params that should be redacted from URLs. */
const SENSITIVE_PARAMS = [
  'token', 'logged_in_customer_id', 'email',
  // OAuth / PKCE (cloud-provider connect flows land on URLs carrying these)
  'code', 'state', 'code_verifier', 'code_challenge',
  'client_secret', 'refresh_token', 'access_token', 'id_token', 'assertion',
];

/**
 * Redact sensitive query parameter values from a URL string.
 * Preserves the path and non-sensitive params.
 */
export function scrubUrl(url: string): string {
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

/**
 * Scrub fetch/xhr/http breadcrumb data.
 * Removes request/response bodies entirely (they contain health data payloads).
 * Scrubs sensitive query params from the URL.
 */
export function scrubBreadcrumbData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return data;

  const scrubbed = { ...data };

  if (typeof scrubbed.url === 'string') {
    scrubbed.url = scrubUrl(scrubbed.url);
  }

  // Remove body fields — POST payloads always contain health data in this app
  delete scrubbed.body;
  delete scrubbed.request_body;
  delete scrubbed.request_body_size;
  delete scrubbed.response_body_size;

  return scrubbed;
}

// ---------------------------------------------------------------------------
// Free-text scrub (added 2026-09-10 after a ChatGPT audit of the server hook)
// ---------------------------------------------------------------------------
// Key-based redaction cannot see a value written in a sentence: "My LDL is 3.2
// mmol/L" survived in `exception.values[].value`, in an `extra.message` string
// and in console breadcrumbs. These rules run over every free-text field of an
// event, on top of the key scrub. Stack frames, filenames and error class names
// are never touched.
//
// The vocabularies are literals, not imports: instrument-scrub.mjs must carry
// the same lists and is loaded before the bundle, outside any workspace
// resolution. `instrument-scrub-parity.test.ts` compares both impls AND checks
// the lists against UNIT_DEFS / METRIC_LABELS, so a new unit or metric fails.

/**
 * Unit spellings that make a bare number a health value. Covers every
 * UNIT_DEFS label (parity-tested) plus the dose units a medication sentence
 * uses ("metformin 500mg").
 */
export const SCRUB_UNITS: readonly string[] = [
  'mmol/L', 'mmol/mol', 'mg/dL', 'µmol/L', 'umol/L', 'micromol/L', 'nmol/L',
  'ng/mL', 'µg/L', 'ug/L', 'mg/L', 'g/L', 'mmHg', 'mm Hg',
  'kg', 'lbs', 'lb', 'cm', '%',
  // Dose units
  'mcg', 'µg', 'mg', 'g', 'IU', 'mL', 'ml', 'units',
  // Inches: matched by a stricter rule (see INCH_UNIT) — "5 in the morning"
  // is English, not a height.
  'in', '"',
];

/** Metric and lab names that make an adjacent number a health value. */
export const SCRUB_METRIC_WORDS: readonly string[] = [
  'total cholesterol', 'ldl cholesterol', 'hdl cholesterol', 'non-hdl',
  'cholesterol', 'triglycerides', 'hba1c', 'a1c', 'apob', 'apo b', 'lp(a)',
  'lpa', 'ldl', 'hdl', 'psa', 'creatinine', 'egfr', 'blood pressure',
  'systolic', 'diastolic', 'bp', 'bmi', 'weight', 'waist', 'height',
  'glucose', 'testosterone', 'vitamin d', 'ferritin', 'tsh',
];

/** A number, or a blood-pressure pair ("140/90"). */
const NUMBER = '\\d+(?:[.,]\\d+)?(?:/\\d+(?:[.,]\\d+)?)?';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Longest first so "mmol/L" wins over "mol" and "ldl cholesterol" over "ldl". */
const alternation = (words: readonly string[]) =>
  [...words].sort((a, b) => b.length - a.length).map(escapeRe).join('|');

/** Inches only at the end of a phrase — never "in" leading a word. */
const INCH_UNIT = '(?:in(?=\\s*(?:[^A-Za-z0-9\\s]|$))|")';
const PLAIN_UNITS = SCRUB_UNITS.filter(u => u !== 'in' && u !== '"');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UNIT_VALUE_RE = new RegExp(
  `\\b${NUMBER}\\s*(?:(?:${alternation(PLAIN_UNITS)})(?![A-Za-z])|${INCH_UNIT})`, 'gi');
const METRIC_THEN_VALUE_RE = new RegExp(
  `\\b(${alternation(SCRUB_METRIC_WORDS)})([^\\d\\n]{0,20}?)(${NUMBER})`, 'gi');
const VALUE_THEN_METRIC_RE = new RegExp(
  `(${NUMBER})([^\\d\\n]{0,20}?)\\b(${alternation(SCRUB_METRIC_WORDS)})\\b`, 'gi');

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
