// The engine the iOS app runs in JavaScriptCore (ios/architecture.md D2).
// The same health-core the web runs; this file only gives Swift a
// string-in, string-out door, because JSON is the one shape both sides share.
import { mergeFiles } from '../../packages/health-core/src/merge';
import { computePlan, type Plan } from '../../packages/health-core/src/plan';
import { CURRENT_SCHEMA_VERSION } from '../../packages/health-core/src/roadmap-file';
import { planSections } from '../../packages/health-core/src/plan-sections';
import { fileNameLine, MAX_FILE_NAME_LENGTH, zipMemberName } from '../../packages/health-core/src/lab-extraction';
import { applyEdit, healthWrites, myData, newRecord, readNumber, readRecord, type Edit } from './my-data';
import { metricHistory } from './my-data-forms';
import { readUnitChoices } from './unit-choices';
import { phoneReminders } from './reminders';
import { installShim, type Natives } from './shim';

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
  const ctx = { deviceId, now: nowIso };
  return JSON.stringify(mergeFiles(readRecord(localJson, nowIso, deviceId), readRecord(remoteJson, nowIso, deviceId), ctx));
}

// Cloud sync (cloud.ts): every call but cloudEdit is async and answers a Promise.
export { cloudClose, cloudEdit, cloudErase, cloudLabImport, cloudFlush, cloudHidden, cloudOpen, cloudRefresh, cloudVisible, documentSave, labFile, labFilesJson } from './cloud';
// "Delete all my data" on the phone's own file (erase.ts); a cloud's is cloudErase.
export { erasePhoneJson } from './erase';
/** The `sourceFileName` of each file read, as JSON (US-52 AC13d): the document
 *  dedup key, by health-core's own rules, one call per read. A ZIP member
 *  (`{ zip, path }`) by zipMemberName, the web's rule and cap; any other file
 *  (`{ name }`) on one line and cut to the cap, as the connector stores one. */
export function fileNamesJson(filesJson: string): string {
  const files = JSON.parse(filesJson) as Array<{ name: string } | { zip: string; path: string }>;
  return JSON.stringify(files.map((f) => ('zip' in f ? zipMemberName(f.zip, f.path) : fileNameLine(f.name).slice(0, MAX_FILE_NAME_LENGTH))));
}

/** The plan for a record, as JSON. `nowIso` is passed in so tests can pin it. `unitsJson`,
 *  here and on the doors below: the phone's per-test units (unit-choices.ts); an app older
 *  than them sends nothing, and every metric shows in the record's units. */
export function planJson(recordJson: string, nowIso: string, deviceId: string, unitsJson?: string): string {
  return JSON.stringify(computePlan(readRecord(recordJson, nowIso, deviceId), new Date(nowIso), readUnitChoices(unitsJson)));
}

/** A plan's on-screen layout, as JSON: the web's results panel uses the same function. */
export function sectionsJson(planJsonText: string): string {
  const plan = JSON.parse(planJsonText) as Plan;
  return JSON.stringify(planSections(plan.results.suggestions));
}

// The My data tab (my-data.ts). A record from disk is read as the plan's is,
// migrated, so a record the web wrote in an older shape reads the same.

/** A first-launch record, as JSON. */
export function newRecordJson(nowIso: string, deviceId: string, locale: string, timeZone: string): string {
  return JSON.stringify(newRecord(nowIso, deviceId, locale, timeZone));
}

/** What the My data tab shows, as JSON. */
export function myDataJson(recordJson: string, nowIso: string, deviceId: string, unitsJson?: string): string {
  return JSON.stringify(myData(readRecord(recordJson, nowIso, deviceId), nowIso, readUnitChoices(unitsJson)));
}

/** One edit, as JSON: `{ ok: true, record }` with the new record as text, or the refusal. */
export function applyEditJson(recordJson: string, editJson: string, nowIso: string, deviceId: string, unitsJson?: string): string {
  const outcome = applyEdit(readRecord(recordJson, nowIso, deviceId), JSON.parse(editJson) as Edit, nowIso, readUnitChoices(unitsJson));
  return JSON.stringify(outcome.ok ? { ok: true, record: JSON.stringify(outcome.file) } : outcome);
}

/** A typed number as JSON: the number, or null when it is not a plain decimal. */
export function numberJson(text: string): string {
  return JSON.stringify(readNumber(text) ?? null);
}

/** The values to write to Apple Health, as JSON (US-25 AC14, device-export.ts). */
export function healthWritesJson(recordJson: string, nowIso: string, deviceId: string): string {
  return JSON.stringify(healthWrites(readRecord(recordJson, nowIso, deviceId)));
}

/** Every value recorded for one metric, newest first, as JSON (US-25 AC9). */
export function historyJson(recordJson: string, metric: string, nowIso: string, deviceId: string, unitsJson?: string): string {
  return JSON.stringify(metricHistory(readRecord(recordJson, nowIso, deviceId), metric, nowIso, readUnitChoices(unitsJson)));
}
// Chat and lab upload (US-52): app-doors.ts.
export { chatContextJson, chatListJson, chatMessagesJson, chatRecordExchangeJson, chatDeleteJson, settledJson, labReviewJson, labSaveSummaryJson } from './app-doors';
/** The phone's reminders (reminders.ts): health-core's schedule plus the notification days, as JSON. */
export function remindersJson(recordJson: string, nowIso: string, deviceId: string): string {
  return JSON.stringify(phoneReminders(readRecord(recordJson, nowIso, deviceId), new Date(nowIso)));
}
