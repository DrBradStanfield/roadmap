// Per-test display units on the phone (US-25 AC17e), the web's per-field unit chips
// (HealthTool.tsx handleToggleFieldUnit): a device preference, never written to the record.
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { BLOOD_TEST_METRICS } from '../../packages/health-core/src/mappings';
import { hasUnitChoice, type MetricType, type UnitSystem } from '../../packages/health-core/src/units';

/** Per-test display units, the web's per-field toggles (US-25 AC17e). Like the web's, they are
 *  this device's preference, never written to the record, and the master switch clears them. */
export type UnitChoices = Partial<Record<MetricType, UnitSystem>>;

/** The tests the web gives a unit chip: weight, waist and the blood tests whose units differ
 *  (`hasUnitChoice`, so not PSA), but Lp(a), which has its own three-unit control (US-05 AC2). */
export const SWITCHABLE = new Set<string>(['weight', 'waist', ...BLOOD_TEST_METRICS]
  .filter((metric) => metric !== 'lpa' && hasUnitChoice(metric as MetricType)));

/** The choices the app sent, kept only where they are a switchable test and a real system:
 *  every reader takes them from here, so none checks again. */
export function readUnitChoices(json: string | undefined): UnitChoices {
  let raw: unknown;
  try {
    raw = JSON.parse(json || '{}');
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>)
    .filter(([metric, system]) => SWITCHABLE.has(metric) && (system === 'si' || system === 'conventional'))) as UnitChoices;
}

/** The units one metric shows and is typed in. */
export function systemFor(file: RoadmapFile, metric: string, choices: UnitChoices = {}): UnitSystem {
  return choices[metric as MetricType] ?? file.profile.unitSystem ?? 'si';
}
