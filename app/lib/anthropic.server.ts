/**
 * Anthropic API wrapper for lab result extraction.
 * System prompt is hardcoded server-side — client sends only content.
 */
import { z } from 'zod';
import * as Sentry from '@sentry/remix';
import { toCanonicalValue, UNIT_DEFS, type MetricType, type UnitSystem } from '../../packages/health-core/src/units';

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
    parsed = llmResultSchema.parse(JSON.parse(responseText));
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

  // Resolve units to SI canonical
  const values: ExtractedValue[] = [];
  for (const v of parsed.values) {
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

  return {
    reportDate: parsed.reportDate,
    values,
    unrecognized: parsed.unrecognized || [],
  };
}

async function callAnthropic(apiKey: string, body: Record<string, unknown>): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    const err = new Error(`Anthropic API error (status ${response.status})`);
    console.error(err.message, errorText);
    Sentry.captureException(err, { extra: { status: response.status } });
    throw err;
  }

  const data = await response.json();
  const textBlock = (data.content as Array<{ type: string; text?: string }>)?.find(b => b.type === 'text');
  if (!textBlock?.text) throw new Error('No text in Anthropic response');

  return textBlock.text;
}
