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
// DRIFT GUARD: packages/health-core/instrument-scrub-parity.test.ts asserts these functions
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
