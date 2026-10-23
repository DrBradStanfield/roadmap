// The engine the iOS app runs in JavaScriptCore (ios/architecture.md D2).
// The same health-core the web runs; this file only gives Swift a
// string-in, string-out door, because JSON is the one shape both sides share.
// Its door list is bridge-contract.json; bridge.test.ts holds the two together.
import { mergeFiles } from '../../packages/health-core/src/merge';
import { computePlan, type Plan } from '../../packages/health-core/src/plan';
import { CURRENT_SCHEMA_VERSION } from '../../packages/health-core/src/roadmap-file';
import { planSections } from '../../packages/health-core/src/plan-sections';
import { statTiles } from '../../packages/health-core/src/stat-tiles';
import { cmToFeetInches, formatDisplayValue, fromCanonicalValue, toCanonicalValue, UNIT_DEFS, type MetricType, type UnitSystem } from '../../packages/health-core/src/units';
import { fileNameLine, MAX_FILE_NAME_LENGTH, zipMemberName } from '../../packages/health-core/src/lab-extraction';
import { deviceWrites } from '../../packages/health-core/src/device-export';
import { applyEdit, myData, newRecord, readNumber, readRecord, type Edit } from './my-data';
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

// Cloud sync (cloud.ts): cloudOpen, cloudRefresh, cloudFlush, cloudClose, cloudErase and
// documentSave answer a Promise; the rest answer at once.
export { cloudClose, cloudEdit, cloudErase, cloudLabImport, cloudFlush, cloudHidden, cloudOpen, cloudRefresh, cloudVisible, documentSave } from './cloud';
// Lab files from the Dropbox app folder (lab-files.ts), each async.
export { labFile, labFolderFilesJson, labFolderJson } from './lab-files';
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

/** The Plan tab's view of a record, as JSON, from one computePlan: `{sections, tiles}`,
 *  the layout sectionsJson gives and the summary tiles above it, the web's Quick Stats
 *  (health-core stat-tiles.ts, US-25 AC22), in the phone's per-test units. A tile that
 *  cannot be drawn never blanks the plan below it (adversary R7): no tiles instead. */
export function planViewJson(recordJson: string, nowIso: string, deviceId: string, unitsJson: string): string {
  const unitOverrides = readUnitChoices(unitsJson);
  const plan = computePlan(readRecord(recordJson, nowIso, deviceId), new Date(nowIso), unitOverrides);
  let tiles: ReturnType<typeof statTiles> = [];
  try {
    tiles = statTiles(plan.results, { unitSystem: plan.unitSystem, unitOverrides, sex: plan.inputs.sex });
  } catch {
    // tiles stay empty
  }
  return JSON.stringify({ sections: planSections(plan.results.suggestions), tiles });
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

/** A typed value in the other units, as JSON, by health-core's own factors (units.ts):
 *  `value` unrounded, for an edit; `text` as the record would show it; `feetInches` for
 *  a height. Onboarding's unit switches are for entry only (US-54 AC6). */
export function convertJson(metric: string, value: number, from: string, to: string): string {
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
  return JSON.stringify(deviceWrites(readRecord(recordJson, nowIso, deviceId), 'apple_health'));
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
