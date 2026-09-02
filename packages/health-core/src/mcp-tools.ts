/**
 * The seven MCP tools, as pure functions (US-32, US-34).
 *
 * `record-edits.ts` holds the rules a write must keep and `plan.ts` holds the
 * derivation; this layer is what an AI assistant is actually offered — seven
 * named tools, their argument schemas, and the words they answer in. It takes
 * a `RoadmapFile` and returns a new one; opening the file, backing it up and
 * putting bytes back on disk belong to the caller (`tools/mcp-server.ts`
 * locally, the hosted server later), so the same tool surface can sit over a
 * local path or a user's cloud folder without changing what a tool means.
 *
 * Nothing here reads the clock, the filesystem or the network.
 */
import { dayOf } from './merge';
import { labSlotKey } from './lab-catalog';
import { computePlan, oneLine, PlanError, planPayload, printable } from './plan';
import {
  appendLabValue,
  appendMeasurement,
  type EditContext,
  correctValue,
  stampUpdatedAt,
  type EditRejection,
} from './record-edits';
import type { FileLabValue, FileMeasurement, FileReminderOptIn, RoadmapFile } from './roadmap-file';
import type { SyncManager } from './sync-manager';
import { UNIT_DEFS, type MetricType } from './units';
import { healthInputSchema, METRIC_TYPES } from './validation';
import { z } from 'zod';

/**
 * Rows one `add_lab_values` call may write. A lab panel is the case this tool
 * exists for and a big one runs to a few dozen tests; past that a call is a
 * loop, not a report, and a bounded call is what keeps a confused or injected
 * agent's mistake small (design §3, mitigation 3).
 */
export const MAX_LAB_ROWS_PER_CALL = 50;

/**
 * Longest test name or unit a tool will take, and longest row id. Neither is a
 * clinical limit — a real test name is a few words and an id is a UUID (~45
 * chars with a duplicate suffix). They exist because nothing else bounds the
 * bytes one call can put in the user's file: without them a single call can
 * write megabytes of a string into a record that has to be read back whole.
 */
export const MAX_NAME_LENGTH = 120;
export const MAX_ID_LENGTH = 100;

/**
 * Longest a prepared feedback URL may be. GitHub takes a long query string but
 * truncates a very long one SILENTLY, and a report that arrives with its last
 * paragraph missing is worse than one that was refused.
 */
export const MAX_FEEDBACK_URL_LENGTH = 8000;

/** Where a prepared report goes. The only place this repo's name is written. */
export const FEEDBACK_REPO = 'DrBradStanfield/roadmap';

/** The version the server announces, and the one a report is stamped with. */
export const SERVER_VERSION = '1.0.0';

/** Bumped when a tool's meaning changes, so an old report reads correctly. */
export const TOOL_LAYER_VERSION = 1;

/** ISO calendar day — the only date shape a tool takes. */
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar day, YYYY-MM-DD');

export const readRecordInput = z.object({
  metric: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  since: DAY.optional(),
}).strict();

export const getPlanInput = z.object({}).strict();

export const addMeasurementInput = z.object({
  metricType: z.string().min(1).max(MAX_NAME_LENGTH),
  value: z.number().finite(),
  unit: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  recordedAt: DAY,
}).strict();

/** One row of a panel. Exported so the parity test can read the nested shape. */
export const labValueInput = z.object({
  metricName: z.string().min(1).max(MAX_NAME_LENGTH),
  value: z.number().finite(),
  unit: z.string().min(1).max(MAX_NAME_LENGTH),
  referenceLow: z.number().finite().nullable().optional(),
  referenceHigh: z.number().finite().nullable().optional(),
  recordedAt: DAY,
}).strict();

export const addLabValuesInput = z.object({
  values: z.array(labValueInput).min(1).max(MAX_LAB_ROWS_PER_CALL),
}).strict();

export const correctValueInput = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  newValue: z.number().finite(),
  unit: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  expectedValue: z.number().finite().optional(),
}).strict();

/**
 * The profile fields a connector may change (US-34). Display preferences —
 * `unitSystem`, `unitOverrides`, `reportEmailCaptured` — are deliberately out
 * of reach: they are how the app draws the screen, not what the record says
 * about the person, and nobody asks an assistant to change them.
 */
export const PROFILE_FIELDS = ['sex', 'birthYear', 'birthMonth', 'heightCm'] as const;

/**
 * Shape only — the app's own ranges are checked in `updateProfile` below,
 * against `healthInputSchema`, so a refusal quotes the message a person would
 * see. `null` in `expected` is a claim too: "I believe the record has no value
 * for this yet", the only way to state one about a field that is unset.
 */
export const updateProfileInput = z.object({
  sex: z.enum(['male', 'female']).optional(),
  birthYear: z.number().int().optional(),
  birthMonth: z.number().int().optional(),
  heightCm: z.number().finite().optional(),
  expected: z.object({
    sex: z.enum(['male', 'female']).nullable().optional(),
    birthYear: z.number().int().nullable().optional(),
    birthMonth: z.number().int().nullable().optional(),
    heightCm: z.number().finite().nullable().optional(),
  }).strict().optional(),
}).strict();

export const reportFeedbackInput = z.object({
  kind: z.enum(['bug', 'feature']),
  title: z.string().min(1).max(MAX_NAME_LENGTH),
  detail: z.string().min(1).max(2000),
}).strict();

// ---------------------------------------------------------------------------
// What each tool answers with, typed (MCP `outputSchema`)
// ---------------------------------------------------------------------------

/**
 * The structured half of every answer. The words a tool returns do not change —
 * guides and tests pin them — this is the same answer as data, so a client can
 * take a row id without parsing prose.
 *
 * A record and a plan keep their own shape loosely: both are published in full
 * elsewhere (the file schema, `renderJson`), and restating them here would be a
 * second definition to keep in sync, which is how a schema starts lying.
 */
const LOOSE = z.record(z.unknown());
const ROWS = z.array(LOOSE);

/** The record as `readRecord` filters it — the file's own keys, minus the token. */
export const readRecordOutput = z.object({
  schemaVersion: z.number(),
  meta: LOOSE,
  profile: LOOSE,
  measurements: ROWS,
  medications: ROWS,
  medicationHistory: ROWS,
  supplements: ROWS,
  supplementHistory: ROWS,
  screenings: LOOSE,
  labValues: ROWS,
  documents: ROWS,
  reminderPreferences: ROWS,
  recommendationSnapshots: ROWS,
  reminderOptIn: LOOSE.optional(),
}).passthrough();

/** The plan, in the shape `planPayload` builds and `get-plan.ts --json` prints. */
export const getPlanOutput = z.object({
  instruction: z.string(),
  schemaVersion: z.number(),
  generatedAt: z.string(),
  today: z.string(),
  unitSystem: z.string(),
  profile: LOOSE,
  inputs: LOOSE,
  missingInputs: z.array(z.string()),
  currentValues: ROWS,
  labValues: ROWS,
  medications: LOOSE,
  screenings: LOOSE,
  due: LOOSE,
  suggestions: ROWS,
  source: LOOSE,
}).strict();

/** A written row, named the way the tool that wrote it names its subject. */
export const addMeasurementOutput = z.object({
  id: z.string(),
  metricType: z.string(),
  value: z.number(),
  unit: z.string().nullable(),
  recordedAt: z.string(),
}).strict();

export const labRowOutput = z.object({
  id: z.string(),
  metricName: z.string(),
  value: z.number(),
  unit: z.string(),
  recordedAt: z.string(),
}).strict();

export const addLabValuesOutput = z.object({ rows: z.array(labRowOutput) }).strict();

/** The new row, and the row it supersedes. */
export const correctValueOutput = z.object({
  id: z.string(),
  correctsId: z.string(),
  metric: z.string(),
  value: z.number(),
  unit: z.string().nullable(),
  recordedAt: z.string(),
}).strict();

/** Every field that moved, and what it moved from. Empty when nothing changed. */
export const updateProfileOutput = z.object({
  changed: z.array(z.object({
    field: z.enum(PROFILE_FIELDS),
    from: z.union([z.string(), z.number()]).nullable(),
    to: z.union([z.string(), z.number()]),
  }).strict()),
}).strict();

/**
 * The issue. `filed` is the whole difference between the two surfaces: the
 * hosted server posts it and answers with the issue it created; a server with
 * no GitHub token prepares a URL the user opens themselves.
 */
export const reportFeedbackOutput = z.object({
  filed: z.boolean(),
  url: z.string(),
  number: z.number().int().optional(),
  kind: z.enum(['bug', 'feature']),
  title: z.string(),
}).strict();

/**
 * What a tool call did. `rejected` is a refusal the agent should read and act
 * on — a taken slot, a value out of range — and nothing was written;
 * `invalid-args` is a malformed call, which is the protocol's problem, not the
 * record's. Only `ok` with a `file` asks the caller to save anything. A refusal
 * carries no `data`: the spec asks for structured content on a result, and a
 * refusal is an error result (`isError`), not one.
 */
export type ToolOutcome =
  | { status: 'ok'; text: string; data: unknown; file?: RoadmapFile }
  | { status: 'rejected'; text: string }
  | { status: 'invalid-args'; text: string };

/** A record safe to hand an assistant: same file, minus the capability secret. */
export type RedactedRecord = Omit<RoadmapFile, 'reminderOptIn'> & {
  reminderOptIn?: Omit<FileReminderOptIn, 'token'>;
};

/**
 * `reminderOptIn.token` manages the user's reminder schedule on Brad's server
 * (agent-access rule 12). It is a capability, not health data: an assistant
 * never needs it, and a copy of it in a chat transcript is a copy that can
 * cancel someone's reminders. It leaves on every read, here, once.
 */
export function redactRecord(file: RoadmapFile): RedactedRecord {
  // Always a copy, even with nothing to strip: a caller handed something typed
  // RedactedRecord must never be holding the store's own object.
  const { reminderOptIn, ...rest } = file;
  if (!reminderOptIn) return rest;
  const { token: _secret, ...optIn } = reminderOptIn;
  return { ...rest, reminderOptIn: optIn };
}

function matchesMetric(name: string, query: string): boolean {
  return name.toLowerCase() === query || labSlotKey(name) === query;
}

/**
 * The record as JSON, filtered. `metric` narrows the two value arrays to one
 * test — by catalogue key, so "Gamma GT" and `ggt` are the same question —
 * and `since` drops rows recorded before that day. Everything else (profile,
 * medications, supplements, screenings, documents) comes back whole: a filter
 * that silently hid a medication would make the plan unreadable.
 */
export function readRecord(file: RoadmapFile, request: z.infer<typeof readRecordInput>): ToolOutcome {
  const record = redactRecord(file);
  const metric = request.metric ? labSlotKey(request.metric) : undefined;
  const since = request.since;
  const keep = (row: { recordedAt?: string | null }) => !since || dayOf(row.recordedAt ?? '') >= since;

  const filtered: RedactedRecord = {
    ...record,
    measurements: record.measurements.filter((m) => (!metric || matchesMetric(m.metricType, metric)) && keep(m)),
    labValues: record.labValues.filter((l) => (!metric || matchesMetric(l.metricName, metric)) && keep(l)),
    // A question about one metric is not a question about the user's documents,
    // and a lab PDF's row list is the biggest thing in the record.
    documents: metric ? [] : record.documents,
  };
  return okJson(filtered);
}

/** The plan, in the same JSON shape `get-plan.ts --json` prints (US-30 AC3). */
export function getPlan(file: RoadmapFile, now: string): ToolOutcome {
  try {
    return okJson(planPayload(computePlan(file, new Date(now))));
  } catch (error) {
    if (error instanceof PlanError) return { status: 'rejected', text: `${error.message}. ${error.hint}` };
    throw error;
  }
}

/**
 * A refusal in the agent's own terms. A taken slot is the one rejection with a
 * next move, so it names the row holding the day and sends the agent to
 * `correct_value` — the same hint `tools/edit-record.ts` prints, because an
 * agent that improvises around a slot clash writes a second active row.
 */
function rejection(result: EditRejection): ToolOutcome {
  const held = result.existing;
  if (result.reason === 'slot-occupied' && held) {
    return {
      status: 'rejected',
      text: `${oneLine(result.message)}. That day already holds ${held.value} in row ${oneLine(held.id)}. ` +
        'Nothing was written. To change it, call correct_value with that row id — never add a second value to the same day.',
    };
  }
  return { status: 'rejected', text: `${oneLine(result.message)}. Nothing was written.` };
}

/** A read's answer: the same payload as data, and as the JSON older clients read. */
function okJson(data: unknown): ToolOutcome {
  return { status: 'ok', text: JSON.stringify(data), data };
}

/** One core metric, SI canonical, validated by health-core. */
export function addMeasurement(
  file: RoadmapFile,
  request: z.infer<typeof addMeasurementInput>,
  ctx: EditContext,
): ToolOutcome {
  const result = appendMeasurement(file, { ...request, ...ctx });
  if (!result.ok) return rejection(result);
  const row = result.row;
  return {
    status: 'ok',
    file: result.file,
    text: describe('Added', [row]),
    data: { id: row.id, metricType: row.metricType, ...rowValue(row) },
  };
}

/**
 * A batch of non-core lab values — the lab-report case, which is the point of
 * the tool. All or nothing: the first rejection stops the call and NOTHING is
 * written, so a half-imported panel never has to be told apart from a whole one.
 */
export function addLabValues(
  file: RoadmapFile,
  request: z.infer<typeof addLabValuesInput>,
  ctx: EditContext,
): ToolOutcome {
  let next = file;
  const rows: FileLabValue[] = [];
  for (const [index, value] of request.values.entries()) {
    const result = appendLabValue(next, { ...value, ...ctx });
    if (!result.ok) {
      const refusal = rejection(result);
      return { ...refusal, text: `values[${index}] (${oneLine(value.metricName)}): ${refusal.text} No row from this call was written.` };
    }
    next = result.file;
    rows.push(result.row);
  }
  return {
    status: 'ok',
    file: next,
    text: describe('Added', rows),
    data: {
      rows: rows.map((row) => ({ id: row.id, metricName: row.metricName, ...rowValue(row) })),
    },
  };
}

/**
 * Correct one value: append a row carrying the new number and `correctsId`,
 * and flip the old row to `entered-in-error` (agent-access rule 2). Never
 * folded into an add — a correction is a separate decision, made with the row
 * id in hand.
 *
 * `expectedValue` is the agent stating what it believes it is replacing.
 * `record-edits.ts` owns that check; it is OPTIONAL on this local surface and
 * REQUIRED by the hosted server (design §3).
 */
export function correctValueTool(
  file: RoadmapFile,
  request: z.infer<typeof correctValueInput>,
  now: string,
): ToolOutcome {
  const result = correctValue(file, { ...request, now });
  if (!result.ok) return rejection(result);
  const row = result.row;
  return {
    status: 'ok',
    file: result.file,
    text: describe('Corrected', [row]),
    data: {
      id: row.id,
      correctsId: request.id,
      metric: 'metricType' in row ? row.metricType : row.metricName,
      ...rowValue(row),
    },
  };
}

/**
 * Change who the record is about: sex, birth year, birth month, height (US-34).
 *
 * The profile is ONE last-write-wins object — `mergeFiles` picks the whole
 * newer copy, never a field of it — so this is a read-modify-write of the
 * object the record already holds: every field it carries survives, named or
 * not, known to this version or not. What makes that safe against a second
 * writer is `expected`: the agent states what it believes it is replacing, and
 * a mismatch writes nothing. Optional here (a person watching their own file),
 * REQUIRED on the hosted server, exactly as `expectedValue` is.
 */
export function updateProfile(
  file: RoadmapFile,
  request: z.infer<typeof updateProfileInput>,
  now: string,
): ToolOutcome {
  const named = PROFILE_FIELDS.filter((field) => request[field] !== undefined);
  if (named.length === 0) {
    return { status: 'rejected', text: `Name at least one of ${PROFILE_FIELDS.join(', ')}. Nothing was written.` };
  }

  // The app's own ranges, with the app's own words: a connector cannot write
  // what a person sitting at the form could not type.
  for (const field of named) {
    const parsed = healthInputSchema.shape[field].safeParse(request[field]);
    if (!parsed.success) {
      return { status: 'rejected', text: `${field}: ${oneLine(parsed.error.issues[0]?.message ?? 'out of range')}. Nothing was written.` };
    }
  }

  const stored = file.profile;
  for (const field of PROFILE_FIELDS) {
    const claim = request.expected?.[field] ?? undefined;
    if (request.expected && field in request.expected && claim !== (stored[field] ?? undefined)) {
      // The refusal must not become a read: an agent that guessed wrong learns
      // nothing about what the record actually holds (design §3).
      return { status: 'rejected', text: `The record does not hold the ${field} you expected. Read the record, then update. Nothing was written.` };
    }
  }

  const changed = named.filter((field) => request[field] !== stored[field]);
  if (changed.length === 0) {
    return { status: 'ok', text: 'The record already says that. Nothing was written.', data: { changed: [] } };
  }

  const profile = {
    ...stored,
    ...Object.fromEntries(changed.map((field) => [field, request[field]])),
    updatedAt: now,
    // One past the copy it read, which is exactly what the app does on its own
    // profile writes. Jumping to the FILE's clock instead would make every
    // connector write beat a concurrent one made in the app, whenever it was
    // made; tied lamports fall through to wall-clock time, which is the honest
    // answer to "who wrote last".
    lamport: (stored.lamport ?? 0) + 1,
  };
  return {
    status: 'ok',
    file: stampUpdatedAt({ ...file, profile }, now),
    text: changed.map((field) => `${field}: ${stored[field] ?? 'not set'} → ${request[field]}`).join('\n'),
    data: {
      changed: changed.map((field) => ({ field, from: stored[field] ?? null, to: request[field] as string | number })),
    },
  };
}

/**
 * The half of a written row every writing tool answers with. The row is stored
 * SI canonical, so a measurement's unit is the metric's, not the caller's: a
 * call that passed mg/dL gets back what was written. A lab keeps its own.
 */
function rowValue(row: FileMeasurement | FileLabValue): { value: number; unit: string | null; recordedAt: string } {
  return {
    value: row.value,
    unit: 'metricType' in row ? canonicalUnit(row.metricType) : row.unit,
    recordedAt: dayOf(row.recordedAt ?? ''),
  };
}

/** The unit a stored measurement is in — SI canonical, or null off-catalogue. */
function canonicalUnit(metricType: string): string | null {
  return UNIT_DEFS[metricType as MetricType]?.canonical ?? null;
}

/** One line per row written: what it is, what it says, and the id to cite. */
function describe(verb: string, rows: Array<FileMeasurement | FileLabValue>): string {
  return rows
    .map((row) => {
      const name = 'metricType' in row ? row.metricType : row.metricName;
      const unit = 'unit' in row ? ` ${oneLine(row.unit)}` : '';
      return `${verb} ${oneLine(name)} ${row.value}${unit} on ${dayOf(row.recordedAt ?? '')} — row ${oneLine(row.id)}`;
    })
    .join('\n');
}

/**
 * Unit tokens a number can be wearing, longest first so "mmol/mol" is not
 * matched as "mmol/". Read off the unit definitions rather than written out
 * again, so a new metric's unit joins the guard for free. `in` is dropped: it
 * is an English preposition long before it is inches, and "3 in a row" in a bug
 * report is not a health value.
 */
const UNIT_TOKENS = [...new Set(
  Object.values(UNIT_DEFS).flatMap((def) => [def.canonical, def.label.si, def.label.conventional]),
)].filter((unit) => unit !== 'in').sort((a, b) => b.length - a.length);

/** A number wearing one of those units — "2.1 mmol/L", "81 kg", "140 mmHg". */
const VALUE_WITH_UNIT = new RegExp(
  `\\d+(?:[.,]\\d+)?\\s*(?:${UNIT_TOKENS.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9])`,
  'i',
);

/** An issue, as GitHub takes one. Built here; sent by whoever holds a token. */
export interface FeedbackIssue {
  title: string;
  body: string;
  labels: string[];
}

/**
 * Filing, as a capability the surface hands in. The hosted server has a token
 * and a repository; the stdio server has neither, so it passes nothing and the
 * user gets a URL to open. A filer answers in words, never by throwing: an
 * external system that will not take an issue is something the agent should
 * read out, not a fault in us.
 */
export type FeedbackFiler = (issue: FeedbackIssue) => Promise<
  { ok: true; url: string; number: number } | { ok: false; refusal: string }
>;

/** Title as it reads on the issue list: whose report this is, then the report. */
const FEEDBACK_TITLE_PREFIX = '[connector] ';

/**
 * The report as a fenced block. The detail is a model's prose about a user's
 * problem — data, never markup and never instructions — and a fence is the one
 * thing that makes GitHub render it as written: no headings, no images, and no
 * `@name` linking to a person who never asked to be told about this. The fence
 * is longer than the longest run of backticks inside it, so text that is itself
 * about code cannot end it early.
 */
function fenced(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * Everything both surfaces do before anything leaves the machine: strip the
 * text, refuse anything that reads as a health value, and build the issue.
 *
 * The unit match is a cheap backstop, not the control — the tool's description
 * is what keeps a health value out of the text — but it is the last check
 * standing on the hosted path, where nobody reviews the issue before it is
 * public. It stays exactly as it was.
 */
function prepareFeedback(
  request: z.infer<typeof reportFeedbackInput>,
  now: string,
): { ok: false; text: string } | { ok: true; title: string; detail: string; issue: FeedbackIssue } {
  const title = oneLine(request.title).trim();
  const detail = printable(request.detail).trim();
  const found = VALUE_WITH_UNIT.exec(`${title}\n${detail}`)?.[0];
  if (found) {
    return {
      ok: false,
      text: `“${found}” reads as a health value, so nothing was prepared. A report leaves the user’s machine when ` +
        'they submit it: say which tool or screen was wrong and what you expected, not what the record holds.',
    };
  }
  const stamp = `Health Roadmap connector, server ${SERVER_VERSION}, tool layer v${TOOL_LAYER_VERSION}, ${dayOf(now)}`;
  return {
    ok: true,
    title,
    detail,
    issue: {
      title: `${FEEDBACK_TITLE_PREFIX}${title}`.slice(0, MAX_NAME_LENGTH),
      body: `${fenced(detail)}\n\n---\nkind: ${request.kind}\n${stamp}\n` +
        'Filed by the user’s AI assistant through the Health Roadmap connector; no health values are included by policy.',
      labels: ['from-connector', request.kind === 'bug' ? 'bug' : 'enhancement'],
    },
  };
}

/**
 * Prepare a bug report as a prefilled GitHub issue URL — what a surface with no
 * GitHub token can do. It holds no secret, makes no request and writes nothing:
 * the user opens the URL, reads what it says and submits it themselves.
 */
export function reportFeedback(request: z.infer<typeof reportFeedbackInput>, now: string): ToolOutcome {
  const prepared = prepareFeedback(request, now);
  if (!prepared.ok) return { status: 'rejected', text: prepared.text };

  const body = `${prepared.detail}\n\n---\nReported via health-roadmap MCP ${SERVER_VERSION}, tool layer v${TOOL_LAYER_VERSION}, ${dayOf(now)}`;
  const url = `https://github.com/${FEEDBACK_REPO}/issues/new?labels=from-connector,${request.kind}`
    + `&title=${encodeURIComponent(prepared.title)}&body=${encodeURIComponent(body)}`;
  if (url.length > MAX_FEEDBACK_URL_LENGTH) {
    return {
      status: 'rejected',
      text: 'That report is too long to carry in a URL — GitHub would drop the end of it without saying so. ' +
        'Shorten the detail and call again.',
    };
  }
  return {
    status: 'ok',
    text: `${url}\n\nShow the user this link. Ask them to read the title and body first — they must contain no ` +
      'health values, no names and no file paths — and to submit it themselves; it needs a GitHub account. ' +
      'Nothing has been sent anywhere.',
    data: { filed: false, url, kind: request.kind, title: prepared.title },
  };
}

/**
 * File the report, on a surface that can (US-32 AC9). The issue is public and
 * the user does not see it before it exists, so the health-value guard above
 * runs first and the filer is handed nothing but the text it refused to refuse.
 */
export async function fileFeedback(
  request: z.infer<typeof reportFeedbackInput>,
  now: string,
  filer: FeedbackFiler,
): Promise<ToolOutcome> {
  const prepared = prepareFeedback(request, now);
  if (!prepared.ok) return { status: 'rejected', text: prepared.text };

  const result = await filer(prepared.issue);
  if (!result.ok) return { status: 'rejected', text: result.refusal };
  return {
    status: 'ok',
    text: `Filed as ${result.url}. Tell the user their report is in — it is a public issue on the project’s ` +
      'GitHub, carrying their description and nothing about them or their health record.',
    data: { filed: true, url: result.url, number: result.number, kind: request.kind, title: prepared.title },
  };
}

// ---------------------------------------------------------------------------
// The tool surface an MCP client sees
// ---------------------------------------------------------------------------

/** A JSON Schema object, the shape `tools/list` must publish. */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

/**
 * What one call costs the hosted server's hourly write allowance. Stated per
 * tool, never derived from `annotations`: those are HINTS a client may not
 * trust and are tuned for approval prompts, so a kinder prompt must not be
 * able to loosen a security budget (audit C4).
 */
export type ToolCost = 'none' | 'add' | 'correct';

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  cost: ToolCost;
  inputSchema: ToolInputSchema;
  /**
   * The shape of the structured result. Declaring it obliges every OK result to
   * carry `structuredContent` that fits (spec §Output Schema); a refusal is an
   * error result and carries none.
   */
  outputSchema: Omit<ToolInputSchema, 'additionalProperties'> & { additionalProperties?: false };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /**
   * ChatGPT reads these two to say what the call is doing instead of showing a
   * raw tool name. Ignored by every other client, and ≤64 characters each.
   */
  _meta: {
    'openai/toolInvocation/invoking': string;
    'openai/toolInvocation/invoked': string;
  };
}

/** The two ChatGPT strings, in one line per tool instead of four. */
function invocation(invoking: string, invoked: string): McpToolDefinition['_meta'] {
  return { 'openai/toolInvocation/invoking': invoking, 'openai/toolInvocation/invoked': invoked };
}

const DAY_SCHEMA = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

/** The two shapes a record or plan section takes, unexpanded on purpose. */
const OBJECT = { type: 'object' } as const;
const OBJECT_ARRAY = { type: 'array', items: { type: 'object' } } as const;

/** A written row's fields, shared by the three tools that answer with one. */
const ROW_FIELDS = {
  id: { type: 'string', description: 'The row id — cite this to correct the row later.' },
  value: { type: 'number', description: 'The number as stored.' },
  recordedAt: { ...DAY_SCHEMA, description: 'The clinical day the row is filed under.' },
} as const;

/** Every section `readRecord` returns. `reminderOptIn` is the only optional one. */
const RECORD_SECTIONS = {
  schemaVersion: { type: 'number' },
  meta: OBJECT,
  profile: OBJECT,
  measurements: OBJECT_ARRAY,
  medications: OBJECT_ARRAY,
  medicationHistory: OBJECT_ARRAY,
  supplements: OBJECT_ARRAY,
  supplementHistory: OBJECT_ARRAY,
  screenings: OBJECT,
  labValues: OBJECT_ARRAY,
  documents: OBJECT_ARRAY,
  reminderPreferences: OBJECT_ARRAY,
  recommendationSnapshots: OBJECT_ARRAY,
  reminderOptIn: OBJECT,
} as const;

/** Every section `planPayload` builds. All of them are always present. */
const PLAN_SECTIONS = {
  instruction: { type: 'string', description: 'How this plan must be presented. Follow it.' },
  schemaVersion: { type: 'number' },
  generatedAt: { type: 'string' },
  today: { type: 'string' },
  unitSystem: { type: 'string' },
  profile: OBJECT,
  inputs: OBJECT,
  missingInputs: {
    type: 'array',
    items: { type: 'string' },
    description: 'Inputs the record does not hold that would change this plan. Ask the user for these, then add them.',
  },
  currentValues: OBJECT_ARRAY,
  labValues: OBJECT_ARRAY,
  medications: OBJECT,
  screenings: OBJECT,
  due: OBJECT,
  suggestions: OBJECT_ARRAY,
  source: OBJECT,
} as const;

/**
 * The seven tools, as an MCP client lists them. Annotations are HINTS — the
 * spec says a client must not trust them and "always allow" is one click — so
 * they describe the tool honestly rather than standing in for a check: the two
 * reads never write, the two adds only append, and `correct_value` is marked
 * destructive because the row it supersedes is `entered-in-error` for good.
 */
export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'read_record',
    cost: 'none',
    _meta: invocation('Reading your record…', 'Read your record'),
    title: 'Read the health record',
    description:
      'Return the user’s health-roadmap.json: profile, measurements, lab values, medications, supplements, ' +
      'screenings and documents. Rows are never deleted here — a superseded value stays with status ' +
      '"entered-in-error", so read `status: "active"` rows as the current truth. Optionally narrow to one ' +
      'metric or to rows on or after a date. The reminder capability token is never included.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', maxLength: MAX_NAME_LENGTH, description: 'One metric or test name, e.g. "ldl" or "ferritin". Omit for everything.' },
        since: { ...DAY_SCHEMA, description: 'Only rows recorded on or after this day.' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: RECORD_SECTIONS,
      required: Object.keys(RECORD_SECTIONS).filter((key) => key !== 'reminderOptIn'),
      // Open, alone among the tools: `migrateFile` keeps unknown top-level keys,
      // so a record written by a newer app would fail a strict schema on read.
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_plan',
    cost: 'none',
    _meta: invocation('Computing your plan…', 'Computed your plan'),
    title: 'Compute the health plan',
    description:
      'Compute the user’s plan from their record — current values, what screening or test is due, and ' +
      'suggestions with the reason and citations behind each one. This is the app’s own protocol, computed ' +
      'offline from the file; it is educational, not medical advice.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: PLAN_SECTIONS,
      required: Object.keys(PLAN_SECTIONS),
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'add_measurement',
    cost: 'add',
    _meta: invocation('Adding your measurement…', 'Added your measurement'),
    title: 'Add a core measurement',
    description:
      `Append one core-metric measurement (${METRIC_TYPES.join(', ')}). Give the value in SI units, or pass ` +
      '`unit` with the unit it was reported in and it is converted. One value per metric per day: if that day ' +
      'already holds a value the call is refused and you should use correct_value instead.',
    inputSchema: {
      type: 'object',
      properties: {
        metricType: { type: 'string', enum: [...METRIC_TYPES], maxLength: MAX_NAME_LENGTH, description: 'The core metric.' },
        value: { type: 'number', description: 'The number, in SI units unless `unit` says otherwise.' },
        unit: { type: 'string', maxLength: MAX_NAME_LENGTH, description: 'The unit `value` is in, e.g. "mg/dL". Omit if it is already SI.' },
        recordedAt: { ...DAY_SCHEMA, description: 'The user’s local calendar date, YYYY-MM-DD. Ask if you do not know it.' },
      },
      required: ['metricType', 'value', 'recordedAt'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        ...ROW_FIELDS,
        metricType: { type: 'string', description: 'The core metric written.' },
        unit: { type: ['string', 'null'], description: 'The SI unit the value is stored in.' },
      },
      required: ['id', 'metricType', 'value', 'unit', 'recordedAt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'add_lab_values',
    cost: 'add',
    _meta: invocation('Adding your lab results…', 'Added your lab results'),
    title: 'Add lab results',
    description:
      'Append blood tests that are not core metrics (ferritin, TSH, ALT, …) — a whole lab panel in one call, ' +
      `up to ${MAX_LAB_ROWS_PER_CALL} rows. Keep the lab’s own number and unit exactly as reported; nothing is ` +
      'converted. Either every row is written or none is.',
    inputSchema: {
      type: 'object',
      properties: {
        values: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_LAB_ROWS_PER_CALL,
          items: {
            type: 'object',
            properties: {
              metricName: { type: 'string', maxLength: MAX_NAME_LENGTH, description: 'The test name, e.g. "ferritin".' },
              value: { type: 'number', description: 'The lab’s number, unconverted.' },
              unit: { type: 'string', maxLength: MAX_NAME_LENGTH, description: 'The lab’s unit, exactly as reported.' },
              referenceLow: { type: ['number', 'null'], description: 'Lower reference bound, if the report gives one.' },
              referenceHigh: { type: ['number', 'null'], description: 'Upper reference bound, if the report gives one.' },
              recordedAt: { ...DAY_SCHEMA, description: 'The user’s local calendar date, YYYY-MM-DD. Ask if you do not know it.' },
            },
            required: ['metricName', 'value', 'unit', 'recordedAt'],
            additionalProperties: false,
          },
        },
      },
      required: ['values'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          description: 'One entry per row written, in the order they were given.',
          items: {
            type: 'object',
            properties: {
              ...ROW_FIELDS,
              metricName: { type: 'string', description: 'The test name written.' },
              unit: { type: 'string', description: 'The lab’s own unit, unconverted.' },
            },
            required: ['id', 'metricName', 'value', 'unit', 'recordedAt'],
            additionalProperties: false,
          },
        },
      },
      required: ['rows'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'correct_value',
    cost: 'correct',
    _meta: invocation('Correcting that value…', 'Corrected that value'),
    title: 'Correct a recorded value',
    description:
      'Fix a value that was recorded wrongly. This appends a new row with the corrected number and the ' +
      'ORIGINAL date, and marks the old row "entered-in-error" — permanently. Nothing is deleted or ' +
      'overwritten. Read the record first: you need the row id, and passing `expectedValue` makes the call ' +
      'refuse if the row does not hold what you think it holds.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: MAX_ID_LENGTH, description: 'The id of the active row to correct.' },
        newValue: { type: 'number', description: 'The corrected number.' },
        unit: { type: 'string', maxLength: MAX_NAME_LENGTH, description: 'The unit `newValue` is in, for a core metric. A lab value keeps its lab’s unit.' },
        expectedValue: { type: 'number', description: 'The value you believe the row holds now. Mismatch refuses the call.' },
      },
      required: ['id', 'newValue'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        ...ROW_FIELDS,
        correctsId: { type: 'string', description: 'The row now marked "entered-in-error".' },
        metric: { type: 'string', description: 'The metric or test the row is for.' },
        unit: { type: ['string', 'null'], description: 'The unit the corrected value is stored in.' },
      },
      required: ['id', 'correctsId', 'metric', 'value', 'unit', 'recordedAt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'update_profile',
    cost: 'correct',
    _meta: invocation('Updating your profile…', 'Updated your profile'),
    title: 'Change the profile the plan is computed from',
    description:
      'Change who the record is about: sex, birth year, birth month, height in cm. Every suggestion is derived ' +
      'from them, so a wrong one makes the whole plan wrong. Read the record first and pass `expected` with the ' +
      'value you believe each field holds now (null if it holds none) — a mismatch refuses the call and writes ' +
      'nothing. This overwrites: the profile is one last-write-wins object, so unlike a measurement there is no ' +
      'earlier version to read back. Display preferences (units) are not yours to change.',
    inputSchema: {
      type: 'object',
      properties: {
        sex: { type: 'string', enum: ['male', 'female'], description: 'The sex the plan is computed for.' },
        birthYear: { type: 'integer', description: 'Year of birth, e.g. 1971.' },
        birthMonth: { type: 'integer', description: 'Month of birth, 1–12.' },
        heightCm: { type: 'number', description: 'Height in centimetres.' },
        expected: {
          type: 'object',
          description: 'What you believe the record holds now, per field you are changing. `null` claims the field is unset.',
          properties: {
            sex: { type: ['string', 'null'], enum: ['male', 'female', null] },
            birthYear: { type: ['integer', 'null'] },
            birthMonth: { type: ['integer', 'null'] },
            heightCm: { type: ['number', 'null'] },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        changed: {
          type: 'array',
          description: 'Every field that moved. Empty when the record already said that.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', enum: [...PROFILE_FIELDS] },
              from: { type: ['string', 'number', 'null'], description: 'What the record held. `null` if unset.' },
              to: { type: ['string', 'number'], description: 'What it holds now.' },
            },
            required: ['field', 'from', 'to'],
            additionalProperties: false,
          },
        },
      },
      required: ['changed'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'report_feedback',
    cost: 'correct',
    _meta: invocation('Preparing your report…', 'Prepared your report'),
    title: 'File a bug report or feature request',
    description:
      'Report a bug or request a feature for the health-roadmap project. On this server the report is filed for ' +
      'the user as a PUBLIC GitHub issue — say so before you call it, and call it only when they have asked you ' +
      'to. Offer it when a tool refuses something the user reasonably expected, when the record cannot express ' +
      'something they want to track, or when a result looks wrong. Never put health values, dates of results, ' +
      'names or file paths in the title or detail — describe the problem, not the data. A server with no GitHub ' +
      'token instead answers with a link the user opens and submits themselves; the answer says which happened.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['bug', 'feature'], description: 'Something broken, or something missing.' },
        title: { type: 'string', maxLength: MAX_NAME_LENGTH, description: 'One line naming the problem.' },
        detail: { type: 'string', maxLength: 2000, description: 'What happened, what you expected, and the steps — no health values.' },
      },
      required: ['kind', 'title', 'detail'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        filed: { type: 'boolean', description: 'True if the issue now exists. False if the user must submit it.' },
        url: { type: 'string', description: 'The issue, or the prefilled link the user opens.' },
        number: { type: 'integer', description: 'The issue number, when one was filed.' },
        kind: { type: 'string', enum: ['bug', 'feature'] },
        title: { type: 'string' },
      },
      required: ['filed', 'url', 'kind', 'title'],
      additionalProperties: false,
    },
    // Not read-only and open-world: this one leaves the user's own file behind
    // and writes something public on someone else's system. Not destructive —
    // it takes nothing away — and not idempotent: two calls file two issues.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

/**
 * The three starting points a client offers by name (MCP `prompts`). Claude
 * shows a connector's prompts in its own menu, so these are for the person who
 * has connected the record and does not know what to type. Static text: a
 * prompt names a tool, it never carries a value.
 */
export interface McpPrompt {
  name: string;
  title: string;
  /** The words the client puts in the user's message when they pick it. */
  text: string;
}

export const MCP_PROMPTS: McpPrompt[] = [
  {
    name: 'summarise_my_plan',
    title: 'Summarise my plan',
    text: 'Call get_plan, then summarise my plan in plain words — keep its hedged wording and citations — and '
      + 'tell me which inputs it lists as missing.',
  },
  {
    name: 'add_todays_results',
    title: 'Add today’s results',
    text: 'I have blood test results to add. Ask me for the date they were taken and each test with its value and '
      + 'unit, then read my record and add them.',
  },
  {
    name: 'whats_missing',
    title: 'What is missing?',
    text: 'Call get_plan and tell me which inputs my record is missing that would change the plan, and how I could '
      + 'get each one.',
  },
];

/** Zod schema per tool — the argument check `MCP_TOOLS` only describes. */
const INPUTS = {
  read_record: readRecordInput,
  get_plan: getPlanInput,
  add_measurement: addMeasurementInput,
  add_lab_values: addLabValuesInput,
  correct_value: correctValueInput,
  update_profile: updateProfileInput,
  report_feedback: reportFeedbackInput,
} as const;

/** Zod schema per tool result — what `outputSchema` promises, checkable. */
export const OUTPUTS = {
  read_record: readRecordOutput,
  get_plan: getPlanOutput,
  add_measurement: addMeasurementOutput,
  add_lab_values: addLabValuesOutput,
  correct_value: correctValueOutput,
  update_profile: updateProfileOutput,
  report_feedback: reportFeedbackOutput,
} as const;

export type ToolName = keyof typeof INPUTS;

export function isToolName(name: string): name is ToolName {
  return name in INPUTS;
}

/**
 * The tools that read no record. `report_feedback` is one: the likeliest
 * moment to report a bug is the moment the record could not be opened, so the
 * caller must be able to skip opening it. Every other tool needs the file, and
 * gets a refusal it can read out loud when there is none.
 */
export const RECORD_FREE_TOOLS: ReadonlySet<ToolName> = new Set(['report_feedback']);

/**
 * Run one tool call against a record. The arguments are whatever crossed the
 * wire, so they are parsed before anything reads them; a call that does not
 * fit its schema is refused as malformed, and the record is not touched.
 *
 * `file` is absent when the caller has no record open — legitimate only for
 * `RECORD_FREE_TOOLS`. Anything else is refused in words, so a missing record
 * reads to the agent as something the user can fix.
 */
export function callTool(
  name: ToolName,
  args: unknown,
  context: EditContext & { file: RoadmapFile | undefined },
): ToolOutcome {
  const parsed = INPUTS[name].safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { status: 'invalid-args', text: `${name}: ${[issue.path.join('.'), issue.message].filter(Boolean).join(' — ')}` };
  }
  const { file, now } = context;
  if (!file && !RECORD_FREE_TOOLS.has(name)) {
    return { status: 'rejected', text: `${name} needs the health record, and none is open. Check the file path the server was given.` };
  }
  // TS cannot narrow through a Set membership test. Every case below the
  // report_feedback one is a record tool, and the guard just refused those
  // without a record.
  const record = file as RoadmapFile;
  switch (name) {
    case 'report_feedback':
      return reportFeedback(parsed.data as z.infer<typeof reportFeedbackInput>, now);
    case 'read_record':
      return readRecord(record, parsed.data as z.infer<typeof readRecordInput>);
    case 'get_plan':
      return getPlan(record, now);
    case 'add_measurement':
      return addMeasurement(record, parsed.data as z.infer<typeof addMeasurementInput>, context);
    case 'add_lab_values':
      return addLabValues(record, parsed.data as z.infer<typeof addLabValuesInput>, context);
    case 'correct_value':
      return correctValueTool(record, parsed.data as z.infer<typeof correctValueInput>, now);
    case 'update_profile':
      return updateProfile(record, parsed.data as z.infer<typeof updateProfileInput>, now);
  }
}

// ---------------------------------------------------------------------------
// One tool call, over one record
// ---------------------------------------------------------------------------

/** A tool's answer, as MCP carries it: text, plus a flag if it refused. */
export interface ToolAnswer {
  text: string;
  isError: boolean;
  /** The same answer, typed to the tool's `outputSchema`. Absent on a refusal. */
  structured?: unknown;
}

/**
 * That answer as an MCP `tools/call` result payload, which both servers wrap in
 * their own envelope. Declared `outputSchema` obliges an OK result to carry the
 * structured answer too; a refusal is an error result and carries none.
 */
export function toolContent(answer: ToolAnswer): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: answer.text }],
    ...(answer.structured === undefined ? null : { structuredContent: answer.structured }),
    ...(answer.isError ? { isError: true } : null),
  };
}

/** A tool broke its own contract. Not the user's to fix, so never a refusal. */
export class ToolContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolContractError';
  }
}

export interface RunToolOptions {
  /**
   * A guard the surface adds of its own, run on the opened record BEFORE the
   * tool. Return refusal text to stop the call. It comes first so that a
   * refused write still spends what it costs the surface: the hosted server
   * charges its write allowance here, because free guesses at a value an agent
   * does not know ARE the falsification attack (design §3).
   */
  beforeCall?(file: RoadmapFile): string | null;
  /** Appended to a successful save — where the bytes landed. */
  savedNote?(): string;
  /**
   * Lets `report_feedback` actually file the issue. A surface that holds a
   * GitHub token passes one; a surface that does not passes nothing and the
   * tool falls back to the prefilled URL the user submits (US-32 AC9).
   */
  fileFeedback?: FeedbackFiler;
  /**
   * The latest calendar day this surface accepts as not-future. The hosted
   * server, which runs in UTC and cannot know the user's timezone, passes
   * `latestDayOnEarth(now)`; a local surface omits it and gets its own day.
   */
  latestDay?: string;
}

/**
 * Run one tool against the user's record: read fresh (another device or the
 * app itself may have written since the last call), run the tool, and only if
 * the tool produced a new file, save it through `SyncManager` — read, migrate,
 * merge, conditional write, verify. Both MCP servers run these few lines, so
 * neither surface can lose the file in a way the other would not.
 *
 * `RECORD_FREE_TOOLS` are run without opening anything: `report_feedback`
 * never touches the record, and opening it first turned "my record is missing"
 * into a failed bug report.
 *
 * Storage failures are thrown, not worded here: each surface catches them and
 * says them its own way through `describeStorageFailure`.
 */
export async function runToolOverSync(
  sync: SyncManager<RoadmapFile>,
  name: string,
  args: unknown,
  now: string,
  options: RunToolOptions = {},
): Promise<ToolAnswer> {
  if (!isToolName(name)) return { text: `No tool named ${name}.`, isError: true };

  if (RECORD_FREE_TOOLS.has(name)) {
    const filer = name === 'report_feedback' ? options.fileFeedback : undefined;
    const parsed = filer ? reportFeedbackInput.safeParse(args ?? {}) : undefined;
    // A malformed call is worded in one place: `callTool` parses and refuses.
    const outcome = filer && parsed?.success
      ? await fileFeedback(parsed.data, now, filer)
      : callTool(name, args, { file: undefined, now, latestDay: options.latestDay });
    // A file to save with nothing opened would be a write dropped in silence.
    if (outcome.status === 'ok' && outcome.file) {
      throw new ToolContractError(`${name} produced a file without opening one`);
    }
    return outcome.status === 'ok'
      ? { text: outcome.text, isError: false, structured: outcome.data }
      : { text: outcome.text, isError: true };
  }

  const file = await sync.load();
  const refusal = options.beforeCall?.(file);
  if (refusal) return { text: refusal, isError: true };

  const outcome = callTool(name, args, { file, now, latestDay: options.latestDay });
  if (outcome.status !== 'ok') return { text: outcome.text, isError: true };
  if (!outcome.file) return { text: outcome.text, isError: false, structured: outcome.data };

  await sync.save(outcome.file);
  // The note is for the person reading along; the structured answer is the
  // tool's own, and where the bytes landed is not part of what it returns.
  return {
    text: options.savedNote ? `${outcome.text}\n${options.savedNote()}` : outcome.text,
    isError: false,
    structured: outcome.data,
  };
}
