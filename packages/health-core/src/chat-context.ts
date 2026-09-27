/**
 * The chat's plan context: one builder on each side, so every chat plans
 * from the same rows the widget does (US-15 AC11).
 *
 * `chatContextOf` is what a client sends: the widget, the chatbot embed and
 * the blog bubble all build it here. `buildChatContextJson` turns a payload
 * into the JSON the model reads. The Shopify server runs it on the client's
 * payload, and the Pages BYOK chat runs it on the user's own file.
 *
 * `buildChatContextJson` is the chat's anti-injection boundary. No client
 * text reaches the prompt unless it is allowlisted or bounded:
 *   - profile.sex, profile.heightCm: the input schema (enum; ranged number);
 *     profile.age is computed; profile.unitSystem is 'si' or 'conventional'.
 *   - latestValues: the longitudinal fields that pass the input schema, or
 *     the newest history point, printed from numbers.
 *   - excludedFields: input-schema field names only, never their values.
 *   - measurementHistory: metric keys on METRIC_TO_FIELD, YYYY-MM-DD dates,
 *     values that pass their field's schema, HISTORY_CAP_PER_METRIC points a
 *     metric and HISTORY_CAP_TOTAL in all.
 *   - medications: medicationsToInputs over rows whose key is a MEDICATION_KEY.
 *     A drug name on that key's list (the form's own options) passes; an
 *     empty name drops its key, a non-string name its row (medicationsToInputs
 *     skips it too); any other name is UNLISTED here. A dose is a
 *     finite number in (0, MAX_DOSE] or null. The plan reads an unlisted name
 *     as the widget does, if it is within UNLISTED_NAME, and any other name
 *     as UNLISTED; it reads any finite dose as the widget does. Neither an
 *     unlisted name nor an out-of-range dose appears in this JSON.
 *   - screenings: screeningsToInputs over rows whose key is a SCREENING_KEY;
 *     a number parses whole into its range, and screeningsToInputs keeps a
 *     date only if it is a real calendar date (a "last done" date no later
 *     than this month) and an option only if it is listed, as it does for
 *     the widget's plan.
 *   - currentSuggestions: the plan computed from the above; uploadedDocuments
 *     is always empty.
 * Every other key is dropped.
 */
import type { HealthInputs } from './types';
import {
  STATIN_NAMES, EZETIMIBE_OPTIONS, BEMPEDOIC_ACID_OPTIONS, PCSK9I_OPTIONS,
  GLP1_NAMES, SGLT2I_NAMES, METFORMIN_OPTIONS,
} from './types';
import { UNIT_DEFS, type UnitSystem } from './units';
import {
  healthInputSchema, sanitizeInputs, excludedInputFields, MEDICATION_KEYS, SCREENING_KEYS,
} from './validation';
import {
  LONGITUDINAL_FIELDS, METRIC_TO_FIELD, medicationsToInputs, screeningsToInputs,
  type ApiMedication, type ApiScreening,
} from './mappings';
import {
  buildMeasurementHistory, latestFromHistory, HISTORY_CAP_PER_METRIC, ISO_DATE,
  type MeasurementHistoryMap,
} from './measurement-history';
import { calculateHealthResults } from './calculations';

/** What a client sends as the chat's context. A row carries only the fields
 *  the builder reads: never its id, update time or lamport clock. */
export type ChatContextPayload = Partial<HealthInputs> & {
  unitSystem: UnitSystem;
  medications: Array<Pick<ApiMedication, 'medicationKey' | 'drugName' | 'doseValue'>>;
  screenings: Array<Pick<ApiScreening, 'screeningKey' | 'value'>>;
  /** Dated series per metric; omitted when there is none. */
  measurementHistory?: MeasurementHistoryMap;
};

/**
 * The context every widget-side chat sends: the inputs the plan reads, the
 * unit system, the medications and screenings on record, and the dated
 * history built from `dated` (any rows with a `recordedAt`).
 */
export function chatContextOf(
  inputs: Partial<HealthInputs>,
  unitSystem: UnitSystem,
  medications: ApiMedication[],
  screenings: ApiScreening[],
  dated: Array<{ metricType: string; value: number; recordedAt?: string | null }>,
): ChatContextPayload {
  const measurementHistory = buildMeasurementHistory(dated);
  return {
    ...inputs,
    unitSystem,
    // The mirror is localStorage, so a row may be anything: skip what is not
    // an object, and the builder drops the rest.
    medications: medications.flatMap(m => (m && typeof m === 'object'
      ? [{ medicationKey: m.medicationKey, drugName: m.drugName, doseValue: m.doseValue }] : [])),
    screenings: screenings.flatMap(r => (r && typeof r === 'object' ? [{ screeningKey: r.screeningKey, value: r.value }] : [])),
    ...(Object.keys(measurementHistory).length > 0 ? { measurementHistory } : {}),
  };
}

/**
 * The JSON the model reads for a payload, or null when the payload cannot
 * make a plan (no usable sex and height). See the header for what reaches it.
 */
export function buildChatContextJson(payload: unknown): string | null {
  const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  // Sanitize per field first: one out-of-range number must cost its own field,
  // not collapse the whole context to "no data entered". The snapshot is read
  // from parsed.data, so Zod's key stripping stands between an unknown field
  // and the model.
  const parsed = healthInputSchema.safeParse(sanitizeInputs(raw as Partial<HealthInputs>));
  if (!parsed.success) return null;

  const inputs = parsed.data as HealthInputs;
  const excludedFields = excludedInputFields(raw as Partial<HealthInputs>);
  const unitSystem: UnitSystem = raw.unitSystem === 'conventional' ? 'conventional' : 'si';
  const medicationRowsOnRecord = medicationRows(raw.medications);
  const screenings = screeningsToInputs(screeningRows(raw.screenings));
  const results = calculateHealthResults(inputs, unitSystem, medicationsToInputs(medicationRowsOnRecord), screenings);
  // An unlisted drug name must never reach the prompt, so it reads UNLISTED
  // here, and a dose shows only within (0, MAX_DOSE]. The plan above used the
  // name and dose themselves, which is safe only while no suggestion title
  // carries a drug name: chat-context.test.ts pins that. An empty name is
  // "not answered" to the plan, so the prompt leaves its key out.
  const medications = medicationsToInputs(medicationRowsOnRecord.flatMap(r => (r.drugName === '' ? [] : [
    { ...r, drugName: r.listed ? r.drugName : UNLISTED },
  ])));
  for (const m of [medications.statin, medications.glp1, medications.sglt2i]) {
    if (m?.dose != null && !(m.dose > 0 && m.dose <= MAX_DOSE)) m.dose = null;
  }

  const latestValues: Record<string, string> = {};
  for (const field of LONGITUDINAL_FIELDS) {
    if (inputs[field] !== undefined && inputs[field] !== null) latestValues[field] = `${inputs[field]}`;
  }
  // latestValues are the values the plan above was computed from, so the model
  // explains the plan the person sees: an unsaved value the widget sends stands
  // in for the saved one (US-03 AC6). Every client now builds the snapshot from
  // the latest value by clinical date (US-07 AC4), which is what the old
  // "history wins" override was for. The dated series fills only fields the
  // snapshot lacks, and is sent beside it.
  const measurementHistory = historyOf(raw.measurementHistory);
  const hasHistory = Object.keys(measurementHistory).length > 0;
  for (const [field, value] of Object.entries(latestFromHistory(measurementHistory))) {
    latestValues[field] ??= `${value}`;
  }

  return JSON.stringify({
    profile: { sex: inputs.sex, age: results.age, heightCm: inputs.heightCm, unitSystem },
    latestValues,
    // Field names only: the user HAS a value here, but it was out of range.
    // Without it the model reads the gap as "never entered".
    ...(excludedFields.length > 0 ? { excludedFields } : {}),
    // Chronological per metric; the LAST entry is the most recent, in SI.
    ...(hasHistory ? { measurementHistory } : {}),
    medications,
    screenings,
    currentSuggestions: results.suggestions.map(s => ({
      id: s.id,
      category: s.category,
      priority: s.priority,
      title: s.title,
    })),
    uploadedDocuments: [],
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Row sanitizers
// ---------------------------------------------------------------------------

const values = (options: ReadonlyArray<{ value: string }>) => options.map(o => o.value);
const ESCALATION = ['not_yet', 'not_tolerated'];

/** The drug names each medication slot can hold: the form's own options, plus
 *  the FHIR drug name that ezetimibe and PCSK9i rows carry with a dose. */
const DRUG_NAMES: Record<(typeof MEDICATION_KEYS)[number], ReadonlySet<string>> = {
  statin: new Set(values(STATIN_NAMES)),
  ezetimibe: new Set([...values(EZETIMIBE_OPTIONS), 'ezetimibe']),
  statin_escalation: new Set(ESCALATION),
  pcsk9i: new Set([...values(PCSK9I_OPTIONS), 'pcsk9i']),
  bempedoic_acid: new Set(values(BEMPEDOIC_ACID_OPTIONS)),
  glp1: new Set(values(GLP1_NAMES)),
  glp1_escalation: new Set(ESCALATION),
  sglt2i: new Set(values(SGLT2I_NAMES)),
  metformin: new Set(values(METFORMIN_OPTIONS)),
};

/** Largest dose, in mg, the prompt shows (the form's largest is 180). */
const MAX_DOSE = 1000;

const own = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
const fields = (row: unknown) => (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;

/** An unlisted drug name the plan may read (the chat's medication tool writes
 *  any name): letters, digits, spaces, hyphens, dots and slashes, at most 40
 *  characters. An empty name is "not answered" in both plans. */
const UNLISTED_NAME = /^[A-Za-z0-9 .\/-]{0,40}$/;
/** What the prompt shows for any unlisted name, and what the plan reads for a
 *  name outside UNLISTED_NAME. "other" will not do: it is the listed GLP-1
 *  answer "Other GLP-1", which means "suggest a switch". No option list uses
 *  this token, so it means nothing to the plan, as every unknown name means
 *  nothing to the widget's. */
const UNLISTED = 'unlisted';

type MedicationRow = Pick<ApiMedication, 'medicationKey' | 'drugName' | 'doseValue'> & { listed: boolean };

function medicationRows(raw: unknown): MedicationRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    const { medicationKey, drugName, doseValue } = fields(row);
    if (typeof medicationKey !== 'string' || !own(DRUG_NAMES, medicationKey)) return [];
    // medicationsToInputs skips a name that is not a string, as if no row were
    // recorded, so this row goes too rather than reading as an answered UNLISTED.
    if (typeof drugName !== 'string') return [];
    const listed = DRUG_NAMES[medicationKey as keyof typeof DRUG_NAMES].has(drugName);
    const bounded = UNLISTED_NAME.test(drugName);
    // The widget's plan reads the saved dose as it is, so this one does too.
    const dose = typeof doseValue === 'number' && Number.isFinite(doseValue) ? doseValue : null;
    return [{ medicationKey, drugName: listed || bounded ? drugName : UNLISTED, doseValue: dose, listed }];
  });
}

/** The numeric screenings and their ranges: pack-years as the form bounds
 *  them, PSA as its measurement does. */
const SCREENING_RANGES: Record<string, { min: number; max: number }> = {
  lung_pack_years: { min: 0, max: 200 },
  prostate_psa_value: UNIT_DEFS.psa.validationRange.si,
};
/** Longest screening value: the longest option is 18 characters. */
const MAX_SCREENING_VALUE = 32;

function screeningRows(raw: unknown): Array<Pick<ApiScreening, 'screeningKey' | 'value'>> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    const { screeningKey, value } = fields(row);
    if (typeof screeningKey !== 'string' || !(SCREENING_KEYS as readonly string[]).includes(screeningKey)) return [];
    if (typeof value !== 'string' || value.length > MAX_SCREENING_VALUE) return [];
    const range = own(SCREENING_RANGES, screeningKey) ? SCREENING_RANGES[screeningKey] : null;
    if (range) {
      const n = value.trim() === '' ? NaN : Number(value);
      if (!Number.isFinite(n) || n < range.min || n > range.max) return [];
    }
    return [{ screeningKey, value }];
  });
}

/** Most dated points the chat takes across every metric. */
const HISTORY_CAP_TOTAL = 400;

function historyOf(raw: unknown): MeasurementHistoryMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const shape = healthInputSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
  const out: MeasurementHistoryMap = {};
  let total = 0;
  for (const [metric, series] of Object.entries(raw as Record<string, unknown>)) {
    if (!own(METRIC_TO_FIELD, metric) || !Array.isArray(series)) continue;
    const field = METRIC_TO_FIELD[metric];
    const clean: Array<{ date: string; value: number }> = [];
    for (const entry of series) {
      if (clean.length >= HISTORY_CAP_PER_METRIC || total >= HISTORY_CAP_TOTAL) break;
      const { date, value } = fields(entry);
      if (typeof date === 'string' && ISO_DATE.test(date) && typeof value === 'number' && shape[field].safeParse(value).success) {
        clean.push({ date, value });
        total++;
      }
    }
    if (clean.length > 0) out[metric] = clean;
  }
  return out;
}
