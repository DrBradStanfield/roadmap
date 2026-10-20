/**
 * US-15 AC33: the chat runs the roadmap's own plan code on values the user
 * types into the message, and answers from what it computes.
 *
 * `run_roadmap` overlays the stated values on the request's context payload
 * (the same `guestInputs` the chat already receives) and returns exactly
 * `buildChatContextJson`'s output for the result, so the tool's answer passes
 * the same anti-injection boundary as the prompt's user data block. Nothing is
 * saved: a stated value stands in for the saved one for this answer only.
 * Saving stays the user's job (propose_field_edit pre-fills, they press Save;
 * propose_profile_edit asks them to confirm a sex or height, US-16 AC2).
 *
 * `withRoadmapRound` is the bounded loop every transport shares (the website
 * chat, the Pages BYOK chat and the answer-check harness): at most one
 * run_roadmap round, every tool_use answered, the first reply replayed
 * unmodified (thinking signatures included), and no tools on the second call.
 */
import { z } from 'zod';
import type { HealthInputs } from './types';
import { reportedToCanonical, UNIT_SWAP_FLOORS, type MetricType, type UnitSystem } from './units';
import { FIELD_TO_METRIC } from './mappings';
import { healthInputSchema, sanitizeInputs } from './validation';
import { ISO_DATE } from './measurement-history';
import { latestDayOnEarth } from './merge';
import { resolveRecordedAt } from './record-edits';
import { knownMinorOf } from './calculations';
import { buildChatContextJson } from './chat-context';
import {
  CHAT_EDIT_TOOLS, EDITABLE_FIELDS, PROPOSE_PROFILE_EDIT_TOOL, parseProposedEdit, parseProposedEdits,
  type EditableField, type ProposedEdit,
} from './chat-edits';

/** Most stated values one turn reads; the rest are rejected. */
export const RUN_ROADMAP_MAX_VALUES = 20;

export const RUN_ROADMAP_TOOL = {
  name: 'run_roadmap',
  description:
    "Run the Health Roadmap's own plan code on the user's saved data plus values they state in this " +
    'conversation, and get back the plan it computes (the same JSON as the user data block). Call it when ' +
    'the user states values that are not in their saved data and wants them assessed or analysed (e.g. ' +
    '"analyse my data: LDL 4.1 mmol/L, BP 132/84"). Use only the user\'s own values, not a family member\'s. ' +
    'Pass exactly the stated values and units: do NOT convert ' +
    'units. Give sex, height or age (whole years; a birth year only if that is what they said) only when the user stated ' +
    'them in this conversation; height in cm or in ' +
    '(feet and inches as total inches: 5 ft 5 in is 65 in). If a unit is ' +
    'ambiguous and the user did not state it, ASK which unit instead of calling this tool, and do not grade the ' +
    'value in any unit. Answer only from the result, as you would from the user data block: never grade a value ' +
    'yourself. Tell the user the values are not saved, and offer to pre-fill the measurements with propose_field_edit ' +
    'and to save a stated sex or height with propose_profile_edit (or they can enter them in the roadmap tool).',
  input_schema: {
    type: 'object' as const,
    properties: {
      values: {
        type: 'array' as const,
        maxItems: RUN_ROADMAP_MAX_VALUES,
        items: {
          type: 'object' as const,
          properties: {
            field: { type: 'string' as const, enum: [...EDITABLE_FIELDS] },
            value: { type: 'number' as const, description: 'The stated number, in the stated unit.' },
            unit: { type: 'string' as const, description: "The stated unit (e.g. 'mmol/L', 'mg/dL', 'mmHg', '%', 'kg')." },
            date: { type: 'string' as const, description: 'Optional YYYY-MM-DD the measurement was taken.' },
          },
          required: ['field', 'value', 'unit'],
        },
      },
      sex: { type: 'string' as const, enum: ['male', 'female'], description: 'Only if the user stated it.' },
      height: {
        type: 'object' as const,
        description: 'Only if the user stated it.',
        properties: { value: { type: 'number' as const }, unit: { type: 'string' as const, enum: ['cm', 'in'] } },
        required: ['value', 'unit'],
      },
      age: { type: 'integer' as const, description: 'Only if the user stated it: their age in whole years.' },
      birthYear: { type: 'integer' as const, description: 'Only if the user stated their birth year and not their age. Do not compute it from an age.' },
    },
    required: ['values'],
  },
} as const;

/** The website widget's and the Pages chat's tools: the form tools plus run_roadmap. */
export const CHAT_TOOLS = [...CHAT_EDIT_TOOLS, RUN_ROADMAP_TOOL];

/**
 * The website widget's and the Pages chat's tools for one turn: run_roadmap
 * only when the latest or the previous user message has a digit, since it
 * runs only on stated values ("Lp(a) 75", the unit asked, then "nmol/L"); the
 * form tools always. Tools render before the system prompt, so the two shapes
 * cache separately. `profileEdits` false leaves out propose_profile_edit, for
 * a widget built before it (US-16 AC2), which would apply its edit as a
 * medication.
 */
export function chatToolsFor(messages: readonly ChatTurnMessage[], profileEdits = true) {
  const said = messages.filter(m => m.role === 'user' && typeof m.content === 'string').slice(-2);
  const tools = said.some(m => /\d/.test(m.content as string)) ? CHAT_TOOLS : CHAT_EDIT_TOOLS;
  return profileEdits ? tools : tools.filter(t => t !== PROPOSE_PROFILE_EDIT_TOOL);
}

export interface RoadmapRun {
  /** buildChatContextJson's output for the overlaid payload; null when it makes no plan. */
  contextJson: string | null;
  /** Field names the plan read from the message. */
  applied: string[];
  /** Field names (or 'values' / 'unknown') and a fixed reason. Never a value. */
  rejected: Array<{ field: string; reason: string }>;
}

const REASONS = {
  field: 'not a field the roadmap reads',
  shape: 'value or unit missing or not a number',
  unit: 'unit not recognised for this field: ask the user which unit',
  bpAbove: 'above the highest blood pressure the roadmap records: treat it as a possible emergency and advise urgent medical care',
  bpBelow: 'below the lowest blood pressure the roadmap records: treat it as possibly dangerous and advise urgent medical care if they feel faint, dizzy or unwell',
  labAbove: 'above the highest value the roadmap records in this unit: ask the user to confirm the value and unit; if it is right, suggest they discuss it with their doctor',
  labBelow: 'below the lowest value the roadmap records: ask the user to confirm the value and unit',
  body: 'outside what the roadmap records: ask the user to check the value and unit',
  range: 'out of range for this field',
  date: 'not a real date, or a date in the future',
  older: 'older than the saved value',
  cap: `only the first ${RUN_ROADMAP_MAX_VALUES} values were used`,
  later: 'a later value for the same field was used',
  superseded: 'a later or same-day value for this field could not be used, so this one was not used either',
  pair: 'blood pressure is read as a pair: both numbers are needed, each one usable, so neither was used',
  minor: 'the saved profile is under 18: a stated age or birth year is not used',
  protein: 'the protein target depends on kidney function, which this run could not work out, so it is left out until the refused value is confirmed',
  proteinAge: 'the protein target depends on kidney function, which needs the user\'s age: ask for their age',
} as const;

const BP_FIELDS: readonly string[] = ['systolicBp', 'diastolicBp'];
const BODY_FIELDS: readonly string[] = ['weightKg', 'waistCm', 'heightCm'];
/** HbA1c and creatinine under 20 in their SI unit (mmol/mol, µmol/L): likely a % or mg/dL number under the SI label. */
const SI_ASK_UNIT_BELOW: Partial<Record<MetricType, number>> = { hba1c: 20, creatinine: 20 };
/** A converted value that is a unit to ask about, not a result: under US-36 AC4's floors, or in the SI band above. */
const askUnit = (metric: MetricType, r: { valueSI: number; system: UnitSystem }) =>
  r.valueSI < (UNIT_SWAP_FLOORS[metric] ?? -Infinity) || (r.system === 'si' && r.valueSI < (SI_ASK_UNIT_BELOW[metric] ?? -Infinity));
/** The day of a value whose date could not be read: later than any real day, so it outdates every stated value. */
const UNKNOWN_DAY = '9999-12-31';
const measured = z.object({ value: z.number().finite(), unit: z.string().min(1).max(32) });
/** A number, or a numeric string read as one (a model may send "16" for an integer field); NaN otherwise. */
const numeric = (v: unknown) =>
  typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
/** A field the schema knows: the result never names the model's own string. */
const isEditable = (f: unknown): f is EditableField => typeof f === 'string' && (EDITABLE_FIELDS as readonly string[]).includes(f);
/** A value the input schema accepts for `field`: sanitizeInputs drops anything out of range. */
const inRange = (field: string, value: unknown) => field in sanitizeInputs({ [field]: value } as Partial<HealthInputs>);
/** Why an SI value is out of its field's range, by kind of field and direction; null when it is in range. */
function outOfRange(field: string, si: number): string | null {
  if (inRange(field, si)) return null;
  if (BODY_FIELDS.includes(field)) return REASONS.body;
  const schema = (healthInputSchema.shape as Record<string, z.ZodTypeAny>)[field];
  const max = (schema instanceof z.ZodOptional ? schema.unwrap() : schema) as z.ZodNumber;
  const above = si > (max.maxValue ?? Infinity);
  if (BP_FIELDS.includes(field)) return above ? REASONS.bpAbove : REASONS.bpBelow;
  return above ? REASONS.labAbove : REASONS.labBelow;
}
/** A stated date as a real calendar day no later than today anywhere on Earth (record-edits' rule), or null. */
function statedDay(date: unknown, now: Date): string | null {
  if (typeof date !== 'string' || !ISO_DATE.test(date)) return null;
  const day = resolveRecordedAt(date, { now: now.toISOString(), latestDay: latestDayOnEarth(now) });
  return typeof day === 'string' ? day : null;
}
/** The newest saved day for a metric's dated series ('' when none), ignoring days not yet reached. */
function savedLatestDay(history: Record<string, unknown>, metric: string, today: string): string {
  const series = Object.prototype.hasOwnProperty.call(history, metric) ? history[metric] : null;
  if (!Array.isArray(series)) return '';
  return series.reduce<string>((max, p) => {
    const d = obj(p).date;
    return typeof d === 'string' && ISO_DATE.test(d) && d <= today && d > max ? d : max;
  }, '');
}

/**
 * The plan for `guestInputs` with the stated values laid over it. Pure: the
 * caller's payload is not changed and nothing is stored. A stated value is the
 * latest for this computation unless a saved point is newer; two for one field
 * keep the later-dated (an undated value is today's). A value the run cannot
 * use (out of range, a bad date, shape or unit, or in an ask-unit band) that is
 * not older than the saved point takes the field out of the run: the saved
 * value, and any stated one from that day or earlier, never answers for it.
 * So does a blood pressure that is not a usable pair (two numbers from one day).
 * A stated age sets the birth year from `now`, in January, so the plan's age
 * is the stated one and the minor gate is exactly under 18. A stated birth
 * year (when no usable age is given) is used as stated, without a month.
 */
export function runRoadmap(guestInputs: unknown, rawInput: unknown, now = new Date()): RoadmapRun {
  const base = obj(guestInputs);
  const input = obj(rawInput);
  const history = obj(base.measurementHistory);
  const today = latestDayOnEarth(now);
  const rejected: RoadmapRun['rejected'] = [];
  const reject = (field: string, reason: string) => { rejected.push({ field, reason }); };
  const stated = new Map<EditableField, { si: number; date: string; system: UnitSystem }>();
  /** Fields whose saved value must not answer for this run (C1). */
  const unusable = new Set<string>();
  /** Per field, the latest day of a stated value the run could not use (Codex R1, adversary R2). */
  const blocked = new Map<EditableField, string>();
  const block = (field: EditableField, day: string, reason: string) => {
    reject(field, reason);
    if (day > (blocked.get(field) ?? '')) blocked.set(field, day);
  };

  const items = Array.isArray(input.values) ? input.values : [];
  if (items.length > RUN_ROADMAP_MAX_VALUES) reject('values', REASONS.cap);
  // A value past the cap was not read and may be the newest (a history pasted in date
  // order), so neither an earlier stated value nor the saved one answers for its field.
  for (const raw of items.slice(RUN_ROADMAP_MAX_VALUES)) {
    const field = obj(raw).field;
    if (isEditable(field)) block(field, UNKNOWN_DAY, REASONS.cap);
  }
  for (const raw of items.slice(0, RUN_ROADMAP_MAX_VALUES)) {
    const item = obj(raw);
    const field = item.field;
    if (!isEditable(field)) { reject('unknown', REASONS.field); continue; }
    const date = item.date == null ? today : statedDay(item.date, now);
    if (!date) { block(field, UNKNOWN_DAY, REASONS.date); continue; }
    const metric = FIELD_TO_METRIC[field] as MetricType;
    // First after the date, so a dated old value, usable or not, never touches a newer saved one.
    if (date < savedLatestDay(history, metric, today)) { reject(field, REASONS.older); continue; }
    const parsed = measured.safeParse(item);
    if (!parsed.success) { block(field, date, REASONS.shape); continue; }
    const reported = reportedToCanonical(metric, parsed.data.value, parsed.data.unit);
    if (!reported) { block(field, date, REASONS.unit); continue; }
    // In the band, the number is a unit swap (LDL "3.4 mg/dL", HbA1c "6.1 mmol/mol"), not a result.
    if (askUnit(metric, reported)) { block(field, date, REASONS.unit); continue; }
    const outside = outOfRange(field, reported.valueSI);
    if (outside) { block(field, date, outside); continue; }
    const prior = stated.get(field);
    if (prior && prior.date > date) { reject(field, REASONS.later); continue; }
    if (prior) reject(field, REASONS.later);
    stated.set(field, { si: reported.valueSI, date, system: reported.system });
  }

  // A value the run could not use outdates every stated one from its day or
  // earlier (same day included: the conservative reading).
  for (const [field, day] of blocked) {
    const kept = stated.get(field);
    if (kept && kept.date > day) continue;
    if (stated.delete(field)) reject(field, REASONS.superseded);
    unusable.add(field);
  }

  // Blood pressure is one reading: used as a pair from one day or not at all.
  // Stated numbers the saved reading all outdates (one or both) keep the saved one.
  const bpRejected = rejected.filter(r => BP_FIELDS.includes(r.field));
  const [sys, dia] = [stated.get('systolicBp'), stated.get('diastolicBp')];
  const bpOutdated = !sys && !dia && bpRejected.length > 0 && bpRejected.every(r => r.reason === REASONS.older);
  if ((bpRejected.length > 0 || sys || dia) && !(sys && dia && sys.date === dia.date) && !bpOutdated) {
    for (const f of BP_FIELDS as EditableField[]) {
      if (stated.delete(f) || !bpRejected.some(r => r.field === f)) reject(f, REASONS.pair);
      unusable.add(f);
    }
  }

  const overlay: Record<string, unknown> = {};
  for (const [field, { si }] of stated) overlay[field] = si;
  if (input.sex != null) {
    if (inRange('sex', input.sex)) overlay.sex = input.sex;
    else reject('sex', REASONS.range);
  }
  if (input.height != null) {
    const height = measured.safeParse(input.height);
    const cm = height.success ? reportedToCanonical('height', height.data.value, height.data.unit)?.valueSI : undefined;
    const outside = cm === undefined ? null : outOfRange('heightCm', cm);
    if (!height.success) reject('heightCm', REASONS.shape);
    else if (cm === undefined) reject('heightCm', REASONS.unit);
    // Height barely changes: a mistyped one keeps the saved height, so the plan still runs.
    else if (outside) reject('heightCm', outside);
    else overlay.heightCm = cm;
  } else if (input.heightCm != null) reject('heightCm', REASONS.shape);
  const applied = Object.keys(overlay);
  const birth: Record<string, unknown> = {};
  // The age wins when both are usable; a refused age falls back to a stated birth year.
  for (const field of ['age', 'birthYear'] as const) {
    if (input[field] == null) continue;
    // US-07 AC6: a saved known minor stays one, whatever the message says.
    if (knownMinorOf(base)) { reject(field, REASONS.minor); continue; }
    // An age is rounded down (16.5 is 16) and a number sent as text is read, so a usable
    // age is never refused: a refused one keeps the saved age, or leaves none (US-07 AC6).
    const value = numeric(input[field]);
    const birthYear = field === 'age' ? now.getFullYear() - Math.floor(value) : value;
    if (!Number.isInteger(birthYear) || !inRange('birthYear', birthYear)) { reject(field, REASONS.range); continue; }
    // An age sets January: the plan's age (calculateAge) is the stated one all year, and the minor gate is age < 18.
    // A different stated birth year makes the saved month meaningless; with no month the gate stays conservative.
    if (field === 'age') Object.assign(birth, { birthYear, birthMonth: 1 });
    else Object.assign(birth, { birthYear, birthMonth: birthYear === base.birthYear ? base.birthMonth : undefined });
    applied.push(field);
    break;
  }

  const payload: Record<string, unknown> = { ...base, ...overlay, ...birth };
  if (payload.birthMonth === undefined) delete payload.birthMonth;
  for (const f of unusable) delete payload[f];
  if (unusable.size > 0 && base.measurementHistory !== undefined) {
    const gone = new Set([...unusable].map(f => FIELD_TO_METRIC[f]));
    payload.measurementHistory = Object.fromEntries(Object.entries(history).filter(([metric]) => !gone.has(metric)));
  }
  // Without a saved unit preference, the plan prints in the system the user wrote in.
  if (base.unitSystem !== 'si' && base.unitSystem !== 'conventional') {
    payload.unitSystem = stated.values().next().value?.system ?? 'si';
  }
  const contextJson = buildChatContextJson(payload);
  const plan = contextJson ? JSON.parse(contextJson) : null;
  // No usable sex or height: the context carries the values but no cards (US-15 AC36);
  // this tool still answers "no plan". A known minor's context has no cards either, and is sent.
  if (!plan?.currentSuggestions && !plan?.profile?.knownMinor) return { contextJson: null, applied, rejected };
  // Without an eGFR the protein card falls back to the standard target. When this run
  // has none although the saved data had one, or a creatinine was stated, that would
  // quietly drop a kidney adjustment: withhold the card. (A minor's eGFR is hidden, not lost.)
  const lostEgfr = plan.derivedValues?.eGFR === undefined && !plan.profile?.knownMinor
    && (items.some(raw => obj(raw).field === 'creatinine')
      || JSON.parse(buildChatContextJson(base) ?? '{}').derivedValues?.eGFR !== undefined);
  if (!lostEgfr) return { contextJson, applied, rejected };
  plan.currentSuggestions = plan.currentSuggestions?.filter((s: { id?: string }) => s.id !== 'protein-target');
  // A creatinine the run used with no age to read it by: the gap is the age, not a refused value.
  if (plan.latestValues?.creatinine !== undefined && plan.profile?.age === undefined) reject('age', REASONS.proteinAge);
  else reject('creatinine', REASONS.protein);
  return { contextJson: JSON.stringify(plan), applied, rejected };
}

const NOT_SAVED = 'The stated values are used for this answer only; nothing was saved.';
const NO_PLAN = 'No plan: the roadmap needs at least the user\'s sex and height. Ask for them; do not assess the values yourself.';

/** The tool_result text: buildChatContextJson's output, verbatim, beside the applied and rejected fields. */
export function roadmapResultText(run: RoadmapRun): string {
  return `{"applied":${JSON.stringify(run.applied)},"rejected":${JSON.stringify(run.rejected)},` +
    `"note":${JSON.stringify(run.contextJson ? NOT_SAVED : `${NOT_SAVED} ${NO_PLAN}`)},"roadmap":${run.contextJson ?? 'null'}}`;
}

// ---------------------------------------------------------------------------
// The shared one-round loop
// ---------------------------------------------------------------------------

/** A content block as the Messages API returns it (other fields ride along); replayed unmodified. */
export interface ChatContentBlock { type: string; id?: string; name?: string; input?: unknown }
/** A tool_result block, the user's side of a round. */
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string | undefined; content: string }
export interface ChatTurnMessage { role: 'user' | 'assistant'; content: string | ReadonlyArray<ChatContentBlock | ToolResultBlock> }
/** What a round cost in values: counts only, for the usage signal. Never a value. */
export interface RoadmapRoundCounts { applied: number; rejected: number }
/** A transport's own tool_result for a tool health-core does not know (US-49's subscription tool); undefined for the rest. */
export type ToolResultFor = (b: ChatContentBlock, blocks: readonly ChatContentBlock[]) => string | undefined;

/** Stub results for a form tool called beside run_roadmap: the client applies a valid one after the answer. */
const FORM_TOOL_STUB = 'Pre-filled for the user to review and Save.';
const MEDICATION_STUB = 'Sent to the user\'s form; medications save at once and the user can undo.';
const PROFILE_STUB = 'Shown to the user to confirm; nothing is saved until they press Save.';
const NOT_APPLIED = 'Not applied: the edit did not pass the form\'s checks, so nothing was pre-filled or saved.';
const NOT_RUN = 'Not run: one run_roadmap per turn; use the first result.';

/** The tool_result for a form tool: pre-filled or saved only when the client will apply it (parseProposedEdit accepts it). */
function formToolStub(b: ChatContentBlock): string {
  const edit = b.name ? parseProposedEdit(b.name, b.input) : null;
  return !edit ? NOT_APPLIED : edit.kind === 'medication' ? MEDICATION_STUB : edit.kind === 'profile' ? PROFILE_STUB : FORM_TOOL_STUB;
}

/** Every run_roadmap call of one reply as one input: the values in order, each profile field from the first call that gives it. */
function mergedRunInput(inputs: unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = { values: [] };
  for (const raw of inputs) {
    const input = obj(raw);
    if (Array.isArray(input.values)) merged.values = (merged.values as unknown[]).concat(input.values);
    for (const f of ['sex', 'height', 'heightCm', 'age', 'birthYear']) if (merged[f] === undefined && input[f] != null) merged[f] = input[f];
  }
  return merged;
}

/**
 * The tool_result blocks for a reply that called run_roadmap, one per tool_use
 * in order, or null when it did not call it. However many run_roadmap calls
 * the reply holds, the plan runs once, on all their values under one cap, and
 * answers the first; the others get a fixed stub. Any other tool gets
 * `otherResult`'s text when it gives one, else the form tools' stub.
 */
export function roadmapToolResults(
  blocks: ChatContentBlock[],
  guestInputs: unknown,
  otherResult?: ToolResultFor,
): { results: ToolResultBlock[]; counts: RoadmapRoundCounts } | null {
  const uses = blocks.filter(b => b.type === 'tool_use');
  const runs = uses.filter(b => b.name === RUN_ROADMAP_TOOL.name);
  if (runs.length === 0) return null;
  const run = runRoadmap(guestInputs, mergedRunInput(runs.map(b => b.input)));
  const results = uses.map((b): ToolResultBlock => ({
    type: 'tool_result',
    tool_use_id: b.id,
    content: b === runs[0] ? roadmapResultText(run) : b.name === RUN_ROADMAP_TOOL.name ? NOT_RUN : otherResult?.(b, blocks) ?? formToolStub(b),
  }));
  return { results, counts: { applied: run.applied.length, rejected: run.rejected.length } };
}

/**
 * One chat turn with at most one run_roadmap round. `send` makes one Messages
 * call with these fields laid over the transport's own body. When the first
 * reply calls run_roadmap, the second call carries it back unmodified with the
 * tool results and `tool_choice: none`, so no second round can start; its
 * reply is the answer. A failed second call throws, as a failed first one does;
 * `onRound` has the round's counts before that call, so a caller keeps them.
 * `otherResult` answers a tool only the transport knows (roadmapToolResults).
 */
export async function withRoadmapRound<R extends { contentBlocks: ChatContentBlock[] }>(
  messages: ChatTurnMessage[],
  send: (fields: { messages: ChatTurnMessage[]; tool_choice?: { type: 'none' } }) => Promise<R>,
  guestInputs: unknown,
  onRound?: (counts: RoadmapRoundCounts) => void,
  otherResult?: ToolResultFor,
): Promise<{ first: R; final: R; counts: RoadmapRoundCounts | null; proposedEdits: ProposedEdit[] }> {
  const first = await send({ messages });
  const round = roadmapToolResults(first.contentBlocks, guestInputs, otherResult);
  if (!round) return { first, final: first, counts: null, proposedEdits: parseProposedEdits(first.contentBlocks) };
  onRound?.(round.counts);
  const final = await send({
    messages: [...messages, { role: 'assistant', content: first.contentBlocks }, { role: 'user', content: round.results }],
    tool_choice: { type: 'none' },
  });
  return { first, final, counts: round.counts, proposedEdits: parseProposedEdits([...first.contentBlocks, ...final.contentBlocks]) };
}
