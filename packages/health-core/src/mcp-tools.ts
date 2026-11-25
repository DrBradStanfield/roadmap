/**
 * The nine MCP tools, as pure functions (US-32, US-34, US-35, US-36).
 *
 * `record-edits.ts` holds the rules a write must keep and `plan.ts` holds the
 * derivation; this layer is what an AI assistant is actually offered — nine
 * named tools, their argument schemas, and the words they answer in. It takes
 * a `RoadmapFile` and returns a new one; opening the file, backing it up and
 * putting bytes back on disk belong to the caller (`tools/mcp-server.ts`
 * locally, the hosted server later), so the same tool surface can sit over a
 * local path or a user's cloud folder without changing what a tool means.
 *
 * Nothing here reads the clock, the filesystem or the network.
 */
import { deadlineSignal } from './adapter';
import { isCoreRow, labRowSlot } from './blood-tests';
import { dayOf, localDay } from './merge';
import { labSlotKey } from './lab-catalog';
import { latestActivePerMetric } from './measurement-history';
import { resolveCoreMetricName } from './lab-extraction';
import { computePlan, PlanError, planPayload } from './plan';
import { appendLabValue, appendMeasurement, type EditContext, correctValue } from './record-edits';
import type { FileLabValue, RoadmapFile } from './roadmap-file';
import { CORE_BLOOD_UNITS } from './roadmap-file';
import type { SyncManager } from './sync-manager';
import { CANONICAL_UNITS } from './units';
import { IMPORT_REFUSALS } from './import-hints';
import { type McpRefusalReason } from './product-events';
import { zod3Message } from './validation';
import * as z from './zod';
import { readableView } from './readable-rows';
import {
  addLabValuesInput,
  addLabValuesOutput,
  addMeasurementInput,
  addMeasurementOutput,
  correctValueInput,
  correctValueOutput,
  describe,
  fileResultsInput,
  getPlanInput,
  getPlanOutput,
  type ImportCommit,
  importDocumentsInput,
  importDocumentsOutput,
  readRecordInput,
  readRecordOutput,
  reportFeedbackInput,
  reportFeedbackOutput,
  rowValue,
  ToolContractError,
  type ToolOutcome,
  updateProfileInput,
  updateProfileOutput,
} from './mcp-tool-contract';
import { type FeedbackFiler, fileFeedback, reportFeedback } from './mcp-feedback';
import { extractNext, fitReceipt, importDocumentsCommit, type ImportSurface, type ImportTool, prepareImport } from './mcp-import';
import { MCP_TOOLS } from './mcp-tool-catalogue';
import { batchRejection, rejection } from './mcp-refusals';
import { updateProfile } from './profile-edits';

/** Per-row sync bookkeeping and device identifiers: the merge's, never what the record says. */
const BOOKKEEPING = ['createdAt', 'updatedAt', 'lamport', 'fieldStamps', 'externalId'] as const;
type Plain<T> = Omit<T, (typeof BOOKKEEPING)[number]>;

function plain<T extends object>(row: T): Plain<T> {
  const copy = { ...row } as Record<string, unknown>;
  for (const key of BOOKKEEPING) delete copy[key];
  return copy as Plain<T>;
}

/**
 * The record an assistant reads (US-32 AC41): what it says, and nothing it
 * needs only to sync. `meta` is clocks and a device id; the reminder opt-in
 * holds a capability token that can cancel someone's reminders (agent-access
 * rule 12) and an email address; reminder settings, recommendation
 * snapshots and the erase list (`erasedRows`, US-09 AC23) are the app's own,
 * and so is `profile.reportEmailCaptured`. Row
 * ids stay, because `correct_value` takes them. Each measurement and lab row
 * says whether it is `current`: the row the plan counts for its metric, by the
 * plan's own rule, so two active rows in one slot never leave a reader guessing
 * without `createdAt`. A deleted document is gone, text and all. Always a copy:
 * the caller must never be holding the store's own object.
 */
export function redactRecord(file: RoadmapFile) {
  const {
    meta: _meta, reminderOptIn: _optIn, reminderPreferences: _prefs, recommendationSnapshots: _snapshots, erasedRows: _erased,
    profile, screenings, measurements, labValues, medications, medicationHistory, supplements, supplementHistory, documents, ...rest
  } = file;
  const { reportEmailCaptured: _emailFlag, ...shownProfile } = plain(profile);
  // By position, never by id: a reused id must not make a second row current.
  const currentMeasurements = new Set(latestActivePerMetric(measurements.map((m, at) => ({ ...m, at }))).map((r) => r.at));
  // A core row counts only in its core unit, as the plan reads it (US-66 AC7).
  const counted = labValues.flatMap((l, at) => (isCoreRow(l) && l.unit !== CORE_BLOOD_UNITS[l.metricName] ? [] : [{ ...l, metricType: labRowSlot(l), at }]));
  const currentLabs = new Set(latestActivePerMetric(counted).map((r) => r.at));
  return {
    ...rest,
    profile: shownProfile,
    screenings: plain(screenings),
    measurements: measurements.map((row, at) => ({ ...plain(row), current: currentMeasurements.has(at) })),
    labValues: labValues.map((row, at) => ({ ...plain(row), current: currentLabs.has(at) })),
    medications: medications.map(plain),
    // A history row's `updatedAt` is when the change happened: the user's own history, so it stays.
    medicationHistory: medicationHistory.map((row) => ({ ...plain(row), updatedAt: row.updatedAt })),
    supplements: supplements.map(plain),
    supplementHistory: supplementHistory.map((row) => ({ ...plain(row), updatedAt: row.updatedAt })),
    documents: documents.filter((d) => !d.deleted).map(({ id, title, type, date, sourceFileName, extractedText }) =>
      ({ id, title, type, date, sourceFileName: sourceFileName ?? null, extractedText })),
  };
}

function matchesMetric(name: string, query: string): boolean {
  return name.toLowerCase() === query || resolveCoreMetricName(name) === query || labSlotKey(name) === query;
}

/**
 * The record as JSON, filtered. `metric` narrows the two value arrays to one
 * test — by core metric name or catalogue key, so "LDL-C" and `ldl`, or
 * "Gamma GT" and `ggt`, are the same question —
 * and `since` drops rows recorded before that day. Everything else (profile,
 * medications, supplements, screenings, documents) comes back whole: a filter
 * that silently hid a medication would make the plan unreadable.
 */
export function readRecord(file: RoadmapFile, request: z.infer<typeof readRecordInput>): ToolOutcome {
  const record = redactRecord(file);
  const metric = request.metric ? resolveCoreMetricName(request.metric) ?? labSlotKey(request.metric) : undefined;
  const since = request.since;
  const keep = (row: { recordedAt?: string | null }) => !since || dayOf(row.recordedAt ?? '') >= since;

  const filtered = {
    ...record,
    measurements: record.measurements.filter((m) => (!metric || matchesMetric(m.metricType, metric)) && keep(m)),
    labValues: record.labValues.filter((l) => (!metric || matchesMetric(l.metricName, metric)) && keep(l)),
    // A question about one metric is not a question about the user's documents,
    // and a lab PDF's row list is the biggest thing in the record.
    documents: metric ? [] : record.documents,
    // The rows carry a bare number, so the read says what those numbers are in.
    units: CANONICAL_UNITS,
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
 * What a surface's own guard refuses with: the words the assistant reads, and
 * the word the counter files it under.
 */
export interface GuardRefusal {
  text: string;
  reason: McpRefusalReason;
}

/**
 * A non-ok outcome as the answer the surfaces return. One place, so the counter
 * cannot learn a reason at one call site and lose it at the next.
 */
function refusalAnswer(outcome: Exclude<ToolOutcome, { status: 'ok' }>): ToolAnswer {
  const reason = outcome.status === 'invalid-args' ? 'malformed' : (outcome.reason ?? 'other');
  return { text: outcome.text, isError: true, reason };
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
    data: { id: row.id, metricType: 'metricType' in row ? row.metricType : row.metricName, ...rowValue(row) },
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
    if (!result.ok) return batchRejection(result, index, value.metricName, rows);
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
  if (!result.ok) {
    const refused = rejection(result);
    // A correction with no target is not a request to add (live ChatGPT 2026-09-07: it offered add_measurement unasked).
    return result.reason === 'not-found' ? { ...refused, text: `${refused.text} Do not add it instead unless the user asks.` } : refused;
  }
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
 * Both phases over one record: the surface reads and parks, the tool layer
 * slots and applies. The extract runs the loop's `beforeCall` like any write
 * (the hosted server charges the call there); the commit does not — its
 * surface verifies the receipt first and charges after.
 */
async function runImport(
  sync: SyncManager<RoadmapFile>,
  name: ToolName,
  imports: ImportTool,
  args: unknown,
  now: string,
  options: RunToolOptions,
  surface: ImportSurface,
): Promise<ToolAnswer> {
  // A ChatGPT tool list cached before 2026-09-07 still hands a dropped file to
  // `file`. The route it fed was deleted 2026-09-10 (US-36 AC12), so this line
  // is the whole of it: one sentence, and no code behind it that reads a file.
  if (name === 'import_documents' && typeof args === 'object' && args !== null && 'file' in args) {
    return { text: IMPORT_REFUSALS.refresh, isError: true, reason: 'import' };
  }
  const parsed = parseArgs(name, args);
  // A malformed call is worded from the table, never as a raw schema message (AC13).
  if (!parsed.ok) return { text: IMPORT_REFUSALS[imports.malformed(parsed.path)], isError: true, reason: 'import' };
  const request = parsed.data as { commit?: ImportCommit };
  if (request.commit && imports.hasSource(parsed.data)) {
    return { text: `${name}: pass commit on its own, without a source. Nothing was written.`, isError: true, reason: 'import' };
  }
  const short = request.commit ? null : imports.incomplete(parsed.data);
  if (short) return { text: short, isError: true, reason: 'import' };
  // One clock for the call: the record's own read and write are I/O too (AC5).
  const deadline = Date.now() + surface.budgetMs;
  const signal = deadlineSignal(deadline);
  const file = await sync.load(signal);
  const latestDay = options.latestDay ?? localDay(now);

  if (request.commit) {
    const opened = await surface.open(request.commit, file, now, deadline);
    if ('refusal' in opened) return { text: opened.refusal, isError: true, reason: 'import' };
    const outcome = importDocumentsCommit(file, opened, request.commit, now, surface.client);
    if (outcome.status !== 'ok') return refusalAnswer(outcome);
    const saved = outcome.file ? await sync.save(outcome.file, signal) : null;
    await surface.discard(opened, deadline);
    return {
      text: saved && options.savedNote ? `${outcome.text}\n${options.savedNote(saved.warning)}` : outcome.text,
      isError: false,
      structured: outcome.data,
    };
  }

  const refusal = options.beforeCall?.(file);
  if (refusal) return { ...refusal, isError: true };
  const bundle = await imports.bundle(parsed.data, file, surface, { now, latestDay, deadline });
  if ('refusal' in bundle) return { text: bundle.refusal, isError: true, reason: 'import' };
  const fits = fitReceipt(bundle, { now, latestDay });
  // One name per ZIP, however many of its members wait or ran out of time.
  const remaining = [...new Set([...fits.deferred, ...bundle.remaining])];
  const prepared = prepareImport(file, fits.bundle, { now, latestDay, maxCorrectionAgeDays: surface.maxCorrectionAgeDays, payloadId: crypto.randomUUID() });
  const data: z.infer<typeof importDocumentsOutput> = {
    phase: 'extracted', route: bundle.route, files: prepared.files, candidates: prepared.payload.candidates,
    documents: prepared.payload.documents.map(({ sourceFileName, title, summary, type, date }) => ({ sourceFileName, title, ...(summary ? { summary } : null), type, date })),
    unrecognized: prepared.unrecognized, remaining,
    next: extractNext(prepared, remaining, bundle.route),
  };
  if (prepared.payload.candidates.length || prepared.payload.documents.length) {
    const stashed = await surface.stash(prepared.payload, deadline);
    if ('refusal' in stashed) return { text: stashed.refusal, isError: true, reason: 'import' };
    data.receipt = stashed.receipt;
    data.receiptExpiresAt = stashed.expiresAt;
  }
  return { text: JSON.stringify(data), isError: false, structured: data };
}

/** Zod schema per tool — the argument check `MCP_TOOLS` only describes. */
const INPUTS = {
  read_record: readRecordInput,
  get_plan: getPlanInput,
  add_measurement: addMeasurementInput,
  add_lab_values: addLabValuesInput,
  correct_value: correctValueInput,
  update_profile: updateProfileInput,
  report_feedback: reportFeedbackInput,
  import_documents: importDocumentsInput,
  file_results: fileResultsInput,
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
  import_documents: importDocumentsOutput,
  file_results: importDocumentsOutput,
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
export const RECORD_FREE_TOOLS: ReadonlySet<ToolName> = new Set(
  MCP_TOOLS.filter((tool) => tool.run === 'record-free').map((tool) => tool.name as ToolName),
);
const RUN_MODE = new Map(MCP_TOOLS.map((tool) => [tool.name, tool.run]));
const IMPORTS = new Map(MCP_TOOLS.flatMap((tool) => (tool.imports ? [[tool.name, tool.imports] as const] : [])));

/** The one argument gate: every path a call takes parses here, so a malformed call is worded once. */
function parseArgs<N extends ToolName>(name: N, args: unknown): { ok: true; data: z.infer<(typeof INPUTS)[N]> } | { ok: false; path: string; text: string } {
  const parsed = INPUTS[name].safeParse(args ?? {}, { error: zod3Message });
  if (parsed.success) return { ok: true, data: parsed.data as z.infer<(typeof INPUTS)[N]> };
  const issue = parsed.error.issues[0];
  return { ok: false, path: String(issue.path[0] ?? ''), text: `${name}: ${[issue.path.join('.'), issue.message].filter(Boolean).join(' — ')}` };
}

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
  context: EditContext & { file: RoadmapFile | undefined; dryRun?: boolean; canFile?: boolean },
): ToolOutcome {
  const parsed = parseArgs(name, args);
  if (!parsed.ok) return { status: 'invalid-args', text: parsed.text };
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
      return reportFeedback(parsed.data as z.infer<typeof reportFeedbackInput>, now, context.dryRun, context.canFile);
    // The read tools see only what this build reads; the rest stays in the file (US-65 AC3).
    case 'read_record':
      return readRecord(readableView(record).file, parsed.data as z.infer<typeof readRecordInput>);
    case 'get_plan':
      return getPlan(readableView(record).file, now);
    case 'add_measurement':
      return addMeasurement(record, parsed.data as z.infer<typeof addMeasurementInput>, context);
    case 'add_lab_values':
      return addLabValues(record, parsed.data as z.infer<typeof addLabValuesInput>, context);
    case 'correct_value':
      return correctValueTool(record, parsed.data as z.infer<typeof correctValueInput>, now);
    case 'update_profile':
      return updateProfile(record, parsed.data as z.infer<typeof updateProfileInput>, now);
    case 'import_documents':
    case 'file_results':
      // Both run through `RunToolOptions.importer`; reached here, the caller passed none.
      return { status: 'rejected', reason: 'import', text: `${name} needs a server that can hold a pending import between two calls, and this call has none. Nothing was written.` };
  }
}

// ---------------------------------------------------------------------------
// One tool call, over one record
// ---------------------------------------------------------------------------

/** A tool's answer, as MCP carries it: text, plus a flag if it refused. */
export interface ToolAnswer {
  text: string;
  isError: boolean;
  /**
   * Why it was refused, for the counter only (US-32 AC29). Never shown to the
   * user, who gets `text`. Absent on an OK answer, and absent on a refusal the
   * vocabulary does not name, which the surface counts as `other`.
   */
  reason?: McpRefusalReason;
  /** The same answer, typed to the tool's `outputSchema`. Absent on a refusal. */
  structured?: unknown;
  /** A `dryRun` that would have written: the file is not saved, and the text says what would have been. */
  pendingWrite?: true;
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

export interface RunToolOptions {
  /**
   * A guard the surface adds of its own, run on the opened record BEFORE the
   * tool. Return refusal text to stop the call. It comes first so that a
   * refused write still spends what it costs the surface: the hosted server
   * charges its write allowance here, because free guesses at a value an agent
   * does not know ARE the falsification attack (design §3).
   */
  beforeCall?(file: RoadmapFile): GuardRefusal | null;
  /** Appended to a successful save — where the bytes landed, and the adapter's warning. */
  savedNote?(warning?: string): string;
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
  /**
   * Where a pending import waits between its two calls (US-35, US-36). The
   * hosted server's can also READ folder files (`extract`); the stdio
   * server's is held in process memory and cannot, so `file_results` runs
   * there and `import_documents` refuses in words (AC11).
   */
  importer?: ImportSurface;
  /**
   * Run the tool and answer as it would, but save NOTHING (US-36 AC9): the
   * hosted server's first call of a two-phase write. `pendingWrite` on the
   * answer says a save was skipped. A record-free tool is run tokenless, so
   * nothing leaves the machine either.
   */
  dryRun?: boolean;
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
  if (!isToolName(name)) return { text: `No tool named ${name}.`, isError: true, reason: 'malformed' };

  if (RUN_MODE.get(name) === 'record-free') {
    const filer = name === 'report_feedback' && !options.dryRun ? options.fileFeedback : undefined;
    const parsed = filer ? parseArgs('report_feedback', args) : undefined;
    // A malformed call is worded in one place: `callTool` parses and refuses.
    const outcome = filer && parsed?.ok
      ? await fileFeedback(parsed.data, now, filer)
      : callTool(name, args, { file: undefined, now, latestDay: options.latestDay, dryRun: options.dryRun, canFile: Boolean(options.fileFeedback) });
    // A file to save with nothing opened would be a write dropped in silence.
    if (outcome.status === 'ok' && outcome.file) {
      throw new ToolContractError(`${name} produced a file without opening one`);
    }
    return outcome.status === 'ok'
      ? { text: outcome.text, isError: false, structured: outcome.data, ...(options.dryRun ? { pendingWrite: true } : null) }
      : refusalAnswer(outcome);
  }

  const imports = IMPORTS.get(name);
  if (imports && options.importer) return runImport(sync, name, imports, args, now, options, options.importer);

  const file = await sync.load();
  const refusal = options.beforeCall?.(file);
  if (refusal) return { ...refusal, isError: true };

  const outcome = callTool(name, args, { file, now, latestDay: options.latestDay });
  if (outcome.status !== 'ok') return refusalAnswer(outcome);
  if (!outcome.file) return { text: outcome.text, isError: false, structured: outcome.data };
  // The rows the text names were never saved: the write that follows assigns its own ids.
  if (options.dryRun) return { text: `${outcome.text}\n(Row ids are assigned when it is written.)`, isError: false, structured: outcome.data, pendingWrite: true };

  const saved = await sync.save(outcome.file);
  // The note is for the person reading along; the structured answer is the
  // tool's own, and where the bytes landed is not part of what it returns.
  return {
    text: options.savedNote ? `${outcome.text}\n${options.savedNote(saved.warning)}` : outcome.text,
    isError: false,
    structured: outcome.data,
  };
}
