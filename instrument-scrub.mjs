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

export const SENSITIVE_EXACT_KEYS = new Set([
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
  'displayvalue', 'display_value',
  'valuesi', 'value_si',
  'contentmarkdown', 'content_markdown',
  // An extracted row or document, field by field (US-09 AC7c). `metric` is
  // the health-specific name of `metricType`. `name` is NOT here: the SDK
  // names the OS and runtime by it in `contexts`.
  'metric', 'metricname', 'metric_name', 'printedname',
  'referencelow', 'reference_low', 'referencehigh', 'reference_high',
  'unrecognized', 'question', 'extractedtext', 'content_md', 'document_type',
  'recordedat', 'recorded_at', 'documentdate', 'document_date',
  'classification', 'supplementname', 'supplement_name', 'metadata',
  'reportdate', 'report_date', 'collectedon', 'collected_on',
  'existingvalue', 'documenttype', 'documentcontent',
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
  '%', 'IU/L', 'IU/mL', 'L/L', 'U/L', 'U/mL', 'cm', 'fL', 'g/L', 'in', 'kU/L', 'kg', 'lbs', 'mIU/L',
  'mL/min/1.73m²', 'mOsm/kg', 'mg/L', 'mg/L FEU', 'mg/dL', 'mg/mmol', 'mm/hr', 'mmHg', 'mmol/L', 'mmol/mol',
  'ng/L', 'ng/mL', 'nmol/L', 'pg', 'pmol/L', 'µg/L', 'µmol/L', '×10¹²/L', '×10⁹/L', 'mm Hg', 'umol/L',
  'micromol/L', 'ug/L', 'lb', 'mcg', 'µg', 'mg', 'g', 'IU', 'mL', 'ml', 'units', '"',
];

export const SCRUB_METRIC_WORDS = [
  'acr', 'acth', 'adrenocorticotropic', 'alanine', 'albumin', 'alk', 'alkaline', 'alp', 'alpha', 'alt', 'amh',
  'aminotransferase', 'amylase', 'androstenedione', 'anion', 'antibody', 'apo', 'apoa', 'apoa1', 'apob',
  'apolipoprotein', 'ascorbic', 'aspartate', 'ast', 'b12', 'baso', 'basophil', 'basophils', 'bicarbonate',
  'bilirubin', 'bioavailable', 'bnp', 'bun', 'caeruloplasmin', 'calcium', 'ccp', 'ceruloplasmin', 'cft',
  'chloride', 'chol', 'cholesterol', 'chorionic', 'citrullinated', 'ckd', 'co2', 'cobalamin', 'concentration',
  'copper', 'corticotropin', 'cortisol', 'cpk', 'creatine', 'creatinine', 'crp', 'ctni', 'ctnt', 'cyclic',
  'cys', 'cystatin', 'dehydroepiandrosterone', 'dehydrogenase', 'dhea', 'dheas', 'dht', 'diastolic',
  'dihydrotestosterone', 'dimer', 'eag', 'egfr', 'egfrcr', 'egfrcys', 'eos', 'eosinophil', 'eosinophils',
  'epi', 'erythrocyte', 'erythrocytes', 'esr', 'estradiol', 'estrone', 'fasting', 'fbg', 'ferritin',
  'fibrinogen', 'filtration', 'folate', 'folic', 'follicle', 'fpg', 'fructosamine', 'fsh', 'ft3', 'ft4',
  'gamma', 'gfr', 'ggt', 'ggtp', 'globulin', 'glomerular', 'glucose', 'glutamyl', 'gonadotropin', 'grans',
  'granulocyte', 'granulocytes', 'haematocrit', 'haemoglobin', 'hba1c', 'hcg', 'hco3', 'hct', 'hdl',
  'hematocrit', 'hemoglobin', 'hgb', 'hgh', 'holotc', 'holotranscobalamin', 'homocysteine', 'hscrp', 'hydroxy',
  'hydroxyprogesterone', 'hydroxyvitamin', 'iga', 'ige', 'igf', 'igf1', 'immunoglobulin', 'insulin', 'iron',
  'kinase', 'lactate', 'lactic', 'ldh', 'ldl', 'leucocytes', 'leukocytes', 'lipase', 'llerian', 'lpa',
  'luteinising', 'luteinizing', 'lymphocyte', 'lymphocytes', 'lymphs', 'magnesium', 'mch', 'mchc', 'mcv',
  'methylmalonic', 'microalbumin', 'mma', 'monocyte', 'monocytes', 'mpv', 'mullerian', 'natriuretic', 'neut',
  'neutrophil', 'neutrophils', 'nitrogen', 'nrbc', 'ntprobnp', 'oestradiol', 'oestrone', 'ohp', 'omega',
  'omega3', 'osmolality', 'parathyroid', 'pcr', 'pcv', 'peptide', 'peroxidase', 'phos', 'phosphatase',
  'phosphate', 'phosphokinase', 'phosphorus', 'plasma', 'platelet', 'platelets', 'plp', 'plt', 'po4',
  'potassium', 'probnp', 'procalcitonin', 'progesterone', 'prolactin', 'psa', 'pth', 'pyridoxal', 'rbc', 'rdw',
  'reactive', 'retic', 'reticulocyte', 'reticulocytes', 'retinol', 'rheumatoid', 'rt3', 'sedimentation',
  'selenium', 'sgot', 'sgpt', 'shbg', 'sodium', 'somatomedin', 'somatotropin', 'stfr', 'sulfate', 'sulphate',
  'systolic', 't3u', 'testosterone', 'tgab', 'thiamin', 'thiamine', 'thyroglobulin', 'thyroid', 'thyrotropin',
  'thyroxine', 'tibc', 'tni', 'tnt', 'tocopherol', 'tpo', 'tpoab', 'trab', 'transferase', 'transferrin',
  'transglutaminase', 'triglycerides', 'triiodothyronine', 'troponin', 'tsat', 'tsh', 'ttg', 'uibc', 'upcr',
  'urate', 'urea', 'uric', 'urinary', 'urine', 'vitamin', 'vldl', 'waist', 'wbc', 'weight', 'zinc', 'na',
  'na+', 'k', 'k+', 'cl', 'cl-', 'total co2', 'carbon dioxide, total', 'carbon dioxide', 'blood urea nitrogen',
  'urea nitrogen', 'urea nitrogen (bun)', 'blood urea nitrogen (bun)', 'urea (bun)', 'uric acid', 'urine_acr',
  'urine acr', 'albumin creatinine ratio', 'microalbumin ratio', 'urine_creatinine', 'urine creatinine',
  'creatinine urine', 'urinary creatinine', 'creatinine (urine)', 'urine_pcr', 'urine pcr',
  'protein creatinine ratio', 'protein:creatinine ratio', 'urine protein creatinine ratio', 'cystatin_c',
  'cystatin c', 'estimated gfr', 'estimated glomerular filtration rate', 'egfr (ckd-epi)', 'egfr_cystatin',
  'egfr (cystatin c)', 'egfr cystatin c', 'egfr cystatin', 'egfr_combined', 'egfr (creatinine-cystatin c)',
  'egfrcr-cys', 'egfr cr-cys', 'egfr creatinine-cystatin c', 'anion_gap', 'anion gap', 'osmolality_serum',
  'osmolality (serum)', 'serum osmolality', 'plasma osmolality', 'osmolality, serum', 'osmolality, plasma',
  'osmolality (plasma)', 'alanine aminotransferase', 'alt (sgpt)', 'aspartate aminotransferase', 'ast (sgot)',
  'gamma gt', 'gamma-glutamyl transferase', 'γ-gt', 'gamma gt (ggt)', 'alkaline phosphatase', 'alk phos',
  'alk. phosphatase', 'bilirubin_total', 'bilirubin (total)', 'total bilirubin', 'bilirubin, total',
  'bilirubin_direct', 'bilirubin (direct)', 'direct bilirubin', 'conjugated bilirubin', 'bilirubin, direct',
  'lactate dehydrogenase', 'ld', 'total_protein', 'total protein', 'protein total', 'protein',
  'protein, total', 'globulin, total', 'bilirubin_indirect', 'bilirubin (indirect)', 'indirect bilirubin',
  'unconjugated bilirubin', 'bilirubin, indirect', 'serum lipase', 'serum amylase', 'hb', 'haemoglobin (hb)',
  'packed cell volume', 'haematocrit (hct)', 'red blood cells', 'red blood cell count', 'red cell count',
  'white blood cells', 'white blood cell count', 'white cell count', 'total white cell count',
  'platelet count', 'neutrophil count', 'neutrophils (absolute)', 'absolute neutrophils', 'neutrophils abs',
  'lymphocyte count', 'lymphocytes (absolute)', 'absolute lymphocytes', 'lymphocytes abs', 'lymphs (absolute)',
  'monocyte count', 'monocytes (absolute)', 'absolute monocytes', 'monocytes abs', 'monocytes(absolute)',
  'eosinophil count', 'eosinophils (absolute)', 'absolute eosinophils', 'eosinophils abs', 'eos (absolute)',
  'basophil count', 'basophils (absolute)', 'absolute basophils', 'basophils abs', 'baso (absolute)',
  'mean cell volume', 'mean corpuscular volume', 'mean cell haemoglobin', 'mean corpuscular hemoglobin',
  'mean cell haemoglobin concentration', 'mean corpuscular hemoglobin concentration',
  'red cell distribution width', 'rdw-cv', 'rdw cv', 'rdw_sd', 'rdw-sd', 'mean platelet volume',
  'immature_granulocytes', 'immature granulocytes', 'immature granulocyte count', 'immature grans (abs)',
  'reticulocyte count', 'retic count', 'absolute reticulocyte count', 'nucleated red blood cells',
  'nucleated rbc', 'nucleated red cells', 'd_dimer', 'd-dimer', 'thyroid stimulating hormone',
  'tsh (thyroid stimulating hormone)', 'free t4', 'free thyroxine', 't4 free', 't4, free', 'free t4 (ft4)',
  'free thyroxine (ft4)', 'free t3', 'free triiodothyronine', 't3 free', 't3, free', 'anti_tpo', 'anti-tpo',
  'tpo antibodies', 'thyroid peroxidase antibodies', 'anti thyroid peroxidase', 'thyroid peroxidase (tpo) ab',
  'total_t4', 'total t4', 't4 total', 't4, total', 'thyroxine (t4)', 'total thyroxine', 'total_t3', 'total t3',
  't3 total', 't3, total', 'triiodothyronine (t3)', 'total triiodothyronine', 'reverse_t3', 'reverse t3',
  'reverse triiodothyronine', 't3_uptake', 't3 uptake', 't-uptake', 'anti_tg', 'anti-tg',
  'thyroglobulin antibodies', 'anti-thyroglobulin', 'anti thyroglobulin antibodies', 'tsh receptor antibodies',
  'tsh receptor antibody', 'thyrotropin receptor antibodies', 'testosterone_total', 'testosterone (total)',
  'total testosterone', 'testosterone, total', 'plasma testosterone', 'free_testosterone', 'free testosterone',
  'testosterone, free', 'free_testosterone_calculated', 'free testosterone (calculated)',
  'calculated free testosterone', 'calculated free t', 'sex hormone binding globulin',
  'shbg (sex hormone binding globulin)', 'e2', 'cortisol_am', 'cortisol (morning)', 'am cortisol',
  'cortisol, am', 'psa_free', 'psa (free)', 'free psa', 'psa, free', 'lh', 'luteinising hormone',
  'luteinizing hormone', 'follicle stimulating hormone', 'dhea_s', 'dhea-s', 'dhea sulphate', 'dhea sulfate',
  'dehydroepiandrosterone sulfate', 'dehydroepiandrosterone sulphate', 'igf-1', 'igf 1',
  'insulin-like growth factor 1', 'somatomedin c', 'parathyroid hormone', 'intact pth', 'pth intact',
  'pth, intact', 'anti-mullerian hormone', 'anti-müllerian hormone', 'anti mullerian hormone',
  'bioavailable_testosterone', 'bioavailable testosterone', 'testosterone, bioavailable', 'psa_free_percent',
  'psa (% free)', '% free psa', 'percent free psa', 'free psa %', 'psa % free', 'e1', 'oh_progesterone_17',
  '17-oh progesterone', '17-hydroxyprogesterone', '17 hydroxyprogesterone', '17-ohp',
  'adrenocorticotropic hormone', 'gh', 'growth hormone', 'human growth hormone', 'beta hcg', 'beta-hcg',
  'b-hcg', 'human chorionic gonadotropin', 'total hcg', 'vitamin_d', 'vitamin d (25-oh)',
  '25-hydroxyvitamin d', '25-oh vitamin d', 'vitamin d3', '25(oh)d', 'vitamin d, 25-hydroxy',
  '25-hydroxy vitamin d', '25 oh vitamin d', 'vitamin d (25 oh)', 'vitamin_b12', 'vitamin b12',
  'vitamin b12 (cobalamin)', 'b12_active', 'active b12', 'folic acid', 'serum folate', 'folate, serum',
  'ferritin (serum)', 'serum iron', 'iron, total', 'total iron binding capacity', 'iron binding capacity',
  'transferrin_sat', 'transferrin saturation', 'iron saturation', 'transferrin saturation %', 'mg',
  'calcium_corrected', 'calcium (corrected)', 'corrected calcium', 'adjusted calcium', 'calcium_total',
  'calcium (total)', 'total calcium', 'serum calcium', 'ca', 'inorganic phosphate', 'red_cell_folate',
  'red cell folate', 'rbc folate', 'erythrocyte folate', 'red blood cell folate', 'calcium_ionised',
  'calcium (ionised)', 'ionised calcium', 'ionized calcium', 'free calcium', 'ca++', 'calcium, ionized',
  'calcium, ionised', 'unsaturated iron binding capacity', 'soluble transferrin receptor', 'serum copper',
  'omega3_index', 'omega-3 index', 'omega 3 index', 'vitamin_a', 'vitamin a', 'vitamin_e', 'vitamin e',
  'alpha-tocopherol', 'alpha tocopherol', 'vitamin_c', 'vitamin c', 'ascorbic acid', 'vitamin_b6',
  'vitamin b6', 'pyridoxal 5-phosphate', "pyridoxal 5'-phosphate", 'pyridoxal phosphate', 'vitamin_b1',
  'vitamin b1', 'methylmalonic acid', 'c-reactive protein', 'hs-crp', 'hs crp', 'high sensitivity crp',
  'crp, high sensitivity', 'cardiac crp', 'c reactive protein', 'erythrocyte sedimentation rate', 'sed rate',
  'sedimentation rate', 'ige (total)', 'total ige', 'immunoglobulin e', 'serum ige', 'rf', 'rheumatoid factor',
  'anti_ccp', 'anti-ccp', 'ccp antibodies', 'anti-cyclic citrullinated peptide',
  'cyclic citrullinated peptide antibodies', 'total_iga', 'iga (total)', 'total iga', 'immunoglobulin a',
  'serum iga', 'ttg_iga', 'ttg-iga', 'tissue transglutaminase iga', 'anti-ttg iga',
  'tissue transglutaminase antibody iga', 'fasting glucose', 'fasting plasma glucose', 'plasma glucose',
  'glucose fasting', 'blood glucose', 'glucose, fasting', 'glucose_random', 'glucose (random)',
  'random glucose', 'glucose random', 'non-fasting glucose', 'fasting insulin', 'serum insulin',
  'apolipoprotein a1', 'apolipoprotein a-i', 'apo a1', 'apo a-1', 'apoa-1', 'apoa-i', 'total homocysteine',
  'plasma homocysteine', 'ck', 'creatine kinase', 'creatine phosphokinase', 'nt_probnp', 'nt-probnp',
  'nt pro bnp', 'n-terminal pro-bnp', 'n-terminal pro b-type natriuretic peptide',
  'b-type natriuretic peptide', 'brain natriuretic peptide', 'troponin_t', 'troponin t', 'hs troponin t',
  'hs-troponin t', 'high sensitivity troponin t', 'hs-tnt', 'hs-ctnt', 'troponin_i', 'troponin i',
  'hs troponin i', 'hs-troponin i', 'high sensitivity troponin i', 'hs-tni', 'hs-ctni', 'c_peptide',
  'c-peptide', 'estimated average glucose', 'vldl cholesterol', 'vldl-c', 'vldl chol', 'lactic acid',
  'blood pressure', 'apo b', 'lp(a)', 'a1c', 'bp', 'bmi', 'height',
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
// A name starts where no letter or digit runs into it and ends where no letter
// does: digits straight after a name are its value. A number inside a word
// (the 1 of "A1c") is never the value (mirror of sentry-scrub.ts).
const METRIC_THEN_VALUE_RE = new RegExp(
  `(?<![a-z0-9])(${alternation(SCRUB_METRIC_WORDS)})(?![a-z])([^\\d\\n]{0,20}?)(?!(?<=[a-z])\\d+(?:[.,]\\d+)?[a-z])(${NUMBER})`, 'gi');
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
