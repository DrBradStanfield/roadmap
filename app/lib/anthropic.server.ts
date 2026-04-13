/**
 * Anthropic API wrapper for health document processing.
 * System prompt is hardcoded server-side — client sends only content.
 *
 * Two modes:
 *   extractLabResults()        — lab report → structured numeric values
 *   processHealthDocument()    — any document → markdown + metadata
 *
 * The unified extractOrClassify() function auto-classifies each file and
 * routes to the appropriate handler in a single LLM call.
 */
import { z } from 'zod';
import * as Sentry from '@sentry/remix';
import { toCanonicalValue, UNIT_DEFS, type MetricType, type UnitSystem } from '../../packages/health-core/src/units';
import { DOCUMENT_TYPES } from '../../packages/health-core/src/validation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the LLM returns (raw, before unit resolution) */
const llmResultSchema = z.object({
  reportDate: z.string().nullable(),
  values: z.array(z.object({
    metric: z.string(),
    value: z.number(),
    unit: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    question: z.string().optional(),
  })),
  unrecognized: z.array(z.string()).optional(),
});

type LlmResult = z.infer<typeof llmResultSchema>;

/** What we return to the client (after unit resolution) */
export interface ExtractedValue {
  metric: string;
  valueSI: number;
  displayValue: number;
  displayUnit: string;
  confidence: 'high' | 'medium' | 'low';
  question?: string;
}

export interface ExtractionResult {
  reportDate: string | null;
  values: ExtractedValue[];
  unrecognized: string[];
}

/** Content block from the client */
export interface PageContent {
  type: 'text' | 'image';
  content: string;
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// Unit resolution
// ---------------------------------------------------------------------------

const VALID_METRICS: MetricType[] = [
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
/** Exported for testing */
export function resolveLabValues(rawValues: Array<{ metric: string; value: number; unit: string; confidence: 'high' | 'medium' | 'low'; question?: string }>): ExtractedValue[] {
  const values: ExtractedValue[] = [];
  for (const v of rawValues) {
    if (!VALID_METRICS.includes(v.metric as MetricType)) continue;
    const metric = v.metric as MetricType;
    const { valueSI, confident } = resolveUnit(metric, v.unit, v.value);
    values.push({
      metric: v.metric,
      valueSI,
      displayValue: v.value,
      displayUnit: v.unit,
      confidence: !confident && v.confidence === 'high' ? 'medium' : v.confidence,
      question: !confident
        ? (v.question || `Unit "${v.unit}" was inferred — please verify this value`)
        : v.question,
    });
  }
  return values;
}

/** Build a UnifiedExtractionResult from a parsed unified response. */
function toUnifiedResult(parsed: z.infer<typeof unifiedResultSchema>): UnifiedExtractionResult {
  const isLab = parsed.classification === 'lab_report';
  const values = isLab ? resolveLabValues(parsed.values) : [];
  return {
    classification: parsed.classification,
    reportDate: parsed.reportDate,
    values,
    additionalValues: isLab ? (parsed.additionalValues || []).filter(v => v.name.length > 0) : [],
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

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a medical lab report data extractor. Extract blood test values from the provided document and return ONLY valid JSON.

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
1. Extract ACTUAL measured result values ONLY. NEVER extract reference ranges, target values, or normal limits. Reference ranges often appear in parentheses, brackets, a "Reference" column, or after words like "Normal", "Ref", "Range".
2. If the report shows BOTH current AND previous results (side by side or in columns), extract ONLY the most recent values.
3. For the date: use the COLLECTION or SAMPLE date (when blood was drawn), NOT the report date, print date, or received date. Return as ISO format YYYY-MM-DD.
4. For ambiguous date formats (e.g. 03/04/2026): prefer DD/MM/YYYY if the lab address or language suggests non-US origin. Prefer MM/DD/YYYY for US labs. If uncertain, set confidence to "low".
5. For multi-page documents: the collection date may appear on the first page while results are on later pages. Correlate dates and results across all pages.
6. If a value could be a reference range or you are uncertain, set confidence to "low" and include a "question" explaining the ambiguity.
7. Skip any test not in the TARGET METRICS list. Include skipped tests in the "unrecognized" array as "test name: value unit".

RESPONSE FORMAT (strict JSON, no markdown):
{
  "reportDate": "YYYY-MM-DD" or null,
  "values": [
    { "metric": "ldl", "value": 2.8, "unit": "mmol/L", "confidence": "high" },
    { "metric": "hba1c", "value": 5.7, "unit": "%", "confidence": "low", "question": "Both 5.7% and 39 mmol/mol shown — using percentage" }
  ],
  "unrecognized": ["vitamin D: 45 ng/mL", "iron: 80 µg/dL"]
}`;

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

export async function extractLabResults(
  pages: PageContent[],
): Promise<ExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  // Build user message content blocks
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

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  };

  let responseText = await callAnthropic(apiKey, body);

  // Parse + validate
  let parsed: LlmResult;
  try {
    parsed = llmResultSchema.parse(JSON.parse(stripCodeFences(responseText)));
  } catch {
    // Retry once with prefilled assistant turn to force JSON
    const retryBody = {
      ...body,
      messages: [
        { role: 'user', content },
        { role: 'assistant', content: [{ type: 'text', text: '{' }] },
      ],
    };
    responseText = await callAnthropic(apiKey, retryBody);
    parsed = llmResultSchema.parse(JSON.parse('{' + responseText));
  }

  return {
    reportDate: parsed.reportDate,
    values: resolveLabValues(parsed.values),
    unrecognized: parsed.unrecognized || [],
  };
}

// ---------------------------------------------------------------------------
// Unified document processing (classify + extract/convert in one call)
// ---------------------------------------------------------------------------

const DOCUMENT_CLASSIFICATIONS = ['lab_report', ...DOCUMENT_TYPES] as const;

const UNIFIED_SYSTEM_PROMPT = `You are a medical document processor. Classify the document, then process accordingly.

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
  2. If both current AND previous results shown, extract ONLY the most recent values.
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

/** Zod schema for the unified LLM response */
const unifiedResultSchema = z.object({
  classification: z.enum(DOCUMENT_CLASSIFICATIONS),
  reportDate: z.string().nullable(),
  values: z.array(z.object({
    metric: z.string(),
    value: z.number(),
    unit: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    question: z.string().optional(),
  })).default([]),
  additionalValues: z.array(z.object({
    name: z.string().default(''),
    value: z.number(),
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

/**
 * Unified extraction: classifies the document and either extracts lab values
 * or converts to markdown + metadata, in a single LLM call.
 */
export async function extractOrClassify(
  pages: PageContent[],
): Promise<UnifiedExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

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

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192, // Higher limit for markdown conversion
    system: UNIFIED_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  };

  let responseText = await callAnthropic(apiKey, body);

  let parsed: z.infer<typeof unifiedResultSchema>;
  try {
    parsed = unifiedResultSchema.parse(JSON.parse(stripCodeFences(responseText)));
  } catch {
    // Retry once with prefilled assistant turn to force JSON
    const retryBody = {
      ...body,
      messages: [
        { role: 'user', content },
        { role: 'assistant', content: [{ type: 'text', text: '{' }] },
      ],
    };
    responseText = await callAnthropic(apiKey, retryBody);
    parsed = unifiedResultSchema.parse(JSON.parse('{' + responseText));
  }

  return toUnifiedResult(parsed);
}

// ---------------------------------------------------------------------------
// Low-level API call
// ---------------------------------------------------------------------------

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Shared fetch + retry + error handling. Returns text content + usage metrics. */
async function fetchAnthropicRaw(
  apiKey: string, body: Record<string, unknown>, retries = 2,
): Promise<{ content: string; usage: AnthropicUsage }> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  // Retry on rate limit (429) with exponential backoff
  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
    const delay = Math.max(retryAfter * 1000, (3 - retries) * 5_000);
    console.warn(`Anthropic 429 rate limited, retrying in ${delay}ms (${retries} retries left)`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return fetchAnthropicRaw(apiKey, body, retries - 1);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    const err = new Error(`Anthropic API error (status ${response.status})`);
    console.error(err.message, errorText);
    Sentry.captureException(err, { extra: { status: response.status, errorText } });
    throw err;
  }

  const data = await response.json();
  const textBlock = (data.content as Array<{ type: string; text?: string }>)?.find(b => b.type === 'text');
  if (!textBlock?.text) throw new Error('No text in Anthropic response');

  return {
    content: textBlock.text,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      cacheCreationTokens: data.usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

/** Text-only wrapper — existing callers unchanged. */
async function callAnthropic(apiKey: string, body: Record<string, unknown>, retries = 2): Promise<string> {
  const result = await fetchAnthropicRaw(apiKey, body, retries);
  return result.content;
}

/** Text + usage wrapper — for chat (prompt caching metrics). */
export async function callAnthropicWithUsage(
  body: Record<string, unknown>, retries = 2,
): Promise<{ content: string; usage: AnthropicUsage }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  return fetchAnthropicRaw(apiKey, body, retries);
}

/** Strip markdown code fences (```json ... ```) from LLM response text */
/** Exported for testing */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Batch API — processes all files in a single batch request
// ---------------------------------------------------------------------------

interface BatchFileInput {
  fileName: string;
  pages: PageContent[];
}

/** Create a batch of LLM requests — one per file. Returns the batch ID. */
export async function createBatch(
  files: BatchFileInput[],
): Promise<{ batchId: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const requests = files.map((file, index) => {
    const content: Array<Record<string, unknown>> = [];
    for (const page of file.pages) {
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

    return {
      custom_id: `file-${index}`,
      params: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        system: UNIFIED_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      },
    };
  });

  const response = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    const err = new Error(`Batch API error (status ${response.status})`);
    console.error(err.message, errorText);
    Sentry.captureException(err, { extra: { status: response.status, errorText } });
    throw err;
  }

  const data = await response.json();
  return { batchId: data.id };
}

/** Poll batch status. Returns completed count or full results when done. */
export async function pollBatch(
  batchId: string,
): Promise<{
  status: 'processing' | 'ended' | 'failed';
  completed: number;
  total: number;
  results?: UnifiedExtractionResult[];
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  // Check batch status
  const statusResponse = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });

  if (!statusResponse.ok) {
    throw new Error(`Batch status error (${statusResponse.status})`);
  }

  const statusData = await statusResponse.json();
  const ps = statusData.processing_status;
  const completed = (ps.succeeded || 0) + (ps.errored || 0) + (ps.expired || 0) + (ps.canceled || 0);
  const total = completed + (ps.in_progress || 0);

  if (!statusData.ended_at) {
    return { status: 'processing', completed, total };
  }

  // Batch is done — fetch results
  const resultsResponse = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}/results`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });

  if (!resultsResponse.ok) {
    throw new Error(`Batch results error (${resultsResponse.status})`);
  }

  // Parse JSONL — some entries contain literal newlines in markdown content,
  // so we can't simply split by \n. Reassemble split entries by checking for the custom_id prefix.
  const resultsText = await resultsResponse.text();
  const rawLines = resultsText.trim().split('\n');
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line.startsWith('{"custom_id":')) {
      lines.push(line);
    } else if (lines.length > 0) {
      lines[lines.length - 1] += line;
    }
  }

  // Parse each JSONL line and extract results, sorted by custom_id
  const resultMap = new Map<number, UnifiedExtractionResult>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const index = parseInt(entry.custom_id?.replace('file-', ''), 10);
      if (isNaN(index)) continue;

      if (entry.result?.type === 'succeeded') {
        const textBlock = entry.result.message?.content?.find((b: any) => b.type === 'text');
        if (textBlock?.text) {
          try {
            const parsed = unifiedResultSchema.parse(JSON.parse(stripCodeFences(textBlock.text)));
            resultMap.set(index, toUnifiedResult(parsed));
            continue;
          } catch {
            // JSON parse or Zod validation failed
          }
        }
      }

      // Error or failed to parse — store error result
      resultMap.set(index, {
        classification: 'other',
        reportDate: null,
        values: [],
        additionalValues: [],
        unrecognized: [],
        document: null,
      });
    } catch {
      // Skip malformed JSONL lines
    }
  }

  // Sort by index and return
  const results = Array.from(resultMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => r);

  return { status: 'ended', completed, total, results };
}
