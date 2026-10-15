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
import { reportedToCanonical, type MetricType, type UnitSystem } from './units';
import { FIELD_TO_METRIC } from './mappings';
import { sanitizeInputs } from './validation';
import { ISO_DATE } from './measurement-history';
import { buildChatContextJson } from './chat-context';
import {
  CHAT_EDIT_TOOLS, EDITABLE_FIELDS, PROPOSE_MEDICATION_EDIT_TOOL, parseProposedEdits,
  type EditableField, type ProposedEdit,
} from './chat-edits';

/** Most stated values one call reads; the rest are rejected. */
export const RUN_ROADMAP_MAX_VALUES = 20;

export const RUN_ROADMAP_TOOL = {
  name: 'run_roadmap',
  description:
    "Run the Health Roadmap's own plan code on the user's saved data plus values they state in this " +
    'conversation, and get back the plan it computes (the same JSON as the user data block). Call it when ' +
    'the user states values that are not in their saved data and wants them assessed or analysed (e.g. ' +
    '"analyse my data: LDL 4.1 mmol/L, BP 132/84"). Pass exactly the stated values and units: do NOT convert ' +
    'units. Give sex, heightCm or birthYear only when the user stated them in this conversation. If a unit is ' +
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
      heightCm: { type: 'number' as const, description: 'Height in cm, only if the user stated it.' },
      birthYear: { type: 'integer' as const, description: 'Only if the user stated it, or their age (this year minus age).' },
    },
    required: ['values'],
  },
} as const;

/** The website widget's and the Pages chat's tools: the form tools plus run_roadmap. */
export const CHAT_TOOLS = [...CHAT_EDIT_TOOLS, RUN_ROADMAP_TOOL];

/**
 * The website widget's and the Pages chat's tools for one turn: run_roadmap
 * only when the latest user message has a digit, since it runs only on stated
 * values; the form tools always. Tools render before the system prompt, so
 * the two shapes cache separately.
 */
export function chatToolsFor(messages: readonly ChatTurnMessage[]) {
  const latest = messages[messages.length - 1]?.content;
  return typeof latest === 'string' && /\d/.test(latest) ? CHAT_TOOLS : CHAT_EDIT_TOOLS;
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
  range: 'out of range for this field',
  date: 'date is not YYYY-MM-DD',
  cap: `only the first ${RUN_ROADMAP_MAX_VALUES} values were used`,
  older: 'a later value for the same field was used',
} as const;

const itemSchema = z.object({ value: z.number().finite(), unit: z.string().min(1).max(32) });
const PROFILE_FIELDS = ['sex', 'heightCm', 'birthYear'] as const;
/** What the result names a field as: a field the schema knows, never the model's own string. */
const fieldName = (f: unknown) =>
  typeof f === 'string' && ((EDITABLE_FIELDS as readonly string[]).includes(f) || (PROFILE_FIELDS as readonly string[]).includes(f)) ? f : 'unknown';
/** A value the input schema accepts for `field`: sanitizeInputs drops anything out of range. */
const inRange = (field: string, value: unknown) => field in sanitizeInputs({ [field]: value } as Partial<HealthInputs>);

/**
 * The plan for `guestInputs` with the stated values laid over it. Pure: the
 * caller's payload is not changed and nothing is stored. A stated value is the
 * latest for this computation; two for one field keep the later-dated (an
 * undated value is today's).
 */
export function runRoadmap(guestInputs: unknown, rawInput: unknown): RoadmapRun {
  const base = guestInputs && typeof guestInputs === 'object' && !Array.isArray(guestInputs)
    ? guestInputs as Record<string, unknown> : {};
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const rejected: RoadmapRun['rejected'] = [];
  const stated = new Map<EditableField, { si: number; date: string; system: UnitSystem }>();

  const items = Array.isArray(input.values) ? input.values : [];
  if (items.length > RUN_ROADMAP_MAX_VALUES) rejected.push({ field: 'values', reason: REASONS.cap });
  for (const raw of items.slice(0, RUN_ROADMAP_MAX_VALUES)) {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const field = fieldName(item.field);
    if (!(EDITABLE_FIELDS as readonly string[]).includes(field)) { rejected.push({ field: 'unknown', reason: REASONS.field }); continue; }
    const parsed = itemSchema.safeParse(item);
    if (!parsed.success) { rejected.push({ field, reason: REASONS.shape }); continue; }
    if (item.date != null && !(typeof item.date === 'string' && ISO_DATE.test(item.date))) { rejected.push({ field, reason: REASONS.date }); continue; }
    const reported = reportedToCanonical(FIELD_TO_METRIC[field] as MetricType, parsed.data.value, parsed.data.unit);
    if (!reported) { rejected.push({ field, reason: REASONS.unit }); continue; }
    if (!inRange(field, reported.valueSI)) { rejected.push({ field, reason: REASONS.range }); continue; }
    const date = typeof item.date === 'string' ? item.date : '9999-12-31';
    const prior = stated.get(field as EditableField);
    if (prior && prior.date > date) { rejected.push({ field, reason: REASONS.older }); continue; }
    if (prior) rejected.push({ field, reason: REASONS.older });
    stated.set(field as EditableField, { si: reported.valueSI, date, system: reported.system });
  }

  const overlay: Record<string, unknown> = {};
  for (const [field, { si }] of stated) overlay[field] = si;
  for (const field of PROFILE_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    const ok = (field !== 'birthYear' || Number.isInteger(value)) && inRange(field, value);
    if (ok) overlay[field] = value;
    else rejected.push({ field, reason: REASONS.range });
  }
  const payload: Record<string, unknown> = { ...base, ...overlay };
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

/** Stub results for a form tool called beside run_roadmap: the client applies it after the answer. */
const FORM_TOOL_STUB = 'Pre-filled for the user to review and Save.';
const MEDICATION_STUB = 'Sent to the user\'s form; medications save at once and the user can undo.';

/**
 * The tool_result blocks for a reply that called run_roadmap, one per tool_use
 * in order, or null when it did not call it.
 */
export function roadmapToolResults(blocks: ChatContentBlock[], guestInputs: unknown): { results: ToolResultBlock[]; counts: RoadmapRoundCounts } | null {
  const uses = blocks.filter(b => b.type === 'tool_use');
  if (!uses.some(b => b.name === RUN_ROADMAP_TOOL.name)) return null;
  const counts = { applied: 0, rejected: 0 };
  const results = uses.map((b): ToolResultBlock => {
    if (b.name !== RUN_ROADMAP_TOOL.name) {
      return { type: 'tool_result', tool_use_id: b.id, content: b.name === PROPOSE_MEDICATION_EDIT_TOOL.name ? MEDICATION_STUB : FORM_TOOL_STUB };
    }
    const run = runRoadmap(guestInputs, b.input);
    counts.applied += run.applied.length;
    counts.rejected += run.rejected.length;
    return { type: 'tool_result', tool_use_id: b.id, content: roadmapResultText(run) };
  });
  return { results, counts };
}

/**
 * One chat turn with at most one run_roadmap round. `send` makes one Messages
 * call with these fields laid over the transport's own body. When the first
 * reply calls run_roadmap, the second call carries it back unmodified with the
 * tool results and `tool_choice: none`, so no second round can start; its
 * reply is the answer. A failed second call throws, as a failed first one does.
 */
export async function withRoadmapRound<R extends { contentBlocks: ChatContentBlock[] }>(
  messages: ChatTurnMessage[],
  send: (fields: { messages: ChatTurnMessage[]; tool_choice?: { type: 'none' } }) => Promise<R>,
  guestInputs: unknown,
  onRound?: () => void,
): Promise<{ first: R; final: R; counts: RoadmapRoundCounts | null; proposedEdits: ProposedEdit[] }> {
  const first = await send({ messages });
  const round = roadmapToolResults(first.contentBlocks, guestInputs);
  if (!round) return { first, final: first, counts: null, proposedEdits: parseProposedEdits(first.contentBlocks) };
  onRound?.();
  const final = await send({
    messages: [...messages, { role: 'assistant', content: first.contentBlocks }, { role: 'user', content: round.results }],
    tool_choice: { type: 'none' },
  });
  return { first, final, counts: round.counts, proposedEdits: parseProposedEdits([...first.contentBlocks, ...final.contentBlocks]) };
}
