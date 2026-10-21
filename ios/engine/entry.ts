// The engine the iOS app runs in JavaScriptCore (ios/architecture.md D2).
// The same health-core the web runs; this file only gives Swift a
// string-in, string-out door, because JSON is the one shape both sides share.
import { migrateFile } from '../../packages/health-core/src/migrate';
import { computePlan, type Plan } from '../../packages/health-core/src/plan';
import { planSections } from '../../packages/health-core/src/plan-sections';

/** The plan for a record, as JSON. `nowIso` is passed in so tests can pin it. */
export function planJson(recordJson: string, nowIso: string, deviceId: string): string {
  const file = migrateFile(JSON.parse(recordJson), { deviceId, now: nowIso });
  return JSON.stringify(computePlan(file, new Date(nowIso)));
}

/** A plan's on-screen layout, as JSON: the web's results panel uses the same function. */
export function sectionsJson(planJsonText: string): string {
  const plan = JSON.parse(planJsonText) as Plan;
  return JSON.stringify(planSections(plan.results.suggestions));
}
