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
const SENSITIVE_PARAMS = ['token', 'logged_in_customer_id', 'email'];

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
