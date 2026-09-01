/**
 * The six MCP tools, as pure functions (US-32).
 *
 * `record-edits.ts` holds the rules a write must keep and `plan.ts` holds the
 * derivation; this layer is what an AI assistant is actually offered — five
 * named tools, their argument schemas, and the words they answer in. It takes
 * a `RoadmapFile` and returns a new one; opening the file, backing it up and
 * putting bytes back on disk belong to the caller (`tools/mcp-server.ts`
 * locally, the hosted server later), so the same tool surface can sit over a
 * local path or a user's cloud folder without changing what a tool means.
 *
 * Nothing here reads the clock, the filesystem or the network.
 */
import { dayOf } from './merge';
import { resolveLabCatalogEntry } from './lab-catalog';
import { computePlan, oneLine, PlanError, printable, renderJson } from './plan';
import {
  appendLabValue,
  appendMeasurement,
  correctValue,
  type EditRejection,
} from './record-edits';
import type { FileLabValue, FileMeasurement, FileReminderOptIn, RoadmapFile } from './roadmap-file';
import type { SyncManager } from './sync-manager';
import { UNIT_DEFS } from './units';
import { METRIC_TYPES } from './validation';
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
const FEEDBACK_REPO = 'DrBradStanfield/roadmap';

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
  recordedAt: DAY.optional(),
}).strict();

/** One row of a panel. Exported so the parity test can read the nested shape. */
export const labValueInput = z.object({
  metricName: z.string().min(1).max(MAX_NAME_LENGTH),
  value: z.number().finite(),
  unit: z.string().min(1).max(MAX_NAME_LENGTH),
  referenceLow: z.number().finite().nullable().optional(),
  referenceHigh: z.number().finite().nullable().optional(),
  recordedAt: DAY.optional(),
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

export const reportFeedbackInput = z.object({
  kind: z.enum(['bug', 'feature']),
  title: z.string().min(1).max(MAX_NAME_LENGTH),
  detail: z.string().min(1).max(2000),
}).strict();

/**
 * What a tool call did. `rejected` is a refusal the agent should read and act
 * on — a taken slot, a value out of range — and nothing was written;
 * `invalid-args` is a malformed call, which is the protocol's problem, not the
 * record's. Only `ok` with a `file` asks the caller to save anything.
 */
export type ToolOutcome =
  | { status: 'ok'; text: string; file?: RoadmapFile }
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

/** The stable name a test is filed under, so one spelling finds the other. */
function slotKey(name: string): string {
  return resolveLabCatalogEntry(name)?.key ?? name.trim().toLowerCase();
}

function matchesMetric(name: string, query: string): boolean {
  return name.toLowerCase() === query || slotKey(name) === query;
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
  const metric = request.metric ? slotKey(request.metric) : undefined;
  const since = request.since;
  const keep = (row: { recordedAt?: string | null }) => !since || dayOf(row.recordedAt ?? '') >= since;

  const filtered: RedactedRecord = {
    ...record,
    measurements: record.measurements.filter((m) => (!metric || matchesMetric(m.metricType, metric)) && keep(m)),
    labValues: record.labValues.filter((l) => (!metric || matchesMetric(l.metricName, metric)) && keep(l)),
  };
  return { status: 'ok', text: JSON.stringify(filtered, null, 2) };
}

/** The plan, in the same JSON shape `get-plan.ts --json` prints (US-30 AC3). */
export function getPlan(file: RoadmapFile, now: string): ToolOutcome {
  try {
    return { status: 'ok', text: renderJson(computePlan(file, new Date(now))) };
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

/** One core metric, SI canonical, validated by health-core. */
export function addMeasurement(
  file: RoadmapFile,
  request: z.infer<typeof addMeasurementInput>,
  now: string,
): ToolOutcome {
  const result = appendMeasurement(file, { ...request, now });
  if (!result.ok) return rejection(result);
  return { status: 'ok', file: result.file, text: describe('Added', [result.row]) };
}

/**
 * A batch of non-core lab values — the lab-report case, which is the point of
 * the tool. All or nothing: the first rejection stops the call and NOTHING is
 * written, so a half-imported panel never has to be told apart from a whole one.
 */
export function addLabValues(
  file: RoadmapFile,
  request: z.infer<typeof addLabValuesInput>,
  now: string,
): ToolOutcome {
  let next = file;
  const rows: FileLabValue[] = [];
  for (const [index, value] of request.values.entries()) {
    const result = appendLabValue(next, { ...value, now });
    if (!result.ok) {
      const refusal = rejection(result);
      return { ...refusal, text: `values[${index}] (${oneLine(value.metricName)}): ${refusal.text} No row from this call was written.` };
    }
    next = result.file;
    rows.push(result.row);
  }
  return { status: 'ok', file: next, text: describe('Added', rows) };
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
  return { status: 'ok', file: result.file, text: describe('Corrected', [result.row]) };
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

/**
 * Prepare a bug report or feature request as a prefilled GitHub issue URL. It
 * holds no secret, makes no request and writes nothing: the user opens the URL,
 * reads what it says and submits it themselves. That review is the real control
 * on what leaves their machine — the tool's description is what keeps a health
 * value out of the text, and the unit match below is only a cheap backstop.
 */
export function reportFeedback(request: z.infer<typeof reportFeedbackInput>, now: string): ToolOutcome {
  const title = oneLine(request.title).trim();
  const detail = printable(request.detail).trim();
  const found = VALUE_WITH_UNIT.exec(`${title}\n${detail}`)?.[0];
  if (found) {
    return {
      status: 'rejected',
      text: `“${found}” reads as a health value, so nothing was prepared. A report leaves the user’s machine when ` +
        'they submit it: say which tool or screen was wrong and what you expected, not what the record holds.',
    };
  }

  const body = `${detail}\n\n---\nReported via health-roadmap MCP ${SERVER_VERSION}, tool layer v${TOOL_LAYER_VERSION}, ${dayOf(now)}`;
  const url = `https://github.com/${FEEDBACK_REPO}/issues/new?labels=agent-feedback,${request.kind}`
    + `&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
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

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const DAY_SCHEMA = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

/**
 * The six tools, as an MCP client lists them. Annotations are HINTS — the
 * spec says a client must not trust them and "always allow" is one click — so
 * they describe the tool honestly rather than standing in for a check: the two
 * reads never write, the two adds only append, and `correct_value` is marked
 * destructive because the row it supersedes is `entered-in-error` for good.
 */
export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'read_record',
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_plan',
    title: 'Compute the health plan',
    description:
      'Compute the user’s plan from their record — current values, what screening or test is due, and ' +
      'suggestions with the reason and citations behind each one. This is the app’s own protocol, computed ' +
      'offline from the file; it is educational, not medical advice.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'add_measurement',
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
        recordedAt: { ...DAY_SCHEMA, description: 'The clinical date. Defaults to today; a future date is refused.' },
      },
      required: ['metricType', 'value'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'add_lab_values',
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
              recordedAt: { ...DAY_SCHEMA, description: 'The clinical date. Defaults to today.' },
            },
            required: ['metricName', 'value', 'unit'],
            additionalProperties: false,
          },
        },
      },
      required: ['values'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'correct_value',
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
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'report_feedback',
    title: 'Prepare a bug report or feature request',
    description:
      'Prepare a bug report or feature request for the health-roadmap project as a prefilled GitHub issue URL. ' +
      'Offer this when a tool refuses something the user reasonably expected, when the record cannot express ' +
      'something they want to track, or when a result looks wrong. Never put health values, dates of results, ' +
      'names or file paths in the title or detail — describe the problem, not the data — and note that nothing ' +
      'is submitted here: the user opens the URL, reviews the text and files it themselves with a GitHub account.',
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** Zod schema per tool — the argument check `MCP_TOOLS` only describes. */
const INPUTS = {
  read_record: readRecordInput,
  get_plan: getPlanInput,
  add_measurement: addMeasurementInput,
  add_lab_values: addLabValuesInput,
  correct_value: correctValueInput,
  report_feedback: reportFeedbackInput,
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
  context: { file: RoadmapFile | undefined; now: string },
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
      return addMeasurement(record, parsed.data as z.infer<typeof addMeasurementInput>, now);
    case 'add_lab_values':
      return addLabValues(record, parsed.data as z.infer<typeof addLabValuesInput>, now);
    case 'correct_value':
      return correctValueTool(record, parsed.data as z.infer<typeof correctValueInput>, now);
  }
}

// ---------------------------------------------------------------------------
// One tool call, over one record
// ---------------------------------------------------------------------------

/** A tool's answer, as MCP carries it: text, plus a flag if it refused. */
export interface ToolAnswer {
  text: string;
  isError: boolean;
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
    const outcome = callTool(name, args, { file: undefined, now });
    // A file to save with nothing opened would be a write dropped in silence.
    if (outcome.status === 'ok' && outcome.file) {
      throw new ToolContractError(`${name} produced a file without opening one`);
    }
    return { text: outcome.text, isError: outcome.status !== 'ok' };
  }

  const file = await sync.load();
  const refusal = options.beforeCall?.(file);
  if (refusal) return { text: refusal, isError: true };

  const outcome = callTool(name, args, { file, now });
  if (outcome.status !== 'ok') return { text: outcome.text, isError: true };
  if (!outcome.file) return { text: outcome.text, isError: false };

  await sync.save(outcome.file);
  return { text: options.savedNote ? `${outcome.text}\n${options.savedNote()}` : outcome.text, isError: false };
}
