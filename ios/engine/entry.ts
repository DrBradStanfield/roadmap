// The engine the iOS app runs in JavaScriptCore (ios/architecture.md D2).
// The same health-core the web runs; this file only gives Swift a
// string-in, string-out door, because JSON is the one shape both sides share.
import { computePlan, type Plan } from '../../packages/health-core/src/plan';
import { planSections } from '../../packages/health-core/src/plan-sections';
import { applyEdit, myData, newRecord, readNumber, readRecord, type Edit } from './my-data';
import { metricHistory } from './my-data-forms';

/** The plan for a record, as JSON. `nowIso` is passed in so tests can pin it. */
export function planJson(recordJson: string, nowIso: string, deviceId: string): string {
  return JSON.stringify(computePlan(readRecord(recordJson, nowIso, deviceId), new Date(nowIso)));
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
export function myDataJson(recordJson: string, nowIso: string, deviceId: string): string {
  return JSON.stringify(myData(readRecord(recordJson, nowIso, deviceId), nowIso));
}

/** One edit, as JSON: `{ ok: true, record }` with the new record as text, or the refusal. */
export function applyEditJson(recordJson: string, editJson: string, nowIso: string, deviceId: string): string {
  const outcome = applyEdit(readRecord(recordJson, nowIso, deviceId), JSON.parse(editJson) as Edit, nowIso);
  return JSON.stringify(outcome.ok ? { ok: true, record: JSON.stringify(outcome.file) } : outcome);
}

/** A typed number as JSON: the number, or null when it is not a plain decimal. */
export function numberJson(text: string): string {
  return JSON.stringify(readNumber(text) ?? null);
}

/** Every value recorded for one metric, newest first, as JSON (US-25 AC9). */
export function historyJson(recordJson: string, metric: string, nowIso: string, deviceId: string): string {
  return JSON.stringify(metricHistory(readRecord(recordJson, nowIso, deviceId), metric));
}
