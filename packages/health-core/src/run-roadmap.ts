/**
 * US-15 AC33: the chat runs the roadmap's own plan code on values the user
 * types into the message, and answers from what it computes.
 *
 * `run_roadmap` overlays the stated values on the request's context payload
 * (the same `guestInputs` the chat already receives) and returns exactly
 * `buildChatContextJson`'s output for the result, so the tool's answer passes
 * the same anti-injection boundary as the prompt's user data block. Nothing is
 * saved: a stated value stands in for the saved one for this answer only.
 * Saving stays the user's job (propose_field_edit pre-fills, they press Save).
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
  CHAT_EDIT_TOOLS, EDITABLE_FIELDS, PROPOSE_MEDICATION_EDIT_TOOL, parseProposedEdit, parseProposedEdits,
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
    'units. Give sex, height or birthYear only when the user stated them in this conversation; height in cm or in ' +
    '(feet and inches as total inches: 5 ft 5 in is 65 in). If a unit is ' +
    'ambiguous and the user did not state it, ASK which unit instead of calling this tool, and do not grade the ' +
    'value in any unit. Answer only from the result, as you would from the user data block: never grade a value ' +
    'yourself. Tell the user the values are not saved, and offer to pre-fill them with propose_field_edit.',
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
      birthYear: { type: 'integer' as const, description: 'Only if the user stated it, or their age (this year minus age).' },
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
 * cache separately.
 */
export function chatToolsFor(messages: readonly ChatTurnMessage[]) {
  const said = messages.filter(m => m.role === 'user' && typeof m.content === 'string').slice(-2);
  return said.some(m => /\d/.test(m.content as string)) ? CHAT_TOOLS : CHAT_EDIT_TOOLS;
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
  labAbove: 'above the highest value the roadmap records in this unit: ask the user to confirm the unit; if it is right, the value is very high and needs their doctor promptly',
  labBelow: 'below the lowest value the roadmap records: ask the user to confirm the value and unit',
  body: 'outside what the roadmap records: ask the user to check the value and unit',
  range: 'out of range for this field',
  date: 'not a real date, or a date in the future',
  older: 'older than the saved value',
  cap: `only the first ${RUN_ROADMAP_MAX_VALUES} values were used`,
  later: 'a later value for the same field was used',
  pair: 'blood pressure is read as a pair: both numbers are needed, each one usable, so neither was used',
  minor: 'the saved profile is under 18: a stated birth year is not used',
} as const;

const BP_FIELDS: readonly string[] = ['systolicBp', 'diastolicBp'];
const BODY_FIELDS: readonly string[] = ['weightKg', 'waistCm', 'heightCm'];
/** US-36 AC4's unit-swap floors, plus HbA1c and creatinine under 20 (mmol/mol, µmol/L): a unit to ask about, not a result. */
const ASK_UNIT_BELOW: Partial<Record<MetricType, number>> = { ...UNIT_SWAP_FLOORS, hba1c: 20, creatinine: 20 };
const measured = z.object({ value: z.number().finite(), unit: z.string().min(1).max(32) });
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
 * keep the later-dated (an undated value is today's). A value out of its
 * field's range, and a blood pressure that is not a usable pair (two numbers
 * from one day), takes the saved value out of the run too, so the saved one
 * never answers for it.
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

  const items = Array.isArray(input.values) ? input.values : [];
  if (items.length > RUN_ROADMAP_MAX_VALUES) reject('values', REASONS.cap);
  for (const raw of items.slice(0, RUN_ROADMAP_MAX_VALUES)) {
    const item = obj(raw);
    const field = item.field;
    if (!isEditable(field)) { reject('unknown', REASONS.field); continue; }
    const parsed = measured.safeParse(item);
    if (!parsed.success) { reject(field, REASONS.shape); continue; }
    const date = item.date == null ? today : statedDay(item.date, now);
    if (!date) { reject(field, REASONS.date); continue; }
    const metric = FIELD_TO_METRIC[field] as MetricType;
    const reported = reportedToCanonical(metric, parsed.data.value, parsed.data.unit);
    if (!reported) { reject(field, REASONS.unit); continue; }
    // First, so a dated old value, in range or not, never touches a newer saved one.
    if (date < savedLatestDay(history, metric, today)) { reject(field, REASONS.older); continue; }
    // Below the band, the number is a unit swap (LDL "3.4 mg/dL", HbA1c "6.1 mmol/mol"), not a result.
    if (reported.valueSI < (ASK_UNIT_BELOW[metric] ?? -Infinity)) { reject(field, REASONS.unit); continue; }
    const outside = outOfRange(field, reported.valueSI);
    if (outside) { reject(field, outside); unusable.add(field); continue; }
    const prior = stated.get(field);
    if (prior && prior.date > date) { reject(field, REASONS.later); continue; }
    if (prior) reject(field, REASONS.later);
    stated.set(field, { si: reported.valueSI, date, system: reported.system });
  }

  // Blood pressure is one reading: used as a pair from one day or not at all.
  // A pair whose two numbers the saved one both outdates keeps the saved one.
  const bpRejected = rejected.filter(r => BP_FIELDS.includes(r.field));
  const [sys, dia] = [stated.get('systolicBp'), stated.get('diastolicBp')];
  const bpOutdated = !sys && !dia && BP_FIELDS.every(f => bpRejected.some(r => r.field === f))
    && bpRejected.every(r => r.reason === REASONS.older);
  if ((bpRejected.length > 0 || sys || dia) && !(sys && dia && sys.date === dia.date) && !bpOutdated) {
    for (const f of BP_FIELDS as EditableField[]) {
      if (stated.delete(f) || !bpRejected.some(r => r.field === f)) reject(f, REASONS.pair);
      unusable.add(f);
    }
  }
  for (const f of stated.keys()) unusable.delete(f);

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
    else if (outside) { reject('heightCm', outside); unusable.add('heightCm'); }
    else overlay.heightCm = cm;
  } else if (input.heightCm != null) reject('heightCm', REASONS.shape);
  if (input.birthYear != null) {
    // US-07 AC6: a saved known minor stays one, whatever the message says.
    if (knownMinorOf(base)) reject('birthYear', REASONS.minor);
    else if (Number.isInteger(input.birthYear) && inRange('birthYear', input.birthYear)) overlay.birthYear = input.birthYear;
    else reject('birthYear', REASONS.range);
  }

  const payload: Record<string, unknown> = { ...base, ...overlay };
  for (const f of unusable) delete payload[f];
  if (unusable.size > 0 && base.measurementHistory !== undefined) {
    const gone = new Set([...unusable].map(f => FIELD_TO_METRIC[f]));
    payload.measurementHistory = Object.fromEntries(Object.entries(history).filter(([metric]) => !gone.has(metric)));
  }
  // A stated birth year that differs from the saved one makes the saved month meaningless.
  if (overlay.birthYear !== undefined && overlay.birthYear !== base.birthYear) delete payload.birthMonth;
  // Without a saved unit preference, the plan prints in the system the user wrote in.
  if (base.unitSystem !== 'si' && base.unitSystem !== 'conventional') {
    payload.unitSystem = stated.values().next().value?.system ?? 'si';
  }
  return { contextJson: buildChatContextJson(payload), applied: Object.keys(overlay), rejected };
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

/** Stub results for a form tool called beside run_roadmap: the client applies a valid one after the answer. */
const FORM_TOOL_STUB = 'Pre-filled for the user to review and Save.';
const MEDICATION_STUB = 'Sent to the user\'s form; medications save at once and the user can undo.';
const NOT_APPLIED = 'Not applied: the edit did not pass the form\'s checks, so nothing was pre-filled or saved.';
const NOT_RUN = 'Not run: one run_roadmap per turn; use the first result.';

/** The tool_result for a form tool: pre-filled or saved only when the client will apply it (parseProposedEdit accepts it). */
function formToolStub(b: ChatContentBlock): string {
  const edit = b.name ? parseProposedEdit(b.name, b.input) : null;
  return !edit ? NOT_APPLIED : b.name === PROPOSE_MEDICATION_EDIT_TOOL.name ? MEDICATION_STUB : FORM_TOOL_STUB;
}

/** Every run_roadmap call of one reply as one input: the values in order, each profile field from the first call that gives it. */
function mergedRunInput(inputs: unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = { values: [] };
  for (const raw of inputs) {
    const input = obj(raw);
    if (Array.isArray(input.values)) merged.values = (merged.values as unknown[]).concat(input.values);
    for (const f of ['sex', 'height', 'heightCm', 'birthYear']) if (merged[f] === undefined && input[f] != null) merged[f] = input[f];
  }
  return merged;
}

/**
 * The tool_result blocks for a reply that called run_roadmap, one per tool_use
 * in order, or null when it did not call it. However many run_roadmap calls
 * the reply holds, the plan runs once, on all their values under one cap, and
 * answers the first; the others get a fixed stub.
 */
export function roadmapToolResults(blocks: ChatContentBlock[], guestInputs: unknown): { results: ToolResultBlock[]; counts: RoadmapRoundCounts } | null {
  const uses = blocks.filter(b => b.type === 'tool_use');
  const runs = uses.filter(b => b.name === RUN_ROADMAP_TOOL.name);
  if (runs.length === 0) return null;
  const run = runRoadmap(guestInputs, mergedRunInput(runs.map(b => b.input)));
  const results = uses.map((b): ToolResultBlock => ({
    type: 'tool_result',
    tool_use_id: b.id,
    content: b === runs[0] ? roadmapResultText(run) : b.name === RUN_ROADMAP_TOOL.name ? NOT_RUN : formToolStub(b),
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
 */
export async function withRoadmapRound<R extends { contentBlocks: ChatContentBlock[] }>(
  messages: ChatTurnMessage[],
  send: (fields: { messages: ChatTurnMessage[]; tool_choice?: { type: 'none' } }) => Promise<R>,
  guestInputs: unknown,
  onRound?: (counts: RoadmapRoundCounts) => void,
): Promise<{ first: R; final: R; counts: RoadmapRoundCounts | null; proposedEdits: ProposedEdit[] }> {
  const first = await send({ messages });
  const round = roadmapToolResults(first.contentBlocks, guestInputs);
  if (!round) return { first, final: first, counts: null, proposedEdits: parseProposedEdits(first.contentBlocks) };
  onRound?.(round.counts);
  const final = await send({
    messages: [...messages, { role: 'assistant', content: first.contentBlocks }, { role: 'user', content: round.results }],
    tool_choice: { type: 'none' },
  });
  return { first, final, counts: round.counts, proposedEdits: parseProposedEdits([...first.contentBlocks, ...final.contentBlocks]) };
}
