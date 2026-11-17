// The engine the iOS app runs in JavaScriptCore (ios/architecture.md D2).
// The same health-core the web runs; this file only gives Swift a
// string-in, string-out door, because JSON is the one shape both sides share.
// Its door list is bridge-contract.json; bridge.test.ts holds the two together.
import { mergeFiles } from '../../packages/health-core/src/merge';
import { isCalendarDay } from '../../packages/health-core/src/measurement-history';
import { computePlan, PlanError, type Plan } from '../../packages/health-core/src/plan';
import { CURRENT_SCHEMA_VERSION } from '../../packages/health-core/src/roadmap-file';
import { planSections, topicSections, type PlanSection, type TopicLayout } from '../../packages/health-core/src/plan-sections';
import { statTiles, type StatTile } from '../../packages/health-core/src/stat-tiles';
import { cmToFeetInches, formatDisplayValue, fromCanonicalValue, toCanonicalValue, UNIT_DEFS, type MetricType, type UnitSystem } from '../../packages/health-core/src/units';
import { fileNameLine, labSearch, MAX_FILE_NAME_LENGTH, zipMemberName } from '../../packages/health-core/src/lab-extraction';
import { deviceWrites } from '../../packages/health-core/src/device-export';
import { usProductSections, type UsPlanSection } from '../../packages/health-core/src/us-products';
import { applyEdit, movedRecord, myData, newRecord, parseEdit, readNumber, readRecord, readView } from './my-data';
import { derivedHistory, labHistory, metricHistory } from './my-data-forms';
import { chatEditsPreview } from './chat-edits';
import { readUnitChoices } from './unit-choices';
import { phoneReminders } from './reminders';
import { installShim, type Natives } from './shim';
import { eraseHeld, NOT_OPEN, open } from './cloud';
import { failed } from './cloud-adapters';
import { StorageError } from '../../packages/health-core/src/adapter';
import { documentShelf } from './documents';
import { fileVerdict, UPLOAD_LIMITS, zipMemberVerdict } from '../../packages/health-core/src/upload-rules';
import { checkArgs } from './contract';
import { labReviewGroups } from './lab-review-groups';
import { uploadPlanOf, uploadStart, uploadStep, uploadUsage, uploadViewOf } from './upload-doors';
import { uploadSaveRun, type OriginalReader } from './upload-save-door';
import type { Extraction } from './lab-review';

// The web APIs the cloud adapters need, over Swift's natives (shim.ts). Absent
// in Node, where the parity goldens run the bundle with nothing but ECMAScript.
declare const __native: Natives | undefined;
if (typeof __native !== 'undefined') installShim(globalThis as unknown as Record<string, unknown>, __native);

// Over-the-air updates (ios/architecture.md D3, US-25 AC18). The build stamps
// the version (scripts/build-engine.mjs); the app checks both against the
// signed manifest before it trusts a downloaded engine.
declare const __ENGINE_VERSION__: number | undefined;
/** This bundle's version, UTC yyyymmddHHMM; 0 when run from source. */
export const engineVersion: number = typeof __ENGINE_VERSION__ === 'number' ? __ENGINE_VERSION__ : 0;
/** The record schema this engine writes; an update may never change it (D3). */
export const schemaVersion: number = CURRENT_SCHEMA_VERSION;

/** health-core's merge of two records, as JSON: the app's self-test runs it on a
 *  downloaded engine before trusting it (rows kept, entered-in-error sticky, the
 *  higher eraseEpoch). */
export function mergeJson(localJson: string, remoteJson: string, nowIso: string, deviceId: string): string {
  checkArgs('mergeJson', arguments);
  const ctx = { deviceId, now: nowIso };
  return JSON.stringify(mergeFiles(readRecord(localJson, nowIso, deviceId), readRecord(remoteJson, nowIso, deviceId), ctx));
}

// Cloud sync (cloud.ts): cloudOpen, cloudRefresh, cloudFlush, cloudClose, cloudErase and
// documentSave answer a Promise; the rest answer at once.
export { cloudClose, cloudEdit, cloudErase, cloudLabImport, cloudFlush, cloudHidden, cloudOpen, cloudRefresh, cloudVisible } from './cloud';
export { documentSave } from './cloud-documents';
// "Delete all my data" on the phone's own file (erase.ts); a cloud's is cloudErase.
export { erasePhoneJson } from './erase';
/** The `sourceFileName` of each file read, as JSON (US-52 AC13d): the document
 *  dedup key, by health-core's own rules, one call per read. A ZIP member
 *  (`{ zip, path }`) by zipMemberName, the web's rule and cap; any other file
 *  (`{ name }`) on one line and cut to the cap, as the connector stores one. */
export function fileNamesJson(filesJson: string): string {
  checkArgs('fileNamesJson', arguments);
  const files = JSON.parse(filesJson) as Array<{ name: string } | { zip: string; path: string }>;
  return JSON.stringify(files.map((f) => ('zip' in f ? zipMemberName(f.zip, f.path) : fileNameLine(f.name).slice(0, MAX_FILE_NAME_LENGTH))));
}

/** The plan for a record, as JSON. `nowIso` is passed in so tests can pin it. `unitsJson`,
 *  here and on the doors below: the phone's per-test units (unit-choices.ts); an app older
 *  than them sends nothing, and every metric shows in the record's units. */
export function planJson(recordJson: string, nowIso: string, deviceId: string, unitsJson?: string): string {
  checkArgs('planJson', arguments);
  return JSON.stringify(computePlan(readView(recordJson, nowIso, deviceId), new Date(nowIso), readUnitChoices(unitsJson)));
}

/** A plan's on-screen layout, as JSON: the web's results panel uses the same function. */
export function sectionsJson(planJsonText: string): string {
  checkArgs('sectionsJson', arguments);
  const plan = JSON.parse(planJsonText) as Plan;
  return JSON.stringify(planSections(plan.results.suggestions));
}

// The My data tab (my-data.ts). A record from disk is read as the plan's is,
// migrated, so a record the web wrote in an older shape reads the same.

/** A first-launch record, as JSON. */
export function newRecordJson(nowIso: string, deviceId: string, locale: string, timeZone: string): string {
  checkArgs('newRecordJson', arguments);
  return JSON.stringify(newRecord(nowIso, deviceId, locale, timeZone));
}

/** What the app shows for a record, as JSON: `{myData, plan}`, from one read and one
 *  computePlan, so My data and the Plan tab always show the same record (US-25 AC2).
 *  `plan` is `{sections, tiles, ms}`: the layout sectionsJson gives and the summary tiles
 *  above it, the web's Quick Stats (health-core stat-tiles.ts, US-25 AC22), in the
 *  phone's per-test units, and the milliseconds from computePlan through the tiles and the
 *  layout (D2's plan budget; whole ms, the engine's only clock). A tile that cannot be drawn never
 *  blanks the plan (adversary R7): no tiles instead. A record that cannot be planned gives
 *  `{error, planError}`, `planError` true for health-core's PlanError (no usable height; a
 *  record with no sex is planned without the parts that need it, US-07 AC8), and never blanks My data. My data that cannot be drawn throws the whole call.
 *  `isUS`: the App Store storefront is the US (US-61). `plan.usProducts` is then the sections
 *  ready to draw with Dr Brad's products on the supplement cards of a known adult
 *  (us-products.ts, the web's own overlay); left out when none shows. Anything but `true`,
 *  an app older than it included, gives none.
 *  `movedRecord`: the record as text, when reading `recordJson` moved its blood tests into
 *  one table (US-66 AC14); the app writes it to the phone's file once, as it opens it. Left
 *  out when nothing moved, so the written record never gives it again.
 *  `plan.topics`: the same cards by topic for My health (health-core topicSections, US-73 AC3),
 *  from `usProducts` when it shows, else `sections`, placed against My data's own questions. */
export function screenJson(recordJson: string, nowIso: string, deviceId: string, unitsJson?: string, isUS?: boolean): string {
  checkArgs('screenJson', arguments);
  const file = readView(recordJson, nowIso, deviceId);
  const choices = readUnitChoices(unitsJson);
  let plan: Plan | null = null;
  let view: { sections: PlanSection[]; tiles: StatTile[]; usProducts?: UsPlanSection[]; topics?: TopicLayout; ms: number } | { error: string; planError: boolean };
  try {
    const start = Date.now();
    plan = computePlan(file, new Date(nowIso), choices);
    let tiles: StatTile[] = [];
    try {
      tiles = statTiles(plan.results, { unitSystem: plan.unitSystem, unitOverrides: choices, sex: plan.inputs.sex });
    } catch {
      // tiles stay empty
    }
    const sections = planSections(plan.results.suggestions);
    const usProducts = usProductSections(sections, plan.results, isUS === true, 'ios') ?? undefined;
    view = { sections, tiles, usProducts, ms: Date.now() - start };
  } catch (error) {
    view = { error: String(error), planError: error instanceof PlanError };
  }
  // The letters and scan results at My health's foot ride on myData (US-73 AC12, documents.ts).
  const data = { ...myData(file, nowIso, choices, plan), documents: documentShelf(file) };
  if ('sections' in view) {
    try {
      view.topics = topicSections(view.usProducts ?? view.sections, data);
    } catch {
      // no topics: the app draws the sections
    }
  }
  const moved = movedRecord(recordJson, nowIso, deviceId);
  return JSON.stringify({ myData: data, plan: view, ...(moved ? { movedRecord: moved } : null) });
}

/** One edit, as JSON: `{ ok: true, record }` with the new record as text (and the
 *  outcome's other fields, such as a Health Records batch's counts), or the refusal. */
export function applyEditJson(recordJson: string, editJson: string, nowIso: string, deviceId: string, unitsJson?: string): string {
  checkArgs('applyEditJson', arguments);
  const read = parseEdit(editJson);
  if (!read.ok) return JSON.stringify(read);
  const outcome = applyEdit(readRecord(recordJson, nowIso, deviceId), read.edit, nowIso, readUnitChoices(unitsJson));
  if (!outcome.ok) return JSON.stringify(outcome);
  const { file, ok, ...extra } = outcome;
  return JSON.stringify({ ok, record: JSON.stringify(file), ...extra });
}

/** What the chat's proposed edits would do (US-67 AC3), as JSON: `{ medications: { lines, undo } | null,
 *  review: { lines, refusal, seen } | null }`, in the phone's units; `seen` goes back on the review's
 *  chatEdits edit, so a Save refuses when the record changed since. `editsJson`: the reply's `proposedEdits` as
 *  received; `today`: the phone's day. The record is read raw, as the chatEdits edit writes it. */
export function chatEditsJson(recordJson: string, editsJson: string, nowIso: string, deviceId: string, today: string, unitsJson?: string): string {
  checkArgs('chatEditsJson', arguments);
  return JSON.stringify(chatEditsPreview(readRecord(recordJson, nowIso, deviceId), JSON.parse(editsJson), nowIso, today, readUnitChoices(unitsJson)));
}

/** A typed number as JSON: the number, or null when it is not a plain decimal. */
export function numberJson(text: string): string {
  checkArgs('numberJson', arguments);
  return JSON.stringify(readNumber(text) ?? null);
}

/** A typed value in the other units, as JSON, by health-core's own factors (units.ts):
 *  `value` unrounded, for an edit; `text` as the record would show it; `feetInches` for
 *  a height. Onboarding's unit switches are for entry only (US-54 AC6). */
export function convertJson(metric: string, value: number, from: string, to: string): string {
  checkArgs('convertJson', arguments);
  const systems = ['si', 'conventional'];
  if (!Object.prototype.hasOwnProperty.call(UNIT_DEFS, metric) || !systems.includes(from) || !systems.includes(to) || !Number.isFinite(value)) {
    throw new Error('convertJson: unknown metric, units or value');
  }
  const canonical = toCanonicalValue(metric as MetricType, value, from as UnitSystem);
  return JSON.stringify({
    value: fromCanonicalValue(metric as MetricType, canonical, to as UnitSystem),
    text: formatDisplayValue(metric as MetricType, canonical, to as UnitSystem),
    feetInches: metric === 'height' ? cmToFeetInches(canonical) : null,
  });
}

/** The values to write to Apple Health, as JSON (US-25 AC14, device-export.ts): the values
 *  a person entered, never the app's own imports. */
export function healthWritesJson(recordJson: string, nowIso: string, deviceId: string): string {
  checkArgs('healthWritesJson', arguments);
  // The raw record: a correction's chain and source run through hidden rows too, and
  // deviceWrites takes only active rows of known metrics with a valid number (US-65).
  return JSON.stringify(deviceWrites(readRecord(recordJson, nowIso, deviceId), 'apple_health'));
}

/** Every value recorded for one metric, newest first, as JSON (US-25 AC9). `series` "lab": `metric`
 *  is a lab test's series key (US-25 AC25); an app before it sends none, and is answered as before.
 *  "egfr" and "whtr": the worked-out series of that name, `metric` unread (US-73 AC7). */
export function historyJson(recordJson: string, metric: string, nowIso: string, deviceId: string, unitsJson?: string, series?: string): string {
  checkArgs('historyJson', arguments);
  const file = readView(recordJson, nowIso, deviceId);
  if (series === 'egfr' || series === 'whtr') return JSON.stringify(derivedHistory(file, series, nowIso));
  return JSON.stringify(series === 'lab' ? labHistory(file, metric) : metricHistory(file, metric, nowIso, readUnitChoices(unitsJson)));
}

/** The core and catalogue blood tests a typed name finds, best first, as JSON (health-core labSearch,
 *  US-73 AC8): the add sheet's matches. An optional door (bridge-optional.json): not in the hashed
 *  contract, so an app reaches it only through HealthEngine.optionalCall. */
export function labSearchJson(text: string): string {
  checkArgs('labSearchJson', arguments);
  return JSON.stringify(labSearch(text));
}

/** The upload's verdicts for one pick on the phone, as JSON (health-core upload-rules, US-52 AC7):
 *  `request` {files: [{name, bytes}], zipMembers: [path]} answers {limits, files: [verdict],
 *  zipMembers: [verdict]}, in order, each "keep", "tooLarge", "unsupported" or "hidden". An optional
 *  door: an app reaches it only through HealthEngine.optionalCall and keeps its Swift rules without it. */
export function uploadVerdictsJson(request: string): string {
  checkArgs('uploadVerdictsJson', arguments);
  const { files = [], zipMembers = [] } = JSON.parse(request) as { files?: Array<{ name: string; bytes: number }>; zipMembers?: string[] };
  return JSON.stringify({
    limits: UPLOAD_LIMITS.phone,
    files: files.map(({ name, bytes }) => fileVerdict({ name, bytes, platform: 'phone' })),
    zipMembers: zipMembers.map((path) => zipMemberVerdict(path, 'phone')),
  });
}

// The shared upload (upload-doors.ts, design PR 12, US-52 AC8c): optional doors, each answering
// its JSON or {ok: false, reason, message}, never a throw on malformed JSON. The state is opaque.

/** A new upload's state for `platform` ("web" or "phone"). */
export function uploadStartJson(platform: string): string {
  checkArgs('uploadStartJson', arguments);
  return uploadStart(platform);
}

/**
 * One event: `{state, effects}`. The contract the app's upload runner is written against: Swift
 * sends only what it saw; the door fills in what only the engine knows (health-core upload-schema.ts
 * UPLOAD_EVENTS is the full shape). Times are ISO strings; `run` is the effect's run being answered.
 * - picked {files: [{id, name, bytes, kind: "file" | "zip"}], needsConsent, now}
 * - consented {} · stop {} · saveStarted {} · close {} · discard {} · retry {id (a file id or "all")}
 * - listed {run, zip (the ZIP's file id), members: [{id, name, bytes}]} · zipFailed {run, zip}
 * - hashed {run, id, hash}: the door adds `known` (knownIndex and knownAs over the record).
 * - hashFailed {run, id} · converted {run, id, pages, truncated} · convertFailed {run, id, reason: "unreadable" | "timeout"}
 * - streamEnded {run, id, line, now}: the streaming lab route (lab-read) ended. `line`: its last
 *   NDJSON line exactly as received, text; null when the stream ended without one. The door reads
 *   it (health-core labStreamAnswer): `{status: 200, body: {success: true, data}}` with data a
 *   checked read becomes `answered` (legacy added); any other status or body becomes `sendFailed`
 *   with the shared code (a 429 daily limit stops the run); no line or an unreadable one is the
 *   network failure, which Try again mends. The app never decides read or failed itself.
 * - sendFailed {run, id, status (HTTP status, null when no answer came), body (its text, null when
 *   none), contentType (its header, null when none)}: a real HTTP refusal before any stream (the
 *   gate's 401, 413, 429, 503) or a thrown request; the door adds `failure` (uploadFailureOfText).
 * - answered {run, id, extraction (a read, as received), now}: for a route that answers the read
 *   whole; the door checks it (health-core UPLOAD_EXTRACTION) and adds `legacy` (readIsLegacy).
 * - chose {id, change, now}: change is one of {tick, on}, {testDay}, {previousDay}, {replace,
 *   correctsId}, {edit, value}, {document: {title?, kind?, date?}} (health-core ChoiceChange).
 * - saved {run, attempt, outcome: {values, documents, archived}} · saveFailed {run, attempt, message}
 * Every event is strict: a key it does not name (`known`, `legacy` or `failure` from the app, a
 * change naming two kinds) is refused ("invalid-event"), and the parsed event is what runs.
 * `recordJson` ("" for none) is read only for hashed, answered and streamEnded, through `deviceId`,
 * the app's own, as the screen doors read it.
 * Steps are strictly serial: one call at a time, each given the state the previous one returned.
 * Two steps from one state, or a step given an older state, lose an event (a landing, a run
 * number, a choice): its effects may already be running, and their answers then match no file or
 * a stale run and are dropped, so a file can wait forever or a send can run twice.
 */
export function uploadStepJson(stateJson: string, eventJson: string, recordJson: string, deviceId: string): string {
  checkArgs('uploadStepJson', arguments);
  return uploadStep(stateJson, eventJson, recordJson, deviceId);
}

/**
 * The drawable view (health-core uploadView), from one review of the state against the record.
 * Cost: about 20 ms in Node and 50 ms jitless for 200 read ten-value reports, so likely 100 to 200
 * ms on a phone's JavaScriptCore; a step is about a fifth of that. Call it at most once per frame,
 * after the latest step of a burst (coalesce, never one view per event), and off the main thread.
 */
export function uploadViewJson(stateJson: string, recordJson: string, nowIso: string, cloudConnected: boolean, deviceId: string): string {
  checkArgs('uploadViewJson', arguments);
  return uploadViewOf(stateJson, recordJson, nowIso, cloudConnected, deviceId);
}

/** What Save writes (health-core uploadSavePlan), from the same review rule as the view. */
export function uploadSavePlanJson(stateJson: string, recordJson: string, nowIso: string, cloudConnected: boolean, deviceId: string): string {
  checkArgs('uploadSavePlanJson', arguments);
  return uploadPlanOf(stateJson, recordJson, nowIso, cloudConnected, deviceId);
}

/** The run's usage counts for `upload_outcome` (health-core uploadUsageCounts): counts only. */
export function uploadUsageJson(stateJson: string): string {
  checkArgs('uploadUsageJson', arguments);
  return uploadUsage(stateJson);
}

/**
 * The shared upload's Save (upload-save-door.ts, health-core uploadSave): the pick's values and its
 * document and lab archive rows in one step, for a state in its `saving` phase. With a cloud open
 * (`erase`, as documentSave takes it) through the session, and the engine writes each original the
 * plan stores, reading its bytes with `readOriginal(fileId)` (an ArrayBuffer, or null) for the
 * files `originalsJson` ({fileId: mimeType}) names; with none (`erase` '') onto `recordJson`.
 * Answers `{ok, record, erase?, outcome: {values, documents, archived, unstored}}`; Swift then
 * sends `saved {run, attempt, outcome}`. Or `{ok: false, reason, message}`, then `saveFailed`.
 */
export async function uploadSaveJson(stateJson: string, recordJson: string, erase: string, nowIso: string, deviceId: string, originalsJson: string, readOriginal: OriginalReader): Promise<string> {
  checkArgs('uploadSaveJson', arguments);
  return uploadSaveRun(stateJson, recordJson, erase, nowIso, deviceId, originalsJson, readOriginal);
}

/** The network came back (the app's NWPathMonitor, US-09 AC30): retry a failed save, at most once a
 *  minute and, on this trigger, never after a refused sign-in (LiveRefresh), then catch up. The
 *  catch-up's re-read still retries a failed save first, a refused sign-in's included (lead A25).
 *  Optional, like labSearchJson: an app before it never calls it. Answers '{}', nothing to read. */
export function cloudOnline(): string {
  checkArgs('cloudOnline', arguments);
  open?.live.online();
  return '{}';
}

/** Is an erase made here still unsent over a failure that may pass (S50b, US-25 AC16i)? Swift asks
 *  before Disconnect or a switch, and holds only on 'transient' (cloud.ts eraseHeld). Optional,
 *  like cloudOnline: an app before it never calls it. */
export async function cloudEraseHeld(): Promise<string> {
  checkArgs('cloudEraseHeld', arguments);
  return eraseHeld();
}

/** A listed document's original from the person's cloud, as bytes (US-73 AC12; the web's "View
 *  original file", US-14): the document page's door, optional like labSearchJson. By the document's
 *  id, so only a file the record names is read. Rejects with the failure JSON Swift reads (review R6
 *  of PR 972): kind "not-open" when no cloud is open, "no-original" when the record names none for
 *  it, else the cloud's own failure, classed as a save's is (`failed`: sign-in, unreachable...). */
export async function documentOriginal(id: string): Promise<ArrayBuffer> {
  checkArgs('documentOriginal', arguments);
  const at = open;
  if (!at) throw new Error(JSON.stringify({ kind: 'not-open', detail: NOT_OPEN }));
  const doc = at.session.file.documents.find((d) => d.id === id && !d.deleted);
  if (!doc?.fileRef) throw new Error(JSON.stringify({ kind: 'no-original', detail: 'This document has no original in your cloud.' }));
  try {
    return await (await at.host.store.readDocument(doc.fileRef)).arrayBuffer();
  } catch (error) {
    if (originalGone(error)) throw new Error(JSON.stringify({ kind: 'no-original', detail: 'This document\'s original is not in your cloud.' }));
    throw new Error(failed(at.provider, error));
  }
}

/** The cloud no longer holds the original (PR 1051 review R1): any 404; Dropbox answers a download
 *  of a missing path 409 (path/not_found; dropbox-rest.ts `dropboxDownload` keeps the status, not
 *  the body, so every download 409 counts); Drive finds no file of that name (drive-rest.ts
 *  `driveDownloadDocument`, which sets no status but the reason not-found, #979). */
function originalGone(error: unknown): boolean {
  return error instanceof StorageError && (error.status === 404 || error.status === 409 || error.reason === 'not-found');
}
// Chat and lab upload (US-52): app-doors.ts.
export { chatContextJson, chatListJson, chatMessagesJson, chatRecordExchangeJson, chatDeleteJson, settledJson, labReviewJson, labSaveSummaryJson } from './app-doors';

/** The import review's groups and words for the ticks and test day the screen holds now (US-13
 *  AC13, US-52 AC8; lab-review-groups.ts), against the record read raw, as the save writes it.
 *  Optional, like labSearchJson: an app reaches it only through HealthEngine.optionalCall. */
export function labReviewGroupsJson(recordJson: string, extractionJson: string, refsJson: string, reportDay: string, nowIso: string, deviceId: string): string {
  checkArgs('labReviewGroupsJson', arguments);
  const file = recordJson ? readRecord(recordJson, nowIso, deviceId) : null;
  return JSON.stringify(labReviewGroups(JSON.parse(extractionJson) as Extraction, file, JSON.parse(refsJson) as string[], reportDay, nowIso));
}
/** The phone's reminders (reminders.ts): health-core's schedule plus the notification days, as JSON.
 *  `firstSeenJson` (US-17 AC15): the follow-up first-seen days the app keeps; anything that is not
 *  an object of calendar days counts as none kept. An app before it sends none, and is answered as before. */
export function remindersJson(recordJson: string, nowIso: string, deviceId: string, firstSeenJson?: string): string {
  checkArgs('remindersJson', arguments);
  return JSON.stringify(phoneReminders(readView(recordJson, nowIso, deviceId), new Date(nowIso), undefined,
    firstSeenJson === undefined ? undefined : readFirstSeen(firstSeenJson)));
}

function readFirstSeen(text: string): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([, day]) => typeof day === 'string' && isCalendarDay(day)));
}
