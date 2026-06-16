/**
 * Shared chat → form-edit tool schemas + validation.
 *
 * The chatbot can propose edits to the user's health form by emitting Anthropic
 * `tool_use` blocks. The model NEVER computes SI — it emits the user's STATED
 * value plus the STATED unit; conversion to canonical SI happens later in the
 * form/save layer (toCanonicalValue), inheriting every Zod range, FHIR
 * immutability rule, and merge path the manual form already has.
 *
 * This module is the ONE source of truth for the tool definitions + the parser,
 * imported by BOTH the BYOK browser transport (byok-chat.ts) and the server
 * transport (chat.server.ts). Keeping it here means the two surfaces can never
 * drift on the tool name, the field enum, or the unit-resolution rules.
 *
 * Two tools:
 *  - propose_field_edit       — longitudinal measurements (weight, LDL, BP, …).
 *                               Pre-fills the real form cell; the user Saves.
 *  - propose_medication_edit  — medications (statin, ezetimibe, …). These
 *                               auto-save today, so the chat states the change
 *                               + offers Undo.
 */
import { z } from 'zod';
import { UNIT_DEFS, type MetricType, type UnitSystem } from './units';
import { FIELD_TO_METRIC, LONGITUDINAL_FIELDS } from './mappings';
import { MEDICATION_KEYS } from './validation';
import type { HealthInputs } from './types';

// ---------------------------------------------------------------------------
// Field enum — derived from LONGITUDINAL_FIELDS so it can never drift
// ---------------------------------------------------------------------------

/**
 * The HealthInputs fields the chat is allowed to propose edits for. Derived
 * from LONGITUDINAL_FIELDS, minus `psa` — PSA is rendered in a separate men's
 * section, not the blood-test matrix, so the prefill router can't satisfy it.
 * Advertising only routable fields keeps the model's tool enum and the widget's
 * routing capability from drifting (no silent "pre-filled" no-ops).
 */
export const EDITABLE_FIELDS = LONGITUDINAL_FIELDS.filter((f) => f !== 'psa');
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Field → metric type (every editable field is a longitudinal measurement). */
function fieldToMetric(field: string): MetricType | null {
  return (FIELD_TO_METRIC[field] as MetricType | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Unit resolution — map the user's STATED unit string to a UnitSystem
// ---------------------------------------------------------------------------

/** Normalise a unit string for comparison: lowercase, strip spaces + micro sign variants. */
function normaliseUnit(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/µ|μ/g, 'u') // micro sign + Greek mu → 'u' (µmol/L → umol/l)
    .replace(/\s+/g, '');
}

/**
 * Resolve a stated unit string against a metric's two known unit labels (si /
 * conventional). Returns the matching UnitSystem, or null if it matches neither
 * (the model should have ASKED rather than guessed — we reject so we never
 * silently store a wrong-unit value).
 */
export function resolveUnitSystem(metric: MetricType, statedUnit: string): UnitSystem | null {
  const def = UNIT_DEFS[metric];
  const wanted = normaliseUnit(statedUnit);
  if (normaliseUnit(def.label.si) === wanted) return 'si';
  if (normaliseUnit(def.label.conventional) === wanted) return 'conventional';
  return null;
}

// ---------------------------------------------------------------------------
// Anthropic tool definitions (shared by client + server request bodies)
// ---------------------------------------------------------------------------

/**
 * Tool: propose a single longitudinal-measurement edit. The model emits the
 * user's stated value + unit (NEVER SI) + an optional ISO date. Multiple
 * measurements from one lab draw should be emitted as multiple tool_use blocks
 * sharing the same `date` — the widget batches same-date edits into one Save.
 */
export const PROPOSE_FIELD_EDIT_TOOL = {
  name: 'propose_field_edit',
  description:
    "Pre-fill a value into the user's health form for them to review and Save. " +
    'Use this ONLY when the user clearly states a new measurement they want recorded ' +
    "(e.g. \"my LDL was 3.8 mmol/L\", \"set my weight to 80 kg\"). Emit the user's STATED " +
    'value and unit verbatim — do NOT convert units or compute SI. You are NOT saving the ' +
    'value; the user reviews the pre-filled cell and presses Save themselves. If the unit is ' +
    'ambiguous (e.g. cholesterol could be mmol/L or mg/dL) and the user did not state it, ' +
    'ASK them which unit instead of calling this tool.',
  input_schema: {
    type: 'object' as const,
    properties: {
      field: {
        type: 'string' as const,
        enum: [...EDITABLE_FIELDS],
        description: 'Which form field to pre-fill.',
      },
      value: {
        type: 'number' as const,
        description: "The user's stated numeric value, in the unit they stated (NOT converted to SI).",
      },
      unit: {
        type: 'string' as const,
        description:
          "The unit the user stated the value in (e.g. 'mmol/L', 'mg/dL', 'kg', 'lbs', 'cm', " +
          "'in', 'mmHg', '%', 'mmol/mol'). Required — if you don't know it, ASK the user.",
      },
      date: {
        type: 'string' as const,
        description:
          'Optional ISO date (YYYY-MM-DD) the measurement was taken, if the user stated one. ' +
          'Omit for "today".',
      },
    },
    required: ['field', 'value', 'unit'],
  },
} as const;

/**
 * Tool: propose a medication change. Medications auto-save on change today, so
 * the chat applies it immediately and tells the user what changed + offers Undo.
 * `drugName` carries the FHIR drug name OR a status token ('none', 'not_yet',
 * 'not_tolerated', 'yes', 'no', or an enum value like 'ir_1000').
 */
export const PROPOSE_MEDICATION_EDIT_TOOL = {
  name: 'propose_medication_edit',
  description:
    "Update one of the user's medications in their form. Use ONLY when the user clearly states " +
    'a medication change (e.g. "I started atorvastatin 20mg", "set my statin to rosuvastatin 10mg"). ' +
    'Medications save immediately, so after calling this, tell the user exactly what changed and ' +
    'that they can undo it. Do not call this for measurements (use propose_field_edit) or for ' +
    'supplements.',
  input_schema: {
    type: 'object' as const,
    properties: {
      medicationKey: {
        type: 'string' as const,
        enum: [...MEDICATION_KEYS],
        description:
          "Which medication: 'statin', 'ezetimibe', 'pcsk9i', 'bempedoic_acid', 'glp1', " +
          "'sglt2i', 'metformin' (escalation keys are internal — do not set).",
      },
      drugName: {
        type: 'string' as const,
        description:
          "The drug name (e.g. 'atorvastatin', 'rosuvastatin', 'ezetimibe', 'evolocumab', " +
          "'tirzepatide', 'empagliflozin') OR a status token: 'none' (not taking), 'not_yet', " +
          "'not_tolerated', 'yes' (for ezetimibe/pcsk9i when taking), or a metformin/bempedoic " +
          "enum value (e.g. 'ir_1000', 'bempedoic_acid').",
      },
      doseValue: {
        type: 'number' as const,
        description: 'Numeric dose, if the user stated one (e.g. 20 for 20mg). Omit for status tokens.',
      },
      doseUnit: {
        type: 'string' as const,
        description: "Dose unit, usually 'mg'. Omit when no dose.",
      },
    },
    required: ['medicationKey', 'drugName'],
  },
} as const;

/** Both tools, ready to drop into an Anthropic request body's `tools` array. */
export const CHAT_EDIT_TOOLS = [PROPOSE_FIELD_EDIT_TOOL, PROPOSE_MEDICATION_EDIT_TOOL];

/**
 * Shown in the chat thread when the model proposed a form edit but returned no
 * prose. Shared by both transports so the two surfaces can't drift.
 */
export const PREFILL_ACK_MESSAGE =
  "I've pre-filled that in your form — review the highlighted value and press Save.";

// ---------------------------------------------------------------------------
// Parsed-intent shapes — what the widget receives + acts on
// ---------------------------------------------------------------------------

export interface ProposedFieldEdit {
  kind: 'field';
  field: EditableField;
  /** The user's stated value, in their stated unit (NOT SI). */
  displayValue: number;
  /** Resolved unit system for `displayValue` (from the stated unit string). */
  unitSystem: UnitSystem;
  /** ISO date (YYYY-MM-DD), or null for "today". */
  date: string | null;
}

export interface ProposedMedicationEdit {
  kind: 'medication';
  medicationKey: (typeof MEDICATION_KEYS)[number];
  drugName: string;
  doseValue: number | null;
  doseUnit: string | null;
}

export type ProposedEdit = ProposedFieldEdit | ProposedMedicationEdit;

// ---------------------------------------------------------------------------
// Zod validators
// ---------------------------------------------------------------------------

const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;

const rawFieldEditSchema = z.object({
  field: z.enum(EDITABLE_FIELDS as unknown as [EditableField, ...EditableField[]]),
  value: z.number().finite(),
  unit: z.string().min(1),
  date: z.string().regex(isoDateRe).optional().nullable(),
});

const rawMedicationEditSchema = z.object({
  medicationKey: z.enum(MEDICATION_KEYS),
  drugName: z.string().min(1).max(64),
  doseValue: z.number().finite().positive().optional().nullable(),
  doseUnit: z.string().max(16).optional().nullable(),
});

/**
 * Validate + normalise a single tool_use block into a ProposedEdit.
 *
 * Returns null (the edit is dropped, NOT applied) when:
 *  - the tool name is unknown,
 *  - the input fails the Zod shape,
 *  - the field isn't a known measurement metric, or
 *  - the stated unit doesn't match either of the metric's known unit labels
 *    (so we never silently store a wrong-unit value — the model should have
 *    asked instead).
 *
 * Range validation is deliberately NOT done here — the value flows through the
 * real form Save, which runs the canonical Zod range check. A pre-fill of an
 * out-of-range value is allowed; the Save blocks it (consistent with manual entry).
 */
export function parseProposedEdit(toolName: string, rawInput: unknown): ProposedEdit | null {
  if (toolName === PROPOSE_FIELD_EDIT_TOOL.name) {
    const parsed = rawFieldEditSchema.safeParse(rawInput);
    if (!parsed.success) return null;
    const { field, value, unit, date } = parsed.data;
    const metric = fieldToMetric(field);
    if (!metric) return null;
    const unitSystem = resolveUnitSystem(metric, unit);
    if (!unitSystem) return null; // ambiguous / wrong unit — drop rather than guess
    return { kind: 'field', field, displayValue: value, unitSystem, date: date ?? null };
  }

  if (toolName === PROPOSE_MEDICATION_EDIT_TOOL.name) {
    const parsed = rawMedicationEditSchema.safeParse(rawInput);
    if (!parsed.success) return null;
    const { medicationKey, drugName, doseValue, doseUnit } = parsed.data;
    return {
      kind: 'medication',
      medicationKey,
      drugName,
      doseValue: doseValue ?? null,
      doseUnit: doseUnit ?? null,
    };
  }

  return null;
}

/**
 * Parse an array of Anthropic content blocks, returning every valid proposed
 * edit. Non-tool_use blocks and invalid edits are skipped. Order is preserved.
 */
export function parseProposedEdits(
  blocks: Array<{ type: string; name?: string; input?: unknown }>,
): ProposedEdit[] {
  const out: ProposedEdit[] = [];
  for (const b of blocks) {
    if (b.type !== 'tool_use' || !b.name) continue;
    const edit = parseProposedEdit(b.name, b.input);
    if (edit) out.push(edit);
  }
  return out;
}

/** The HealthInputs fields routed through handleInputChange rather than the matrix. */
export const VITALS_INPUT_FIELDS: ReadonlyArray<keyof HealthInputs> = [
  'weightKg', 'waistCm', 'systolicBp', 'diastolicBp',
];
