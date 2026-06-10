/**
 * Shared lab/document extraction logic — the PURE pieces of the pipeline:
 * the unified system prompt, the LLM-response schema/parsing, and the
 * unit-resolution tables. No fetch, no env, no Sentry.
 *
 * Two consumers (moved here June 2026 so they can never drift):
 *  - app/lib/anthropic.server.ts — Brad's server (Shopify widget + the
 *    drstanfield.com v2 page), which wraps these with the server fetch,
 *    retries, batching, and Sentry.
 *  - widget-src/src/lib/byok-upload.ts — the standalone (GitHub Pages /
 *    self-host) build, which calls api.anthropic.com directly with the
 *    user's own key. This means the prompt ships in the public Pages
 *    bundle: Brad accepted that 2026-06-10 — it is mechanical value
 *    extraction, not clinical IP (the algorithm doc never leaves the server).
 */
import { z } from 'zod';
import { toCanonicalValue, UNIT_DEFS, type MetricType, type UnitSystem } from './units';
import { DOCUMENT_TYPES } from './validation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What we return to the client (after unit resolution) */
export interface ExtractedValue {
  metric: string;
  valueSI: number;
  displayValue: number;
  displayUnit: string;
  /** Which unit system displayUnit/displayValue belong to. Lets the
   *  review-time edit UI recompute valueSI client-side without a round-trip. */
  displaySystem: UnitSystem;
  confidence: 'high' | 'medium' | 'low';
  question?: string;
}

/** Content block from the client */
export interface PageContent {
  type: 'text' | 'image';
  content: string;
  mimeType?: string;
}

export interface DocumentResult {
  classification: string;
  title: string;
  documentDate: string | null;
  contentMarkdown: string;
  metadata: Record<string, unknown>;
}

/** A lab value outside the 11 core metrics — stored as-is (no unit conversion). */
export interface AdditionalLabValue {
  name: string;
  value: number;
  unit: string;
  referenceLow?: number | null;
  referenceHigh?: number | null;
}

export interface UnifiedExtractionResult {
  classification: string;
  /** Lab values (populated when classification is lab_report) */
  reportDate: string | null;
  values: ExtractedValue[];
  additionalValues: AdditionalLabValue[];
  unrecognized: string[];
  /** Document data (populated when classification is NOT lab_report) */
  document: DocumentResult | null;
}

// ---------------------------------------------------------------------------
// Unit resolution
// ---------------------------------------------------------------------------

export const VALID_METRICS: MetricType[] = [
  'hba1c', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides',
  'apob', 'creatinine', 'psa', 'lpa', 'systolic_bp', 'diastolic_bp',
];

/**
 * Deterministic lookup: (metric, normalized unit string) → UnitSystem.
 * Auto-populated from UNIT_DEFS labels + manual aliases for common variations.
 */
const UNIT_LOOKUP: Record<string, Record<string, UnitSystem>> = {};

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace('µ', 'u');
}

// Auto-populate from UNIT_DEFS
for (const metric of VALID_METRICS) {
  const def = UNIT_DEFS[metric];
  UNIT_LOOKUP[metric] = {};
  UNIT_LOOKUP[metric][norm(def.label.si)] = 'si';
  UNIT_LOOKUP[metric][norm(def.label.conventional)] = 'conventional';
}

// Manual aliases for common variations found in lab reports
function addAlias(metric: string, alias: string, system: UnitSystem): void {
  if (!UNIT_LOOKUP[metric]) UNIT_LOOKUP[metric] = {};
  UNIT_LOOKUP[metric][alias] = system;
}
addAlias('creatinine', 'umol/l', 'si');
addAlias('creatinine', 'micromol/l', 'si');
addAlias('hba1c', 'mmol/mol', 'si');
addAlias('hba1c', '%', 'conventional');
addAlias('apob', 'mg/dl', 'conventional');
// Lp(a) — NZ/AU/UK labs report in mg/L, guidelines prefer nmol/L
addAlias('lpa', 'mg/l', 'conventional');
// BP aliases (already mmHg in both systems, but lab reports sometimes use variations)
addAlias('systolic_bp', 'mmhg', 'si');
addAlias('diastolic_bp', 'mmhg', 'si');

/** Exported for testing */
export function resolveUnit(metric: MetricType, unitStr: string, value: number): {
  valueSI: number;
  system: UnitSystem;
  confident: boolean;
} {
  const normalized = norm(unitStr);
  const lookup = UNIT_LOOKUP[metric];

  if (lookup && lookup[normalized]) {
    const system = lookup[normalized];
    const valueSI = system === 'si' ? value : toCanonicalValue(metric, value, 'conventional');
    return { valueSI, system, confident: true };
  }

  // Fallback: check which validation range the value fits
  const def = UNIT_DEFS[metric];
  const siRange = def.validationRange.si;
  const convRange = def.validationRange.conventional;
  const fitsInSI = value >= siRange.min && value <= siRange.max;
  const fitsInConv = value >= convRange.min && value <= convRange.max;

  if (fitsInSI && !fitsInConv) {
    return { valueSI: value, system: 'si', confident: false };
  }
  if (fitsInConv && !fitsInSI) {
    return { valueSI: toCanonicalValue(metric, value, 'conventional'), system: 'conventional', confident: false };
  }
  // Fits both or neither — assume SI, flag low confidence
  return { valueSI: value, system: 'si', confident: false };
}

/** Resolve units for an array of LLM-extracted lab values. Shared by all extraction paths. */
export function resolveLabValues(rawValues: Array<{ metric: string; value: number; unit: string; confidence: 'high' | 'medium' | 'low'; question?: string }>): ExtractedValue[] {
  const values: ExtractedValue[] = [];
  for (const v of rawValues) {
    if (!VALID_METRICS.includes(v.metric as MetricType)) continue;
    const metric = v.metric as MetricType;
    const { valueSI, system, confident } = resolveUnit(metric, v.unit, v.value);
    values.push({
      metric: v.metric,
      valueSI,
      displayValue: v.value,
      displayUnit: v.unit,
      displaySystem: system,
      confidence: !confident && v.confidence === 'high' ? 'medium' : v.confidence,
      question: !confident
        ? (v.question || `Unit "${v.unit}" was inferred — please verify this value`)
        : v.question,
    });
  }
  return values;
}

// ---------------------------------------------------------------------------
// Unified system prompt (classify + extract/convert in one call)
// ---------------------------------------------------------------------------

export const DOCUMENT_CLASSIFICATIONS = ['lab_report', ...DOCUMENT_TYPES] as const;

export const UNIFIED_SYSTEM_PROMPT = `You are a medical document processor. Classify the document, then process accordingly.

STEP 1 — CLASSIFY the document as one of:
- "lab_report": Blood test results, pathology panels, metabolic panels, lipid panels
- "scan_result": Imaging or procedure reports (colonoscopy, MRI, CT, DEXA, ultrasound, mammogram, X-ray, echocardiogram)
- "clinic_letter": Letters from specialists, GP consultations, referral letters, consultation notes
- "discharge_summary": Hospital discharge documents
- "pathology_report": Biopsy results, histology reports, cytology
- "vaccination_record": Immunization records, vaccine certificates
- "other": Any other medical document

STEP 2 — PROCESS based on classification:

IF "lab_report":
  Extract blood test values using TARGET METRICS below. Set "document" to null.

  TARGET METRICS (use these exact keys):
  - "ldl" — LDL, LDL-C, LDL Cholesterol, Low Density Lipoprotein
  - "hdl" — HDL, HDL-C, HDL Cholesterol, High Density Lipoprotein
  - "total_cholesterol" — Total Cholesterol, TC, Cholesterol Total
  - "triglycerides" — Triglycerides, TG, Trigs
  - "hba1c" — HbA1c, Hemoglobin A1c, Glycated Hemoglobin, A1C, Glycated Haemoglobin
  - "creatinine" — Creatinine, Creat, Cr, Serum Creatinine
  - "apob" — ApoB, Apolipoprotein B, Apo B
  - "psa" — PSA, Prostate Specific Antigen
  - "lpa" — Lp(a), Lipoprotein(a), Lipoprotein little a
  - "systolic_bp" — Systolic Blood Pressure, Systolic BP, SBP
  - "diastolic_bp" — Diastolic Blood Pressure, Diastolic BP, DBP

  CRITICAL RULES:
  1. Extract ACTUAL measured result values ONLY. NEVER extract reference ranges, target values, or normal limits.
  2. If the report shows previous/historical results (in a "Previous" column, "Last visit" column, trend graph, or any side-by-side layout), IGNORE them completely. Extract ONLY values from the current report's primary column, even if those historical columns are dated. Return at most ONE entry per metric — never duplicate a metric in the output.
  3. Use COLLECTION/SAMPLE date, NOT report/print date. Return as YYYY-MM-DD.
  4. For ambiguous dates (03/04/2026): prefer DD/MM/YYYY for non-US labs, MM/DD/YYYY for US.
  5. Multi-page documents: date on page 1, results on later pages — correlate them.
  6. If uncertain about a value, set confidence to "low" with a "question" explaining why.
  7. Extract ALL other numeric test results NOT in TARGET METRICS into "additionalValues" array.

  ADDITIONAL VALUES — use these standardized snake_case names when applicable:
  FBC: haemoglobin, rbc, wbc, platelets, mcv, mch, haematocrit, neutrophils, lymphocytes, monocytes, eosinophils, basophils
  LFTs: alt, ast, ggt, alp, bilirubin, albumin, total_protein, globulin
  U&Es: sodium, potassium, urea, chloride, bicarbonate
  Kidney: cystatin_c, egfr
  Thyroid: tsh, free_t4, free_t3
  Iron: ferritin, iron, tibc, transferrin_saturation
  Vitamins: vitamin_b12, folate, vitamin_d
  Inflammation: crp, hs_crp, esr
  Hormones: testosterone, free_testosterone, shbg, estradiol, prolactin, progesterone, dhea_s, igf1
  Metabolic: fasting_glucose, fasting_insulin, uric_acid
  Other: homocysteine, or any other metric — use best descriptive snake_case name.
  Include reference ranges (referenceLow, referenceHigh) when visible on the report.

IF any other classification:
  Convert the ENTIRE document to well-formatted markdown and extract metadata. Set "values" to [].

  MARKDOWN RULES:
  - Preserve ALL text content — do not summarize or omit anything
  - Use ## and ### for section headers
  - Use **bold** for emphasis, key findings, diagnoses
  - Use tables (| col | col |) where the original has tabular data
  - Use bullet lists for enumerated items
  - Clean up OCR artifacts (broken words, stray characters) but never change medical terms
  - Generate a concise title (e.g. "Colonoscopy Report — Dr. Smith, Nov 2025")
  - Extract the document/appointment date as YYYY-MM-DD

  METADATA (include relevant fields as JSON):
  - provider: Doctor or specialist name
  - facility: Hospital or clinic name
  - For scan_result: scanType (colonoscopy, mri, ct, dexa, mammogram, ultrasound, xray, echocardiogram, other), findings (brief summary), screeningType (one of: colorectal, breast, cervical, lung, prostate, dexa — ONLY if the scan clearly maps to one of these screening categories, otherwise omit)
  - For clinic_letter: specialty, diagnoses (array), medicationsMentioned (array)
  - For discharge_summary: admissionDate (YYYY-MM-DD), dischargeDate (YYYY-MM-DD), diagnoses (array), procedures (array)
  - For pathology_report: specimenType, site, result (benign/malignant/indeterminate)
  - For vaccination_record: vaccine, dose, manufacturer

RESPONSE FORMAT (strict JSON, no markdown wrapping):
{
  "classification": "lab_report" | "scan_result" | etc.,
  "reportDate": "YYYY-MM-DD" or null,
  "values": [
    { "metric": "ldl", "value": 2.8, "unit": "mmol/L", "confidence": "high" }
  ],
  "additionalValues": [
    { "name": "sodium", "value": 139, "unit": "mmol/L", "referenceLow": 135, "referenceHigh": 145 }
  ],
  "document": {
    "title": "Colonoscopy Report — Dr. Smith",
    "documentDate": "2025-11-15",
    "contentMarkdown": "## Colonoscopy Report\\n\\n...",
    "metadata": { "scanType": "colonoscopy", "provider": "Dr. Smith", "screeningType": "colorectal" }
  } or null
}`;

/** The extraction model — matches the website chat / server pipeline. */
export const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';
export const EXTRACTION_MAX_TOKENS = 8192; // Higher limit for markdown conversion

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Lab values frequently encode non-numeric measurements as strings:
 *   "<5"       (below detection limit)
 *   ">2000"    (above range)
 *   "trace", "POS", "Not detected"
 *   "1,234"    (european thousands separator)
 *
 * The LLM sometimes mirrors those strings into the `value` field even
 * though the prompt asks for numbers. Coerce numeric-looking strings to
 * numbers, leave true non-numerics as null so the post-parse filter can
 * drop the row (rather than throwing on the whole batch).
 */
const numericValue = z.preprocess(v => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return v;
  // Strip european thousand separators, then parse. parseFloat returns NaN
  // for "<5", "trace", etc. — we surface that as null to drop the row.
  const cleaned = v.replace(/,/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}, z.number().nullable());

const unifiedResultSchema = z.object({
  classification: z.enum(DOCUMENT_CLASSIFICATIONS),
  reportDate: z.string().nullable(),
  values: z.array(z.object({
    metric: z.string(),
    value: numericValue,
    unit: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    question: z.string().optional(),
  })).default([]),
  additionalValues: z.array(z.object({
    name: z.string().default(''),
    value: numericValue,
    unit: z.string().default(''),
    referenceLow: z.number().nullable().optional(),
    referenceHigh: z.number().nullable().optional(),
  })).default([]),
  unrecognized: z.array(z.string()).optional(),
  document: z.object({
    title: z.string(),
    documentDate: z.string().nullable(),
    contentMarkdown: z.string(),
    metadata: z.record(z.unknown()).default({}),
  }).nullable().default(null),
});

/** Wraps schema parse + drops rows whose value field couldn't be coerced to
 *  a finite number (the schema marks those null). Exposed for testing. */
export function parseUnifiedResult(raw: unknown) {
  const parsed = unifiedResultSchema.parse(raw);
  return {
    ...parsed,
    values: parsed.values.filter(v => v.value !== null) as Array<typeof parsed.values[number] & { value: number }>,
    additionalValues: parsed.additionalValues.filter(v => v.value !== null) as Array<typeof parsed.additionalValues[number] & { value: number }>,
  };
}

/** Build a UnifiedExtractionResult from a parsed-and-filtered unified response. */
export function toUnifiedResult(parsed: ReturnType<typeof parseUnifiedResult>): UnifiedExtractionResult {
  const isLab = parsed.classification === 'lab_report';
  const values = isLab ? resolveLabValues(parsed.values) : [];
  return {
    classification: parsed.classification,
    reportDate: parsed.reportDate,
    values,
    additionalValues: isLab ? parsed.additionalValues.filter(v => v.name.length > 0) : [],
    unrecognized: parsed.unrecognized || [],
    document: parsed.document ? {
      classification: parsed.classification,
      title: parsed.document.title,
      documentDate: parsed.document.documentDate,
      contentMarkdown: parsed.document.contentMarkdown,
      metadata: parsed.document.metadata as Record<string, unknown>,
    } : null,
  };
}

/** Strip markdown code fences (```json ... ```) from LLM response text */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return trimmed;
}

/**
 * Extract the outermost JSON object from LLM text. Tolerant of code fences,
 * leading/trailing prose, and post-output commentary (some models — notably
 * Haiku on emergent medical queries — still append explanation even after
 * being told "JSON only"). Callers that need strict JSON should prefer this
 * over stripCodeFences.
 */
export function extractJsonObject(text: string): string {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) return text;
  return text.slice(first, last + 1);
}

/** Convert PageContent[] into Anthropic message content blocks. */
export function pagesToContentBlocks(pages: PageContent[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  for (const page of pages) {
    if (page.type === 'text') {
      content.push({ type: 'text', text: page.content });
    } else {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: page.mimeType || 'image/jpeg',
          data: page.content,
        },
      });
    }
  }
  return content;
}
