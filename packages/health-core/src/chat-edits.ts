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
 * Three tools:
 *  - propose_field_edit       — longitudinal measurements (weight, LDL, BP, …).
 *                               Pre-fills the real form cell; the user Saves.
 *  - propose_medication_edit  — medications (statin, ezetimibe, …). These
 *                               auto-save today, so the chat states the change;
 *                               the banner, not the chat, offers any Undo.
 *  - propose_profile_edit     — sex and height (US-16 AC2). The form saves
 *                               these on change, so the widget asks the user
 *                               to confirm before it writes anything.
 */
import * as z from './zod';
import { formatHeightDisplay, lookupUnit, reportedToCanonical, type MetricType, type UnitSystem } from './units';
import { FIELD_TO_METRIC, LONGITUDINAL_FIELDS } from './mappings';
import { ESCALATION_KEY_OF, MEDICATION_KEYS, sanitizeInputs, UNANSWERED_OF } from './validation';
import { escalationOptions } from './input-form';
import {
  BEMPEDOIC_ACID_OPTIONS, EZETIMIBE_OPTIONS, GLP1_NAMES, METFORMIN_OPTIONS, PCSK9I_OPTIONS, SGLT2I_NAMES, STATIN_NAMES,
  type HealthInputs,
} from './types';

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
// Medication answers (US-16 AC3)
// ---------------------------------------------------------------------------

type MedicationKey = (typeof MEDICATION_KEYS)[number];

/** Each medication question's own answers, as its form saves them, with the form's words. */
export const MEDICATION_ANSWERS: Record<MedicationKey, ReadonlyArray<{ value: string; label: string }>> = {
  statin: STATIN_NAMES, ezetimibe: EZETIMIBE_OPTIONS, statin_escalation: escalationOptions(null), pcsk9i: PCSK9I_OPTIONS,
  bempedoic_acid: BEMPEDOIC_ACID_OPTIONS, glp1: GLP1_NAMES, glp1_escalation: escalationOptions(null), sglt2i: SGLT2I_NAMES,
  metformin: METFORMIN_OPTIONS,
};
/** The drug names a drug question takes that the form does not list (Brad 2026-11-02): drug-shaped by the class's
 *  stems (-vastatin; -glutide, -enatide and the named GLP-1 agonists; -gliflozin), or a known brand. Bare "semaglutide" is asked about: injection or tablet. */
const UNLISTED_DRUG = new Map<string, { shape: RegExp; brands: ReadonlySet<string> }>([
  ['statin', { shape: /^[a-z]+vastatin$/, brands: new Set() }],
  ['glp1', {
    shape: /^(?!semaglutide$)([a-z]+(glutide|enatide)|tirzepatide|retatrutide|survodutide|mazdutide|orforglipron)$/,
    brands: new Set(['victoza', 'saxenda', 'byetta', 'bydureon']),
  }],
  ['sglt2i', { shape: /^[a-z]+gliflozin$/, brands: new Set(['steglatro']) }],
]);
const YES = (names: string[]) => names.map((n): [string, string] => [n, 'yes']);
/** A listed statin's brand is its listed generic (map to the user's data, 2026-11-02). */
const STATIN_BRANDS: Array<[string, string]> = ([
  ['lipitor', 'atorvastatin'], ['crestor', 'rosuvastatin'], ['zocor', 'simvastatin'], ['pravachol', 'pravastatin'], ['livalo', 'pitavastatin'],
] as Array<[string, string]>).filter(([, generic]) => STATIN_NAMES.some((o) => o.value === generic));
/** An answer as a token: trimmed, lower case, no apostrophes, runs of spaces or hyphens as '_' ("Not yet" is not_yet). */
const tokenOf = (text: string) => text.trim().toLowerCase().replace(/['\u2019]/g, '').replace(/[\s-]+/g, '_');
/** The brands an option's own label names, each to the option's value: the single words in its parentheses
 *  ("Semaglutide injection (Ozempic/Wegovy)") and a one-word name before them ("Nexletol (bempedoic acid
 *  180mg)"), never a word of the value itself (US-16 AC3, review R2). */
const brandsOf = ({ value, label }: { value: string; label: string }): Array<[string, string]> => {
  const paren = /^(.*?) \((.*)\)$/.exec(label);
  if (!paren) return [];
  return [paren[1], ...paren[2].split('/')].filter((w) => /^[A-Za-z]+$/.test(w))
    .map((w) => w.toLowerCase()).filter((w) => !value.split('_').includes(w)).map((w) => [w, value]);
};
/** The user's words that mean one of the question's own answers (Brad 2026-11-02): an option's own label
 *  ("Other GLP-1"); "not taking" ezetimibe or a PCSK9 inhibitor is "no"; "not yet" a drug is its "haven't tried
 *  yet" ('none'); the drug's own name is "yes"; a brand its option's label names, or a listed statin's brand,
 *  is that option. */
const SAME_ANSWER = new Map(MEDICATION_KEYS.map((key) => [key, new Map<string, string>([
  ...MEDICATION_ANSWERS[key].map((o): [string, string] => [tokenOf(o.label), o.value]),
  ...MEDICATION_ANSWERS[key].flatMap(brandsOf),
  ...(key === 'ezetimibe' || key === 'pcsk9i' ? [['none', 'no'], ['not_taking', 'no'], ...YES([key])] as Array<[string, string]> : []),
  ...(key === 'pcsk9i' ? YES(['evolocumab', 'alirocumab', 'inclisiran', 'repatha', 'praluent', 'leqvio']) : []),
  ...(key === 'statin' ? STATIN_BRANDS : []),
  ...(UNLISTED_DRUG.has(key) || key === 'metformin' ? [['not_yet', 'none']] as Array<[string, string]> : []),
])]));
/** A trailing dose in the answer ("Atorvastatin 40mg"). */
const TRAILING_DOSE = /\s*(\d+(?:\.\d+)?)\s*mg$/i;

/** What a chat answer saves as, with any dose stated after the name, or null when it is none of the question's
 *  answers (the model must ask). */
function savedAnswer(key: MedicationKey, drugName: string): { drugName: string; dose: number | null } | null {
  const answer = (stated: string): string | undefined => {
    const token = tokenOf(stated);
    const unlisted = UNLISTED_DRUG.get(key);
    const lower = stated.trim().toLowerCase();
    return SAME_ANSWER.get(key)?.get(token) ?? MEDICATION_ANSWERS[key].find((o) => o.value === token)?.value
      ?? (unlisted && (unlisted.shape.test(lower) || unlisted.brands.has(lower)) ? stated.trim() : undefined);
  };
  const whole = answer(drugName);
  if (whole) return { drugName: whole, dose: null };
  const dosed = TRAILING_DOSE.exec(drugName.trim());
  const named = dosed ? answer(drugName.trim().slice(0, dosed.index)) : undefined;
  const dose = dosed ? Number(dosed[1]) : 0;
  return named ? { drugName: named, dose: dose > 0 ? dose : null } : null;
}

/** "'not_yet' (Haven't tried yet), 'yes' (Yes), …": a question's answers for the model. */
function answersText(key: MedicationKey): string {
  const listed = MEDICATION_ANSWERS[key].map((o) => `'${o.value}' (${o.label})`).join(', ');
  return UNLISTED_DRUG.has(key) ? `${listed}, or another drug's generic name` : listed;
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
    'ASK them which unit instead of calling this tool. If a value looks implausible for its unit (e.g. ' +
    'LDL 3.4 mg/dL, which reads like mmol/L), ASK the user to confirm the value and unit instead of calling this tool.',
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
 * the chat applies it immediately and tells the user what changed. Its words never
 * promise an Undo: only the client knows whether it can offer one (US-67 N3).
 * `drugName` is one of the key's own answers, listed per key (US-16 AC3).
 */
export const PROPOSE_MEDICATION_EDIT_TOOL = {
  name: 'propose_medication_edit',
  description:
    "Update one of the user's medications in their form. Use ONLY when the user clearly states " +
    'a medication change (e.g. "I started atorvastatin 20mg", "set my statin to rosuvastatin 10mg"). ' +
    'Medications save immediately, so after calling this, tell the user exactly what changed. Do ' +
    'not offer an Undo yourself; if asked, say the banner shows Undo when one is available. Do not call this for measurements (use propose_field_edit) or for ' +
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
          "The answer, exactly one of the medication's own: " +
          MEDICATION_KEYS.map((key) => `${key}: ${answersText(key)}`).join('; ') +
          '. If the user\'s words fit none of them, ASK which applies instead of calling this tool.',
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

/**
 * Tool: propose saving the user's sex and/or height (US-16 AC2). Nothing is
 * saved until the user confirms it in the roadmap tool. Height is the stated
 * number in cm or in (feet and inches as total inches), never converted by
 * the model.
 */
export const PROPOSE_PROFILE_EDIT_TOOL = {
  name: 'propose_profile_edit',
  description:
    "Propose saving the user's own sex and/or height to their roadmap profile. Use it ONLY when the user " +
    "clearly states their own sex or height (e.g. \"I'm a 52 year old man, 178 cm\"), not a family member's. " +
    'Pass the height exactly as stated, in cm or in (feet and inches as total inches: 5 ft 10 in is 70 in); ' +
    'do NOT convert. You are NOT saving it: the user confirms it in the roadmap tool before anything is ' +
    'saved, so say you have proposed it and ask them to confirm.',
  input_schema: {
    type: 'object' as const,
    properties: {
      sex: { type: 'string' as const, enum: ['male', 'female'], description: 'Only if the user stated it.' },
      height: {
        type: 'object' as const,
        description: 'Only if the user stated it.',
        properties: { value: { type: 'number' as const }, unit: { type: 'string' as const, enum: ['cm', 'in'] } },
        required: ['value', 'unit'],
      },
    },
  },
} as const;

/** The form tools, ready to drop into an Anthropic request body's `tools` array. */
export const CHAT_EDIT_TOOLS = [PROPOSE_FIELD_EDIT_TOOL, PROPOSE_MEDICATION_EDIT_TOOL, PROPOSE_PROFILE_EDIT_TOOL];

/**
 * The iPhone app's form tools (US-67 AC3): the app has no form cell to
 * pre-fill, so a value and a profile edit show in a banner with Save and Not
 * now. Only the words differ; a medication saves at once, as on the
 * web. Its own tool list, so its own cache prefix; the web's text is unchanged.
 */
export const APP_CHAT_EDIT_TOOLS = [
  {
    ...PROPOSE_FIELD_EDIT_TOOL,
    description:
      'Show a value in the app for the user to review and Save. ' +
      'Use this ONLY when the user clearly states a new measurement they want recorded ' +
      "(e.g. \"my LDL was 3.8 mmol/L\", \"set my weight to 80 kg\"). Emit the user's STATED " +
      'value and unit verbatim — do NOT convert units or compute SI. You are NOT saving the ' +
      'value: the app shows it in a banner and nothing is saved until the user presses Save, so say ' +
      'it is ready to save, never that it is saved. If the unit is ' +
      'ambiguous (e.g. cholesterol could be mmol/L or mg/dL) and the user did not state it, ' +
      'ASK them which unit instead of calling this tool. If a value looks implausible for its unit (e.g. ' +
      'LDL 3.4 mg/dL, which reads like mmol/L), ASK the user to confirm the value and unit instead of calling this tool.',
  },
  PROPOSE_MEDICATION_EDIT_TOOL,
  {
    ...PROPOSE_PROFILE_EDIT_TOOL,
    description:
      "Propose saving the user's own sex and/or height to their roadmap profile. Use it ONLY when the user " +
      "clearly states their own sex or height (e.g. \"I'm a 52 year old man, 178 cm\"), not a family member's. " +
      'Pass the height exactly as stated, in cm or in (feet and inches as total inches: 5 ft 10 in is 70 in); ' +
      'do NOT convert. You are NOT saving it: the user confirms it in the app, and nothing is saved until ' +
      'they press Save there, so say you have proposed it and ask them to confirm.',
  },
];

/**
 * Shown in the chat thread when the model proposed a form edit but returned no
 * prose. Shared by both transports so the two surfaces can't drift. A
 * measurement waits for Save; a medication saves at once, and no line promises an Undo (US-67 N3);
 * a profile change waits for its own banner's Save, so a mixed turn says so
 * too (US-16 AC2b). `app`: the iPhone app's words (US-67 AC3), which has a Save
 * banner, not a form. `refused`: medication answers not saved, as their question
 * does not offer them (US-16 AC3), which the line names and asks about.
 */
export function toolOnlyAck(edits: ProposedEdit[], app = false, refused = 0): string {
  const refusal = refused === 0 ? ''
    : refused === 1 ? 'One medication change was not saved, as its answer is not one of the listed answers. Tell me which one applies, or choose it yourself.'
    : `${refused} medication changes were not saved, as their answers are not among the listed answers. Tell me which ones apply, or choose them yourself.`;
  if (edits.length === 0) return refusal;
  return refusal ? `${editsAck(edits, app)} ${refusal}` : editsAck(edits, app);
}

/** The line for the edits that were sent. */
function editsAck(edits: ProposedEdit[], app: boolean): string {
  const others = edits.filter((e) => e.kind !== 'profile');
  if (others.length === edits.length) return formAck(edits, app);
  return others.length === 0
    ? 'Please check the details shown and press Save to add them to your profile.'
    : `${formAck(others, app)} Please check the profile details shown and press Save to add them to your profile.`;
}

/** The line for measurement and medication edits. */
function formAck(edits: ProposedEdit[], app: boolean): string {
  const fields = edits.some((e) => e.kind === 'field');
  const meds = edits.some((e) => e.kind === 'medication');
  if (meds && !fields) return "Done — I've updated your medications.";
  if (app) {
    return meds
      ? "I've updated your medications and put the rest ready to save — check it and press Save."
      : "I've put that ready to save — check it and press Save.";
  }
  if (meds) return "I've updated your medications and pre-filled your form — review the highlighted value and press Save.";
  return "I've pre-filled that in your form — review the highlighted value and press Save.";
}

// ---------------------------------------------------------------------------
// Parsed-intent shapes — what the widget receives + acts on
// ---------------------------------------------------------------------------

export interface ProposedFieldEdit {
  kind: 'field';
  field: EditableField;
  /** The user's stated value, in `unitSystem`'s own label (NOT SI): a scaled
   *  print such as Lp(a) in mg/L arrives rescaled to mg/dL. */
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

/** Sex and/or height to save to the profile once the user confirms (US-16 AC2).
 *  Height is canonical cm, converted by the parser from the stated unit. */
export interface ProposedProfileEdit {
  kind: 'profile';
  sex: 'male' | 'female' | null;
  heightCm: number | null;
}

export type ProposedEdit = ProposedFieldEdit | ProposedMedicationEdit | ProposedProfileEdit;

// ---------------------------------------------------------------------------
// Zod validators
// ---------------------------------------------------------------------------

const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;

const rawFieldEditSchema = z.object({
  field: z.enum(EDITABLE_FIELDS as unknown as [EditableField, ...EditableField[]]),
  value: z.number(),
  unit: z.string().min(1),
  date: z.string().regex(isoDateRe).optional().nullable(),
});

// An empty drugName is a misfit to ask about (US-16 AC3), not a shape to drop.
const rawMedicationEditSchema = z.object({
  medicationKey: z.enum(MEDICATION_KEYS),
  drugName: z.string().max(64),
  doseValue: z.number().positive().optional().nullable(),
  doseUnit: z.string().max(16).optional().nullable(),
});

// A null field is absent (the model may send `sex: null`); an unknown key, at
// either level, refuses the whole edit.
const rawProfileEditSchema = z.object({
  sex: z.enum(['male', 'female']).nullish(),
  height: z.object({ value: z.number(), unit: z.enum(['cm', 'in']) }).strict().nullish(),
}).strict();

/**
 * Validate + normalise a single tool_use block into a ProposedEdit.
 *
 * Returns null (the edit is dropped, NOT applied) when:
 *  - the tool name is unknown,
 *  - the input fails the Zod shape,
 *  - the field isn't a known measurement metric, or
 *  - the stated unit is not one the unit table (`lookupUnit`) knows for the metric
 *    (so we never silently store a wrong-unit value — the model should have
 *    asked instead), or
 *  - a medication's answer is none of its question's (`medicationAnswerMisfit`
 *    tells the model to ask). One the user's words mean saves as that answer.
 *
 * Range validation is deliberately NOT done here for measurements — the value
 * flows through the real form Save, which runs the canonical Zod range check. A
 * pre-fill of an out-of-range value is allowed; the Save blocks it (consistent
 * with manual entry). A profile edit has no such Save (the form writes sex and
 * height on change), so its height is held to the schema's range here, and an
 * out-of-range height, an unknown sex or an unknown key drops the whole edit.
 */
export function parseProposedEdit(toolName: string, rawInput: unknown): ProposedEdit | null {
  if (toolName === PROPOSE_FIELD_EDIT_TOOL.name) {
    const parsed = rawFieldEditSchema.safeParse(rawInput);
    if (!parsed.success) return null;
    const { field, value, unit, date } = parsed.data;
    const metric = fieldToMetric(field);
    if (!metric) return null;
    const alias = lookupUnit(metric, unit);
    if (!alias) return null; // ambiguous / wrong unit — drop rather than guess
    return { kind: 'field', field, displayValue: value * (alias.scale ?? 1), unitSystem: alias.system, date: date ?? null };
  }

  if (toolName === PROPOSE_MEDICATION_EDIT_TOOL.name) {
    const parsed = rawMedicationEditSchema.safeParse(rawInput);
    if (!parsed.success) return null;
    const { medicationKey, doseValue, doseUnit } = parsed.data;
    const answer = savedAnswer(medicationKey, parsed.data.drugName);
    if (answer === null) return null;
    // A dose stated after the name is the dose, unless the model gave one.
    const statedDose = doseValue == null ? answer.dose : null;
    return {
      kind: 'medication',
      medicationKey,
      drugName: answer.drugName,
      doseValue: doseValue ?? statedDose,
      doseUnit: doseUnit ?? (statedDose !== null ? 'mg' : null),
    };
  }

  if (toolName === PROPOSE_PROFILE_EDIT_TOOL.name) {
    const parsed = rawProfileEditSchema.safeParse(rawInput);
    if (!parsed.success) return null;
    const { sex, height } = parsed.data;
    const heightCm = height ? reportedToCanonical('height', height.value, height.unit)?.valueSI : undefined;
    if (height && !(heightCm !== undefined && 'heightCm' in sanitizeInputs({ heightCm }))) return null;
    if (!sex && heightCm === undefined) return null;
    return { kind: 'profile', sex: sex ?? null, heightCm: heightCm ?? null };
  }

  return null;
}

/** The tool_result for a medication edit whose answer is none of its question's (US-16 AC3): not saved, ask
 *  the user. Null for any other edit, including one whose shape fails (it is dropped as before). */
export function medicationAnswerMisfit(toolName: string, rawInput: unknown): string | null {
  if (toolName !== PROPOSE_MEDICATION_EDIT_TOOL.name) return null;
  const parsed = rawMedicationEditSchema.safeParse(rawInput);
  if (!parsed.success) return null;
  const { medicationKey, drugName } = parsed.data;
  if (savedAnswer(medicationKey, drugName) !== null) return null;
  return `Not saved: "${drugName}" is not an answer to the ${medicationKey} question. Ask the user which of these applies, ` +
    `then propose it again with that answer: ${answersText(medicationKey)}.`;
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

// ---------------------------------------------------------------------------
// Applying a reply's edits: the rules the web widget and the iPhone engine share
// ---------------------------------------------------------------------------

/** A medication row as the chat's change and its Undo read it. */
export interface ChatMedicationRow {
  medicationKey: string;
  drugName: string;
  doseValue: number | null;
  doseUnit: string | null;
}

/**
 * One chat medication edit against the saved rows (US-06 AC12). `undo`: every
 * row the change writes, as it was before, in the order Undo writes them; a
 * key with no row goes back to its unanswered value ('none' would read as an
 * answer for a step such as ezetimibe or an escalation). `reset`: the drug's
 * escalation key when a new drug or dose resets its answer, as the form does,
 * else null. The answer is about the old drug, so it is reset unless the same
 * reply states it (`stated`: every key the reply names). The web also passes
 * `onForm`, the form's unsaved row for the key; the caller writes the reset
 * ('not_yet') when `undo` holds the saved answer, the web form holds one
 * not yet saved, or the record holds one this build cannot read (US-67 N3:
 * both clients then save the same record, with no Undo).
 */
export function chatMedicationChange(
  edit: ProposedMedicationEdit,
  saved: readonly ChatMedicationRow[],
  stated: ReadonlySet<string>,
  onForm?: { drugName: string; doseValue: number | null },
): { undo: ChatMedicationRow[]; reset: string | null } {
  const prior = saved.find(m => m.medicationKey === edit.medicationKey);
  const undo: ChatMedicationRow[] = [{
    medicationKey: edit.medicationKey,
    drugName: prior?.drugName ?? UNANSWERED_OF[edit.medicationKey],
    doseValue: prior?.doseValue ?? null,
    doseUnit: prior?.doseUnit ?? null,
  }];
  const escalationKey = (ESCALATION_KEY_OF as Partial<Record<string, string>>)[edit.medicationKey];
  const changes = (row: { drugName: string; doseValue: number | null } | undefined) =>
    !!row && (edit.drugName !== row.drugName || edit.doseValue !== row.doseValue);
  if (!escalationKey || stated.has(escalationKey) || !(changes(undo[0]) || changes(onForm))) return { undo, reset: null };
  const answer = saved.find(m => m.medicationKey === escalationKey && m.drugName !== 'not_yet');
  if (answer) undo.unshift({ medicationKey: answer.medicationKey, drugName: answer.drugName, doseValue: answer.doseValue, doseUnit: answer.doseUnit });
  return { undo, reset: escalationKey };
}

/** The fields of a profile proposal the profile does not already hold, as the
 *  user sees them in `units`; null when none, so no banner (US-16 AC2). */
export function unsavedProfile(
  p: ProposedProfileEdit,
  saved: { sex?: string | null; heightCm?: number | null },
  units: UnitSystem,
): ProposedProfileEdit | null {
  const sex = p.sex !== saved.sex ? p.sex : null;
  const heightCm = p.heightCm !== null && (saved.heightCm == null
    || formatHeightDisplay(saved.heightCm, units) !== formatHeightDisplay(p.heightCm, units)) ? p.heightCm : null;
  return sex || heightCm !== null ? { kind: 'profile', sex, heightCm } : null;
}

const receivedEdit = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('field'),
    field: z.enum(EDITABLE_FIELDS as unknown as [EditableField, ...EditableField[]]),
    displayValue: z.number().finite(),
    unitSystem: z.enum(['si', 'conventional']),
    date: z.string().regex(isoDateRe).nullable(),
  }),
  z.object({
    kind: z.literal('medication'),
    medicationKey: z.enum(MEDICATION_KEYS),
    drugName: z.string().min(1).max(64),
    doseValue: z.number().positive().finite().nullable(),
    doseUnit: z.string().max(16).nullable(),
  }),
  z.object({
    kind: z.literal('profile'),
    sex: z.enum(['male', 'female']).nullable(),
    heightCm: z.number().finite().nullable(),
  }).refine(p => p.sex !== null || p.heightCm !== null),
]);
const KINDS: readonly string[] = ['field', 'medication', 'profile'];

/**
 * A reply's `proposedEdits` as a client receives them, read again (US-67 AC2):
 * from the network, so untrusted. An entry of a kind this build does not know
 * is left out (a newer server's); an entry of a known kind that is not its
 * shape, or a list that is not one, is `invalid` and the caller refuses.
 */
export function readProposedEdits(raw: unknown): { edits: ProposedEdit[]; invalid: Array<ProposedEdit['kind'] | 'list'> } {
  if (!Array.isArray(raw)) return { edits: [], invalid: ['list'] };
  const edits: ProposedEdit[] = [];
  const invalid: Array<ProposedEdit['kind']> = [];
  for (const entry of raw) {
    const kind = entry && typeof entry === 'object' ? (entry as { kind?: unknown }).kind : undefined;
    if (typeof kind !== 'string' || !KINDS.includes(kind)) continue;
    const parsed = receivedEdit.safeParse(entry);
    if (parsed.success) edits.push(parsed.data as ProposedEdit);
    else invalid.push(kind as ProposedEdit['kind']);
  }
  return { edits, invalid };
}
